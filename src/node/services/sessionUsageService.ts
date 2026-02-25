import * as fs from "fs/promises";
import * as path from "path";
import writeFileAtomic from "write-file-atomic";
import assert from "@/common/utils/assert";
import type { Config } from "@/node/config";
import type { HistoryService } from "./historyService";
import { workspaceFileLocks } from "@/node/utils/concurrency/workspaceFileLocks";
import type { ChatUsageDisplay } from "@/common/utils/tokens/usageAggregator";
import { sumUsageHistory } from "@/common/utils/tokens/usageAggregator";
import { createDisplayUsage } from "@/common/utils/tokens/displayUsage";
import type { RolledUpChildEntry } from "@/common/orpc/schemas/chatStats";
import type { TokenConsumer } from "@/common/types/chatStats";
import type { MuxMessage } from "@/common/types/message";
import { normalizeGatewayModel } from "@/common/utils/ai/models";
import { log } from "./log";

export interface SessionUsageTokenStatsCacheV1 {
  /**
   * Schema version for this cache block.
   * (Kept separate so we don't have to bump session-usage.json version for derived fields.)
   */
  version: 1;

  computedAt: number;

  /**
   * Stable fingerprint of provider config used when this cache was computed.
   * Optional for backward compatibility with pre-fingerprint cache entries.
   */
  providersConfigVersion?: number;

  /** Tokenization model (impacts tokenizer + tool definition counting) */
  model: string;

  /** e.g. "o200k_base", "claude" */
  tokenizerName: string;

  /** Cheap fingerprint to validate cache freshness against current message history */
  history: {
    messageCount: number;
    maxHistorySequence?: number;
  };

  consumers: TokenConsumer[];
  totalTokens: number;
  topFilePaths?: Array<{ path: string; tokens: number }>;
}

export interface SessionUsageFile {
  byModel: Record<string, ChatUsageDisplay>;
  lastRequest?: {
    model: string;
    usage: ChatUsageDisplay;
    timestamp: number;
  };

  /**
   * Idempotency ledger for rolled-up sub-agent usage.
   *
   * When a child workspace is deleted, we merge its byModel usage into the parent.
   * This tracks which children have already been merged to prevent double-counting
   * if removal is retried.
   *
   * Legacy entries use `true`; newer entries include per-child totals and metadata.
   */
  rolledUpFrom?: Record<string, true | RolledUpChildEntry>;

  /** Cached token statistics (consumer/file breakdown) for Costs tab */
  tokenStatsCache?: SessionUsageTokenStatsCacheV1;

  version: 1;
}

/**
 * Service for managing cumulative session usage tracking.
 *
 * Replaces O(n) message iteration with a persistent JSON file that stores
 * per-model usage breakdowns. Usage is accumulated on stream-end, never
 * subtracted, making costs immune to message deletion.
 */
export class SessionUsageService {
  private readonly SESSION_USAGE_FILE = "session-usage.json";
  private readonly fileLocks = workspaceFileLocks;
  private readonly config: Config;
  private readonly historyService: HistoryService;

  constructor(config: Config, historyService: HistoryService) {
    this.config = config;
    this.historyService = historyService;
  }
  /**
   * Collect all messages from iterateFullHistory into an array.
   * Usage rebuild needs every epoch for accurate totals.
   */
  private async collectFullHistory(workspaceId: string): Promise<MuxMessage[]> {
    const messages: MuxMessage[] = [];
    const result = await this.historyService.iterateFullHistory(workspaceId, "forward", (chunk) => {
      messages.push(...chunk);
    });
    if (!result.success) {
      log.warn(`Failed to iterate history for ${workspaceId}: ${result.error}`);
      return [];
    }
    return messages;
  }

  private getFilePath(workspaceId: string): string {
    return path.join(this.config.getSessionDir(workspaceId), this.SESSION_USAGE_FILE);
  }

  private async readFile(workspaceId: string): Promise<SessionUsageFile> {
    try {
      const data = await fs.readFile(this.getFilePath(workspaceId), "utf-8");
      return JSON.parse(data) as SessionUsageFile;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return { byModel: {}, version: 1 };
      }
      throw error;
    }
  }

  private async writeFile(workspaceId: string, data: SessionUsageFile): Promise<void> {
    const filePath = this.getFilePath(workspaceId);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await writeFileAtomic(filePath, JSON.stringify(data, null, 2));
  }

  /**
   * Record usage from a completed stream. Accumulates with existing usage
   * AND updates lastRequest in a single atomic write.
   * Model should already be normalized via normalizeGatewayModel().
   */
  async recordUsage(workspaceId: string, model: string, usage: ChatUsageDisplay): Promise<void> {
    return this.fileLocks.withLock(workspaceId, async () => {
      const current = await this.readFile(workspaceId);
      const existing = current.byModel[model];
      // CRITICAL: Accumulate, don't overwrite
      current.byModel[model] = existing ? sumUsageHistory([existing, usage])! : usage;
      current.lastRequest = { model, usage, timestamp: Date.now() };
      await this.writeFile(workspaceId, current);
    });
  }

  /**
   * Persist derived token stats (consumer + file breakdown) as a cache.
   *
   * This is intentionally treated as a replaceable cache: if the cache is stale,
   * the next tokenizer.calculateStats call will overwrite it.
   */
  async setTokenStatsCache(
    workspaceId: string,
    cache: SessionUsageTokenStatsCacheV1
  ): Promise<void> {
    assert(workspaceId.trim().length > 0, "setTokenStatsCache: workspaceId empty");
    assert(cache.version === 1, "setTokenStatsCache: cache.version must be 1");
    assert(cache.totalTokens >= 0, "setTokenStatsCache: totalTokens must be >= 0");
    assert(
      cache.history.messageCount >= 0,
      "setTokenStatsCache: history.messageCount must be >= 0"
    );
    for (const consumer of cache.consumers) {
      assert(
        typeof consumer.tokens === "number" && consumer.tokens >= 0,
        `setTokenStatsCache: consumer tokens must be >= 0 (${consumer.name})`
      );
    }

    return this.fileLocks.withLock(workspaceId, async () => {
      // Defensive: don't create new session dirs for already-deleted workspaces.
      if (!this.config.findWorkspace(workspaceId)) {
        return;
      }

      let current: SessionUsageFile;
      try {
        current = await this.readFile(workspaceId);
      } catch {
        // Parse errors or other read failures - best-effort rebuild.
        log.warn(
          `session-usage.json unreadable for ${workspaceId}, rebuilding before token stats cache update`
        );
        const messages = await this.collectFullHistory(workspaceId);
        if (messages.length > 0) {
          await this.rebuildFromMessagesInternal(workspaceId, messages);
          current = await this.readFile(workspaceId);
        } else {
          current = { byModel: {}, version: 1 };
        }
      }

      current.tokenStatsCache = cache;
      await this.writeFile(workspaceId, current);
    });
  }

  /**
   * Merge child usage into the parent workspace.
   *
   * Used to preserve sub-agent costs when the child workspace is deleted.
   *
   * IMPORTANT:
   * - Does not update parent's lastRequest
   * - Uses an on-disk idempotency ledger (rolledUpFrom) to prevent double-counting
   */
  async rollUpUsageIntoParent(
    parentWorkspaceId: string,
    childWorkspaceId: string,
    childUsageByModel: Record<string, ChatUsageDisplay>,
    childMeta?: { agentType?: string; model?: string }
  ): Promise<{ didRollUp: boolean }> {
    assert(parentWorkspaceId.trim().length > 0, "rollUpUsageIntoParent: parentWorkspaceId empty");
    assert(childWorkspaceId.trim().length > 0, "rollUpUsageIntoParent: childWorkspaceId empty");
    assert(
      parentWorkspaceId !== childWorkspaceId,
      "rollUpUsageIntoParent: parentWorkspaceId must differ from childWorkspaceId"
    );

    // Defensive: don't create new session dirs for already-deleted parents.
    if (!this.config.findWorkspace(parentWorkspaceId)) {
      return { didRollUp: false };
    }

    const entries = Object.entries(childUsageByModel);
    if (entries.length === 0) {
      return { didRollUp: false };
    }

    return this.fileLocks.withLock(parentWorkspaceId, async () => {
      let current: SessionUsageFile;
      try {
        current = await this.readFile(parentWorkspaceId);
      } catch {
        // Parse errors or other read failures - best-effort rebuild.
        log.warn(
          `session-usage.json unreadable for ${parentWorkspaceId}, rebuilding before roll-up`
        );
        const messages = await this.collectFullHistory(parentWorkspaceId);
        if (messages.length > 0) {
          await this.rebuildFromMessagesInternal(parentWorkspaceId, messages);
          current = await this.readFile(parentWorkspaceId);
        } else {
          current = { byModel: {}, version: 1 };
        }
      }

      if (current.rolledUpFrom?.[childWorkspaceId]) {
        return { didRollUp: false };
      }

      for (const [model, usage] of entries) {
        const existing = current.byModel[model];
        current.byModel[model] = existing ? sumUsageHistory([existing, usage])! : usage;
      }

      let totalTokens = 0;
      let contextTokens = 0;
      let totalCostUsd = 0;
      let hasCosts = false;
      for (const [, usage] of entries) {
        totalTokens +=
          usage.input.tokens +
          usage.output.tokens +
          usage.reasoning.tokens +
          usage.cached.tokens +
          usage.cacheCreate.tokens;
        contextTokens += usage.input.tokens + usage.cached.tokens + usage.cacheCreate.tokens;

        for (const bucket of [
          usage.input,
          usage.output,
          usage.reasoning,
          usage.cached,
          usage.cacheCreate,
        ]) {
          if (bucket.cost_usd != null) {
            totalCostUsd += bucket.cost_usd;
            hasCosts = true;
          }
        }
      }

      assert(totalTokens >= 0, "rollUpUsageIntoParent: totalTokens must be >= 0");
      assert(contextTokens >= 0, "rollUpUsageIntoParent: contextTokens must be >= 0");
      assert(!hasCosts || totalCostUsd >= 0, "rollUpUsageIntoParent: totalCostUsd must be >= 0");

      current.rolledUpFrom = {
        ...(current.rolledUpFrom ?? {}),
        [childWorkspaceId]: {
          totalTokens,
          contextTokens,
          totalCostUsd: hasCosts ? totalCostUsd : undefined,
          agentType: childMeta?.agentType,
          model: childMeta?.model,
          rolledUpAtMs: Date.now(),
        },
      };
      await this.writeFile(parentWorkspaceId, current);

      return { didRollUp: true };
    });
  }

  /**
   * Read current session usage. Returns undefined if file missing/corrupted
   * and no messages to rebuild from.
   */
  async getSessionUsage(workspaceId: string): Promise<SessionUsageFile | undefined> {
    return this.fileLocks.withLock(workspaceId, async () => {
      try {
        const filePath = this.getFilePath(workspaceId);
        const data = await fs.readFile(filePath, "utf-8");
        return JSON.parse(data) as SessionUsageFile;
      } catch (error) {
        // File missing or corrupted - try to rebuild from messages
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
          const messages = await this.collectFullHistory(workspaceId);
          if (messages.length > 0) {
            await this.rebuildFromMessagesInternal(workspaceId, messages);
            return this.readFile(workspaceId);
          }
          return undefined; // Truly empty session
        }
        // Parse error - try rebuild
        log.warn(`session-usage.json corrupted for ${workspaceId}, rebuilding`);
        const messages = await this.collectFullHistory(workspaceId);
        if (messages.length > 0) {
          await this.rebuildFromMessagesInternal(workspaceId, messages);
          return this.readFile(workspaceId);
        }
        return undefined;
      }
    });
  }

  /**
   * Batch fetch session usage for multiple workspaces.
   * Optimized for displaying costs in archived workspaces list.
   */
  async getSessionUsageBatch(
    workspaceIds: string[]
  ): Promise<Record<string, SessionUsageFile | undefined>> {
    const results: Record<string, SessionUsageFile | undefined> = {};
    // Read files in parallel without rebuilding from messages (archived workspaces
    // should already have session-usage.json; skip rebuild to keep batch fast)
    await Promise.all(
      workspaceIds.map(async (workspaceId) => {
        try {
          const filePath = this.getFilePath(workspaceId);
          const data = await fs.readFile(filePath, "utf-8");
          results[workspaceId] = JSON.parse(data) as SessionUsageFile;
        } catch {
          results[workspaceId] = undefined;
        }
      })
    );
    return results;
  }

  /**
   * Rebuild session usage from messages (for migration/recovery).
   * Internal version - called within lock.
   */
  private async rebuildFromMessagesInternal(
    workspaceId: string,
    messages: MuxMessage[]
  ): Promise<void> {
    const result: SessionUsageFile = { byModel: {}, version: 1 };
    let lastAssistantUsage: { model: string; usage: ChatUsageDisplay } | undefined;

    for (const msg of messages) {
      if (msg.role === "assistant") {
        // Include historicalUsage from legacy compaction summaries.
        // This field was removed from MuxMetadata but may exist in persisted data.
        // It's a ChatUsageDisplay representing all pre-compaction costs (model-agnostic).
        const historicalUsage = (msg.metadata as { historicalUsage?: ChatUsageDisplay })
          ?.historicalUsage;
        if (historicalUsage) {
          const existing = result.byModel.historical;
          result.byModel.historical = existing
            ? sumUsageHistory([existing, historicalUsage])!
            : historicalUsage;
        }

        // Extract current message's usage
        if (msg.metadata?.usage) {
          const rawModel = msg.metadata.model ?? "unknown";
          const model = normalizeGatewayModel(rawModel);
          const usage = createDisplayUsage(
            msg.metadata.usage,
            rawModel,
            msg.metadata.providerMetadata
          );

          if (usage) {
            const existing = result.byModel[model];
            result.byModel[model] = existing ? sumUsageHistory([existing, usage])! : usage;
            lastAssistantUsage = { model, usage };
          }
        }
      }
    }

    if (lastAssistantUsage) {
      result.lastRequest = {
        model: lastAssistantUsage.model,
        usage: lastAssistantUsage.usage,
        timestamp: Date.now(),
      };
    }

    await this.writeFile(workspaceId, result);
    log.info(`Rebuilt session-usage.json for ${workspaceId} from ${messages.length} messages`);
  }

  /**
   * Public rebuild method (acquires lock).
   */
  async rebuildFromMessages(workspaceId: string, messages: MuxMessage[]): Promise<void> {
    return this.fileLocks.withLock(workspaceId, async () => {
      await this.rebuildFromMessagesInternal(workspaceId, messages);
    });
  }

  /**
   * Delete session usage file (when workspace is deleted).
   */
  async deleteSessionUsage(workspaceId: string): Promise<void> {
    return this.fileLocks.withLock(workspaceId, async () => {
      try {
        await fs.unlink(this.getFilePath(workspaceId));
      } catch (error) {
        if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
          throw error;
        }
      }
    });
  }
}
