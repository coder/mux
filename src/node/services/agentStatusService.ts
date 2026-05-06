import { createHash } from "crypto";
import assert from "@/common/utils/assert";
import {
  AGENT_STATUS_FOCUSED_INTERVAL_MS,
  AGENT_STATUS_MAX_CONCURRENT,
  AGENT_STATUS_MAX_MESSAGE_CHARS,
  AGENT_STATUS_MAX_TRAILING_MESSAGES,
  AGENT_STATUS_MAX_TRANSCRIPT_TOKENS,
  AGENT_STATUS_STARTUP_DELAY_MS,
  AGENT_STATUS_TICK_INTERVAL_MS,
  AGENT_STATUS_UNFOCUSED_INTERVAL_MS,
} from "@/constants/agentStatus";
import type { Config } from "@/node/config";
import type { MuxMessage } from "@/common/types/message";
import { isWorkspaceArchived } from "@/common/utils/archive";
import type { AIService } from "./aiService";
import type { ExtensionMetadataService } from "./ExtensionMetadataService";
import type { HistoryService } from "./historyService";
import type { TokenizerService } from "./tokenizerService";
import type { WindowService } from "./windowService";
import type { WorkspaceService } from "./workspaceService";
import { generateWorkspaceStatus } from "./workspaceStatusGenerator";
import { log } from "./log";

/**
 * Public-test surface for AgentStatusService. Real callers use the no-arg
 * constructor; tests pass a `clock` to drive deterministic time and can
 * skip the startup delay by passing `startupDelayMs: 0`.
 */
export interface AgentStatusServiceOptions {
  /** Override for test injection. Defaults to `Date.now`. */
  clock?: () => number;
  /** Override startup delay (ms). Defaults to {@link AGENT_STATUS_STARTUP_DELAY_MS}. */
  startupDelayMs?: number;
  /** Override scheduler tick interval (ms). Defaults to {@link AGENT_STATUS_TICK_INTERVAL_MS}. */
  tickIntervalMs?: number;
}

interface WorkspaceTrackingState {
  /** Last time we successfully ran (or skipped due to dedup). 0 on first ever tick. */
  lastRanAt: number;
  /** Hash of the most recent input we generated against. null if we never ran. */
  lastInputHash: string | null;
  /** Whether a generation is currently in flight for this workspace. */
  inFlight: boolean;
}

/**
 * Periodic backend job that produces the sidebar's AI-generated agent
 * status using the same "small model" path as workspace titles.
 *
 * Cadence:
 * - The scheduler ticks every {@link AGENT_STATUS_TICK_INTERVAL_MS}.
 * - Each workspace has its own per-tick eligibility window: focused windows
 *   regenerate at most every {@link AGENT_STATUS_FOCUSED_INTERVAL_MS}, blurred
 *   windows back off to {@link AGENT_STATUS_UNFOCUSED_INTERVAL_MS}.
 *
 * Dedup:
 * - Each generation hashes its trailing-transcript window. We persist the
 *   hash on disk via ExtensionMetadataService so a workspace whose chat is
 *   idle/frozen produces no further generations (input is unchanged).
 *
 * Concurrency:
 * - Bounded by {@link AGENT_STATUS_MAX_CONCURRENT} so a sweep across many
 *   workspaces never spikes provider load.
 */
export class AgentStatusService {
  private readonly config: Config;
  private readonly historyService: HistoryService;
  private readonly tokenizerService: TokenizerService;
  private readonly extensionMetadata: ExtensionMetadataService;
  private readonly workspaceService: WorkspaceService;
  private readonly windowService: WindowService;
  private readonly aiService: AIService;

  private readonly clock: () => number;
  private readonly startupDelayMs: number;
  private readonly tickIntervalMs: number;

  private readonly tracked = new Map<string, WorkspaceTrackingState>();
  private inFlightCount = 0;
  // Track in-flight per-workspace promises so a tick can be awaited cleanly
  // in tests (and so shutdown can drain them if we ever need to).
  private readonly inFlightPromises = new Set<Promise<void>>();

  private startupTimeout: ReturnType<typeof setTimeout> | null = null;
  private checkInterval: ReturnType<typeof setInterval> | null = null;
  // Default to "running so the service is usable as soon as it's
  // constructed (tests drive runTick() directly). stop() flips this true to
  // gate any in-flight or scheduled work.
  private stopped = false;
  private tickInFlight = false;
  private hashesHydrated = false;

  constructor(
    config: Config,
    historyService: HistoryService,
    tokenizerService: TokenizerService,
    extensionMetadata: ExtensionMetadataService,
    workspaceService: WorkspaceService,
    windowService: WindowService,
    aiService: AIService,
    options: AgentStatusServiceOptions = {}
  ) {
    this.config = config;
    this.historyService = historyService;
    this.tokenizerService = tokenizerService;
    this.extensionMetadata = extensionMetadata;
    this.workspaceService = workspaceService;
    this.windowService = windowService;
    this.aiService = aiService;

    this.clock = options.clock ?? (() => Date.now());
    this.startupDelayMs = options.startupDelayMs ?? AGENT_STATUS_STARTUP_DELAY_MS;
    this.tickIntervalMs = options.tickIntervalMs ?? AGENT_STATUS_TICK_INTERVAL_MS;
  }

  start(): void {
    // Idempotent re-entry guard: callers in production wire start() once at
    // initialize() time, but a defensive assert keeps double-start mistakes
    // visible during development.
    assert(
      this.checkInterval === null && this.startupTimeout === null,
      "AgentStatusService.start() called while already running"
    );
    this.stopped = false;

    const scheduleTicks = () => {
      if (this.stopped) {
        return;
      }
      // Fire one tick immediately after the startup delay so the user sees an
      // initial status without waiting a full interval.
      this.tick();
      this.checkInterval = setInterval(() => this.tick(), this.tickIntervalMs);
    };

    if (this.startupDelayMs <= 0) {
      scheduleTicks();
    } else {
      this.startupTimeout = setTimeout(() => {
        this.startupTimeout = null;
        scheduleTicks();
      }, this.startupDelayMs);
    }

    log.info("AgentStatusService started", {
      startupDelayMs: this.startupDelayMs,
      tickIntervalMs: this.tickIntervalMs,
    });
  }

  stop(): void {
    this.stopped = true;
    if (this.startupTimeout) {
      clearTimeout(this.startupTimeout);
      this.startupTimeout = null;
    }
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    this.tracked.clear();
    this.inFlightCount = 0;
    this.inFlightPromises.clear();
    this.tickInFlight = false;
    this.hashesHydrated = false;
    log.info("AgentStatusService stopped");
  }

  /**
   * Synchronous best-effort tick entrypoint. Safe to call repeatedly; we
   * guard with `tickInFlight` so overlapping ticks coalesce.
   */
  private tick(): void {
    if (this.stopped || this.tickInFlight) {
      return;
    }
    this.tickInFlight = true;
    void this.runTick().finally(() => {
      this.tickInFlight = false;
    });
  }

  private async runTick(): Promise<void> {
    try {
      // First tick after start() needs to seed lastInputHash from disk so
      // we honor the previous run's dedup state across restarts.
      if (!this.hashesHydrated) {
        await this.hydratePersistedHashes();
        this.hashesHydrated = true;
      }
      this.processEligibleWorkspaces();
      // Wait for the workspaces we just dispatched so callers (production
      // schedulers + tests) observe their effects deterministically.
      await this.drainInFlight();
    } catch (error) {
      log.error("AgentStatusService tick failed", { error });
    }
  }

  private async drainInFlight(): Promise<void> {
    while (this.inFlightPromises.size > 0) {
      await Promise.allSettled(Array.from(this.inFlightPromises));
    }
  }

  private async hydratePersistedHashes(): Promise<void> {
    const config = this.config.loadConfigOrDefault();
    for (const [, projectConfig] of config.projects) {
      for (const workspace of projectConfig.workspaces) {
        const workspaceId = workspace.id ?? workspace.name;
        if (typeof workspaceId !== "string" || workspaceId.length === 0) {
          continue;
        }
        const persistedHash = await this.extensionMetadata.getAiStatusInputHash(workspaceId);
        if (persistedHash !== null) {
          this.tracked.set(workspaceId, {
            lastRanAt: 0,
            lastInputHash: persistedHash,
            inFlight: false,
          });
        }
      }
    }
  }

  // Synchronous: per-workspace dispatches go on inFlightPromises and are
  // awaited by runTick via drainInFlight. Keeping this sync avoids a no-op
  // Promise allocation on every tick.
  private processEligibleWorkspaces(): void {
    const now = this.clock();
    const focused = this.windowService.isFocused();
    const interval = focused
      ? AGENT_STATUS_FOCUSED_INTERVAL_MS
      : AGENT_STATUS_UNFOCUSED_INTERVAL_MS;

    const config = this.config.loadConfigOrDefault();

    // Collect every eligible workspace first, then sort by lastRanAt
    // ascending. With AGENT_STATUS_MAX_CONCURRENT=1 a fixed iteration order
    // would let the first workspace starve everyone deeper in the list
    // (it becomes re-eligible at 30s, and workspace[N>1] is never reached).
    // Sorting by least-recently-run produces a fair round-robin without an
    // explicit queue.
    const eligible: Array<{ workspaceId: string; lastRanAt: number }> = [];
    for (const [, projectConfig] of config.projects) {
      for (const workspace of projectConfig.workspaces) {
        const workspaceId = workspace.id ?? workspace.name;
        if (typeof workspaceId !== "string" || workspaceId.length === 0) {
          continue;
        }
        if (isWorkspaceArchived(workspace.archivedAt, workspace.unarchivedAt)) {
          continue;
        }

        const state = this.tracked.get(workspaceId);
        if (state?.inFlight) {
          continue;
        }
        if (state && now - state.lastRanAt < interval) {
          continue;
        }

        // Workspaces that have never run (state === undefined) get the
        // earliest possible lastRanAt so they preempt previously-run
        // workspaces on their first tick.
        eligible.push({ workspaceId, lastRanAt: state?.lastRanAt ?? 0 });
      }
    }

    eligible.sort((a, b) => a.lastRanAt - b.lastRanAt);

    for (const { workspaceId } of eligible) {
      if (this.stopped) {
        return;
      }
      if (this.inFlightCount >= AGENT_STATUS_MAX_CONCURRENT) {
        return;
      }

      // Per-workspace work runs concurrently up to AGENT_STATUS_MAX_CONCURRENT.
      // We track the promise (instead of fire-and-forget) so runTick can
      // await all dispatched workspaces before returning. That keeps the
      // production tick loop's "did we finish?" semantics observable, and
      // makes tests deterministic without hand-rolled microtask flushing.
      this.inFlightCount += 1;
      this.markInFlight(workspaceId, true);
      const promise = this.runForWorkspace(workspaceId).finally(() => {
        this.inFlightCount = Math.max(0, this.inFlightCount - 1);
        this.markInFlight(workspaceId, false);
        this.inFlightPromises.delete(promise);
      });
      this.inFlightPromises.add(promise);
    }
  }

  private markInFlight(workspaceId: string, value: boolean): void {
    const state = this.tracked.get(workspaceId);
    if (state) {
      state.inFlight = value;
      return;
    }
    if (value) {
      this.tracked.set(workspaceId, { lastRanAt: 0, lastInputHash: null, inFlight: true });
    }
  }

  private async runForWorkspace(workspaceId: string): Promise<void> {
    try {
      const transcript = await this.buildTrailingTranscript(workspaceId);
      const inputHash = computeInputHash(transcript);

      // Always update lastRanAt: even when we skip the LLM call, we don't
      // want to reconsider this workspace until the next interval boundary.
      const state = this.ensureState(workspaceId);
      const now = this.clock();
      state.lastRanAt = now;

      if (transcript.trim().length === 0) {
        // A brand-new workspace with no chat content yet — skip silently.
        // We deliberately do not clear an existing aiStatus here so that a
        // post-compaction "empty boundary" doesn't blank a recently produced
        // status.
        return;
      }

      if (state.lastInputHash === inputHash) {
        // Idle/frozen: identical trailing window, no point in regenerating.
        // Still bump lastRanAt above so we won't revisit until the next
        // interval boundary, which keeps the scheduler cheap.
        return;
      }

      const candidates = await this.workspaceService.getWorkspaceTitleModelCandidates(workspaceId);
      if (candidates.length === 0) {
        log.debug("AgentStatusService: no model candidates for workspace, skipping", {
          workspaceId,
        });
        return;
      }

      const result = await generateWorkspaceStatus(transcript, candidates, this.aiService);
      if (!result.success) {
        log.debug("AgentStatusService: status generation failed; will retry next tick", {
          workspaceId,
          error: result.error,
        });
        // Leave lastInputHash unchanged so the next tick retries even
        // though the input is unchanged.
        return;
      }

      // Persist BEFORE updating the in-memory dedup hash. If the disk write
      // fails (transient I/O error), we want the next tick to retry the
      // unchanged transcript instead of dedup'ing against a hash we never
      // actually committed. The frontend activity emit happens after the
      // write returns successfully, so subscribers either see the new
      // status or fall through to a later retry.
      try {
        const snapshot = await this.extensionMetadata.setAiStatus(
          workspaceId,
          { emoji: result.data.status.emoji, message: result.data.status.message },
          inputHash
        );
        state.lastInputHash = inputHash;
        this.workspaceService.emitWorkspaceActivity(workspaceId, snapshot);
      } catch (error) {
        log.error("AgentStatusService: failed to persist generated status", {
          workspaceId,
          error,
        });
        // Intentionally leave state.lastInputHash untouched so the next tick
        // tries again with the same transcript.
      }
    } catch (error) {
      log.error("AgentStatusService: unexpected error during status generation", {
        workspaceId,
        error,
      });
    }
  }

  private ensureState(workspaceId: string): WorkspaceTrackingState {
    let state = this.tracked.get(workspaceId);
    if (!state) {
      state = { lastRanAt: 0, lastInputHash: null, inFlight: false };
      this.tracked.set(workspaceId, state);
    }
    return state;
  }

  /**
   * Build the trailing chat transcript for a workspace, capped by both
   * message count and {@link AGENT_STATUS_MAX_TRANSCRIPT_TOKENS} tokens.
   *
   * Returns an empty string if the workspace has no chat history yet.
   *
   * During an active stream the assistant's current text and tool calls live
   * in `partial.json` (via HistoryService.writePartial) before being committed
   * to `chat.jsonl`. We append the partial message after the committed tail
   * so the hash changes — and the status refreshes — as the stream progresses,
   * which is exactly when an "agent doing X right now" status is most useful.
   */
  private async buildTrailingTranscript(workspaceId: string): Promise<string> {
    const result = await this.historyService.getLastMessages(
      workspaceId,
      AGENT_STATUS_MAX_TRAILING_MESSAGES
    );
    if (!result.success) {
      return "";
    }

    const messages: MuxMessage[] = [...result.data];
    const partial = await this.historyService.readPartial(workspaceId);
    if (partial) {
      messages.push(partial);
    }

    const formatted = messages.map(formatMessageForTranscript).filter((entry) => entry.length > 0);

    if (formatted.length === 0) {
      return "";
    }

    // Trim from the front (oldest messages) until we fit within the token
    // budget. The trailing-most messages carry the most signal for "what is
    // the agent currently doing", so we never drop them.
    //
    // Use the first candidate model for tokenization. The tokenizer service
    // gracefully falls back to a known family for unknown model strings, so
    // this is safe even when the user's model is not in our table.
    const tokenizerModel = await this.resolveTokenizerModel(workspaceId);
    const tokenCounts = await this.tokenizerService.countTokensBatch(tokenizerModel, formatted);

    let totalTokens = tokenCounts.reduce((sum, n) => sum + n, 0);
    let dropFromIndex = 0;
    while (
      totalTokens > AGENT_STATUS_MAX_TRANSCRIPT_TOKENS &&
      dropFromIndex < formatted.length - 1
    ) {
      totalTokens -= tokenCounts[dropFromIndex];
      dropFromIndex += 1;
    }

    return formatted.slice(dropFromIndex).join("\n\n");
  }

  private async resolveTokenizerModel(workspaceId: string): Promise<string> {
    try {
      const candidates = await this.workspaceService.getWorkspaceTitleModelCandidates(workspaceId);
      // The first candidate is our preferred small model; tokenizing against
      // it is good enough for budgeting purposes even if a fallback ends up
      // being used.
      return candidates[0] ?? "anthropic:claude-haiku-4-5";
    } catch {
      return "anthropic:claude-haiku-4-5";
    }
  }
}

function extractMessageText(message: MuxMessage): string {
  if (!Array.isArray(message.parts)) {
    return "";
  }
  const textParts: string[] = [];
  for (const part of message.parts) {
    if (part?.type !== "text") {
      continue;
    }
    const text = (part as { text?: unknown }).text;
    if (typeof text === "string" && text.trim().length > 0) {
      textParts.push(text.trim());
    }
  }
  return textParts.join("\n");
}

function summarizeToolPart(part: unknown): string | null {
  if (typeof part !== "object" || part === null) {
    return null;
  }
  const record = part as Record<string, unknown>;
  const type = record.type;
  if (typeof type !== "string") {
    return null;
  }
  // Tool calls have type "tool-<name>" or "dynamic-tool" with a toolName.
  const toolName =
    typeof record.toolName === "string"
      ? record.toolName
      : type.startsWith("tool-")
        ? type.slice(5)
        : null;
  if (!toolName) {
    return null;
  }
  return `[tool ${toolName}]`;
}

function formatMessageForTranscript(message: MuxMessage): string {
  const role = message.role === "user" ? "User" : message.role === "assistant" ? "Assistant" : null;
  if (!role) {
    return "";
  }
  const text = extractMessageText(message);
  // Include a brief tool-call summary so the model can see *what* the agent
  // is doing even when the assistant has not yet emitted natural-language
  // text for the current step. We avoid inlining tool args/output to keep
  // the cost predictable.
  const toolSummaries: string[] = [];
  if (Array.isArray(message.parts)) {
    for (const part of message.parts) {
      const summary = summarizeToolPart(part);
      if (summary) {
        toolSummaries.push(summary);
      }
    }
  }

  const segments: string[] = [];
  if (text.length > 0) {
    segments.push(text.slice(0, AGENT_STATUS_MAX_MESSAGE_CHARS));
  }
  if (toolSummaries.length > 0) {
    segments.push(toolSummaries.join(" "));
  }

  if (segments.length === 0) {
    return "";
  }

  return `${role}: ${segments.join("\n")}`;
}

/**
 * Compute a stable hash of the trailing transcript window. Used by the
 * scheduler to skip regeneration when the input hasn't changed since the
 * last successful generation. SHA-256 is overkill but trivially cheap;
 * the hash is opaque to everything outside this service.
 */
function computeInputHash(transcript: string): string {
  return createHash("sha256").update(transcript).digest("hex");
}

// Exported for tests.
export const __test__ = {
  computeInputHash,
  extractMessageText,
  formatMessageForTranscript,
};
