import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Worker } from "node:worker_threads";
import type {
  AgentCostRow,
  HistogramBucket,
  ProviderCacheHitModelRow,
  SpendByModelRow,
  SpendByProjectRow,
  SpendOverTimeRow,
  SummaryRow,
  TimingPercentilesRow,
} from "@/common/orpc/schemas/analytics";
import { getModelProvider } from "@/common/utils/ai/models";
import type { Config } from "@/node/config";
import { getErrorMessage } from "@/common/utils/errors";
import { PlatformPaths } from "@/common/utils/paths";
import { log } from "@/node/services/log";

interface WorkerRequest {
  messageId: number;
  taskName: string;
  data: unknown;
}

interface WorkerShutdownMessage {
  type: "shutdown";
}

interface WorkerSuccessResponse {
  messageId: number;
  result: unknown;
}

interface WorkerErrorResponse {
  messageId: number;
  error: {
    message: string;
    stack?: string;
  };
}

type WorkerResponse = WorkerSuccessResponse | WorkerErrorResponse;

type AnalyticsQueryName =
  | "getSummary"
  | "getSpendOverTime"
  | "getSpendByProject"
  | "getSpendByModel"
  | "getTimingDistribution"
  | "getAgentCostBreakdown"
  | "getCacheHitRatioByProvider";

interface IngestWorkspaceMeta {
  projectPath: string | undefined;
  projectName: string | undefined;
  workspaceName: string | undefined;
  parentWorkspaceId: string | undefined;
}

// stream-end ingestion is the first analytics write for newly spawned sub-agent
// workspaces, so callers that have config access must explicitly thread every
// metadata field (including intentional undefined values). This turns future
// metadata additions into compile-time errors instead of silent NULL regressions.
const EMPTY_INGEST_WORKSPACE_META: IngestWorkspaceMeta = {
  projectPath: undefined,
  projectName: undefined,
  workspaceName: undefined,
  parentWorkspaceId: undefined,
};

interface TimingDistributionRow {
  percentiles: TimingPercentilesRow;
  histogram: HistogramBucket[];
}

interface RebuildAllResult {
  workspacesIngested: number;
}

interface NeedsBackfillResult {
  needsBackfill: boolean;
}

interface RebuildAllData {
  sessionsDir: string;
  workspaceMetaById: Record<string, IngestWorkspaceMeta>;
}

interface NeedsBackfillData {
  sessionsDir: string;
}

function toOptionalNonEmptyString(value: string | undefined): string | undefined {
  if (value == null) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function toDateFilterString(value: Date | null | undefined): string | null {
  if (value == null) {
    return null;
  }

  assert(Number.isFinite(value.getTime()), "Analytics date filter must be a valid Date");
  return value.toISOString().slice(0, 10);
}

interface ProviderCacheHitTotals {
  cachedTokens: number;
  totalPromptTokens: number;
  responseCount: number;
}

function normalizeProviderName(model: string): string {
  const provider = getModelProvider(model).trim().toLowerCase();
  return provider.length > 0 ? provider : "unknown";
}

/**
 * Roll model-level cache metrics into provider buckets using the same provider
 * parser as the rest of the app (handles mux-gateway prefixes and malformed
 * model strings consistently).
 */
export function aggregateProviderCacheHitRows(
  rows: ProviderCacheHitModelRow[]
): Array<{ provider: string; cacheHitRatio: number; responseCount: number }> {
  const totalsByProvider = new Map<string, ProviderCacheHitTotals>();

  for (const row of rows) {
    assert(typeof row.model === "string", "Provider cache hit aggregation requires a string model");
    assert(
      Number.isFinite(row.cached_tokens) && row.cached_tokens >= 0,
      "Provider cache hit aggregation requires non-negative cached_tokens"
    );
    assert(
      Number.isFinite(row.total_prompt_tokens) && row.total_prompt_tokens >= 0,
      "Provider cache hit aggregation requires non-negative total_prompt_tokens"
    );
    assert(
      Number.isFinite(row.response_count) && row.response_count >= 0,
      "Provider cache hit aggregation requires non-negative response_count"
    );

    const provider = normalizeProviderName(row.model);
    const current = totalsByProvider.get(provider);

    if (current) {
      current.cachedTokens += row.cached_tokens;
      current.totalPromptTokens += row.total_prompt_tokens;
      current.responseCount += row.response_count;
      continue;
    }

    totalsByProvider.set(provider, {
      cachedTokens: row.cached_tokens,
      totalPromptTokens: row.total_prompt_tokens,
      responseCount: row.response_count,
    });
  }

  return Array.from(totalsByProvider.entries())
    .map(([provider, totals]) => ({
      provider,
      cacheHitRatio:
        totals.totalPromptTokens > 0 ? totals.cachedTokens / totals.totalPromptTokens : 0,
      responseCount: totals.responseCount,
    }))
    .sort((left, right) => {
      if (right.cacheHitRatio !== left.cacheHitRatio) {
        return right.cacheHitRatio - left.cacheHitRatio;
      }

      if (right.responseCount !== left.responseCount) {
        return right.responseCount - left.responseCount;
      }

      return left.provider.localeCompare(right.provider);
    });
}

export class AnalyticsService {
  private worker: Worker | null = null;
  private messageIdCounter = 0;
  private readonly pendingPromises = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private workerError: Error | null = null;
  private initPromise: Promise<void> | null = null;
  private disposePromise: Promise<void> | null = null;
  private isDisposed = false;

  constructor(private readonly config: Config) {}

  private rejectPending(error: Error): void {
    for (const pending of this.pendingPromises.values()) {
      pending.reject(error);
    }
    this.pendingPromises.clear();
  }

  private resolveWorkerPath(): string {
    const currentDir = path.dirname(__filename);
    const pathParts = currentDir.split(path.sep);
    const hasDist = pathParts.includes("dist");
    const srcIndex = pathParts.lastIndexOf("src");

    let workerDir = currentDir;
    let workerFile = "analyticsWorker.js";

    const isBun = !!(process as unknown as { isBun?: boolean }).isBun;
    if (isBun && path.extname(__filename) === ".ts") {
      workerFile = "analyticsWorker.ts";
    } else if (srcIndex !== -1 && !hasDist) {
      pathParts[srcIndex] = "dist";
      workerDir = pathParts.join(path.sep);
    }

    return path.join(workerDir, workerFile);
  }

  private buildRebuildWorkspaceMetaById(): Record<string, IngestWorkspaceMeta> {
    const configSnapshot = this.config.loadConfigOrDefault();
    const workspaceMetaById: Record<string, IngestWorkspaceMeta> = {};

    for (const [projectPath, projectConfig] of configSnapshot.projects) {
      const normalizedProjectPath = toOptionalNonEmptyString(projectPath);
      if (!normalizedProjectPath) {
        log.warn("[AnalyticsService] Skipping rebuild metadata for empty project path");
        continue;
      }

      const projectName = PlatformPaths.getProjectName(normalizedProjectPath);

      for (const workspace of projectConfig.workspaces) {
        const workspaceId = toOptionalNonEmptyString(workspace.id);
        if (!workspaceId) {
          continue;
        }

        if (workspaceMetaById[workspaceId]) {
          log.warn(
            "[AnalyticsService] Duplicate workspace ID in config while building rebuild metadata",
            {
              workspaceId,
              projectPath: normalizedProjectPath,
            }
          );
          continue;
        }

        workspaceMetaById[workspaceId] = {
          projectPath: normalizedProjectPath,
          projectName,
          workspaceName: toOptionalNonEmptyString(workspace.name),
          parentWorkspaceId: toOptionalNonEmptyString(workspace.parentWorkspaceId),
        };
      }
    }

    return workspaceMetaById;
  }

  private buildRebuildAllData(): RebuildAllData {
    assert(
      this.config.sessionsDir.trim().length > 0,
      "Analytics rebuild requires a non-empty sessionsDir"
    );

    return {
      sessionsDir: this.config.sessionsDir,
      workspaceMetaById: this.buildRebuildWorkspaceMetaById(),
    };
  }

  private readonly onWorkerMessage = (response: WorkerResponse): void => {
    const pending = this.pendingPromises.get(response.messageId);
    if (!pending) {
      log.error("[AnalyticsService] No pending promise for message", {
        messageId: response.messageId,
      });
      return;
    }

    this.pendingPromises.delete(response.messageId);

    if ("error" in response) {
      const error = new Error(response.error.message);
      error.stack = response.error.stack;
      pending.reject(error);
      return;
    }

    pending.resolve(response.result);
  };

  private readonly onWorkerError = (error: Error): void => {
    this.workerError = error;
    this.rejectPending(error);
    log.error("[AnalyticsService] Worker error", { error: getErrorMessage(error) });
  };

  private readonly onWorkerExit = (code: number): void => {
    if (code === 0) {
      return;
    }

    const error = new Error(`Analytics worker exited with code ${code}`);
    this.workerError = error;
    this.rejectPending(error);
    log.error("[AnalyticsService] Worker exited unexpectedly", { code });
  };

  private async startWorker(): Promise<void> {
    assert(!this.isDisposed, "Analytics worker cannot start after service disposal");

    const dbDir = path.join(this.config.rootDir, "analytics");
    await fs.mkdir(dbDir, { recursive: true });

    if (this.isDisposed) {
      throw new Error("Analytics worker start aborted because service is disposing");
    }

    const workerPath = this.resolveWorkerPath();
    this.worker = new Worker(workerPath);
    this.worker.unref();

    this.worker.on("message", this.onWorkerMessage);
    this.worker.on("error", this.onWorkerError);
    this.worker.on("exit", this.onWorkerExit);

    const dbPath = path.join(dbDir, "analytics.db");
    await this.dispatch("init", { dbPath });

    const backfillState = await this.dispatch<NeedsBackfillResult>("needsBackfill", {
      sessionsDir: this.config.sessionsDir,
    } satisfies NeedsBackfillData);
    assert(
      typeof backfillState.needsBackfill === "boolean",
      "Analytics worker needsBackfill task must return a boolean"
    );

    if (!backfillState.needsBackfill) {
      return;
    }

    // Backfill existing workspace history when analytics initialization is
    // missing or appears partial (for example, when any session workspace lacks
    // a matching watermark row, even if stale watermark rows keep counts equal).
    // Once every session workspace has a watermark row, routine worker restarts
    // skip full rebuilds, including zero-event histories. Awaited so the first
    // query sees complete data instead of an empty/partially-rebuilt database.
    try {
      await this.dispatch("rebuildAll", this.buildRebuildAllData());
    } catch (error) {
      // Non-fatal: queries will work but may show partial historical data
      // until incremental stream-end ingestion fills gaps.
      log.warn("[AnalyticsService] Initial backfill failed (non-fatal)", {
        error: getErrorMessage(error),
      });
    }
  }

  private ensureWorker(): Promise<void> {
    if (this.isDisposed) {
      return Promise.reject(new Error("Analytics service has been disposed"));
    }

    if (this.workerError) {
      return Promise.reject(this.workerError);
    }

    this.initPromise ??= this.startWorker().catch((error: unknown) => {
      const normalizedError = error instanceof Error ? error : new Error(getErrorMessage(error));
      this.workerError = normalizedError;
      this.initPromise = null;
      throw normalizedError;
    });

    return this.initPromise;
  }

  private dispatch<T>(taskName: string, data: unknown): Promise<T> {
    if (this.workerError) {
      return Promise.reject(this.workerError);
    }

    const worker = this.worker;
    assert(worker, `Analytics worker is unavailable for task '${taskName}'`);

    const request: WorkerRequest = {
      messageId: this.messageIdCounter,
      taskName,
      data,
    };

    this.messageIdCounter += 1;

    return new Promise<T>((resolve, reject) => {
      this.pendingPromises.set(request.messageId, {
        resolve: resolve as (value: unknown) => void,
        reject,
      });

      try {
        worker.postMessage(request);
      } catch (error) {
        this.pendingPromises.delete(request.messageId);
        reject(error instanceof Error ? error : new Error(getErrorMessage(error)));
      }
    });
  }

  private async executeQuery<T>(
    queryName: AnalyticsQueryName,
    params: Record<string, unknown>
  ): Promise<T> {
    await this.ensureWorker();
    return this.dispatch<T>("query", { queryName, params });
  }

  async getSummary(
    projectPath: string | null,
    from?: Date | null,
    to?: Date | null
  ): Promise<{
    totalSpendUsd: number;
    todaySpendUsd: number;
    avgDailySpendUsd: number;
    cacheHitRatio: number;
    totalTokens: number;
    totalResponses: number;
  }> {
    const row = await this.executeQuery<SummaryRow>("getSummary", {
      projectPath,
      from: toDateFilterString(from),
      to: toDateFilterString(to),
    });

    return {
      totalSpendUsd: row.total_spend_usd,
      todaySpendUsd: row.today_spend_usd,
      avgDailySpendUsd: row.avg_daily_spend_usd,
      cacheHitRatio: row.cache_hit_ratio,
      totalTokens: row.total_tokens,
      totalResponses: row.total_responses,
    };
  }

  async getSpendOverTime(params: {
    granularity: "hour" | "day" | "week";
    projectPath?: string | null;
    from?: Date | null;
    to?: Date | null;
  }): Promise<Array<{ bucket: string; model: string; costUsd: number }>> {
    const rows = await this.executeQuery<SpendOverTimeRow[]>("getSpendOverTime", {
      granularity: params.granularity,
      projectPath: params.projectPath ?? null,
      from: toDateFilterString(params.from),
      to: toDateFilterString(params.to),
    });

    return rows.map((row) => ({
      bucket: row.bucket,
      model: row.model,
      costUsd: row.cost_usd,
    }));
  }

  async getSpendByProject(
    from?: Date | null,
    to?: Date | null
  ): Promise<
    Array<{ projectName: string; projectPath: string; costUsd: number; tokenCount: number }>
  > {
    const rows = await this.executeQuery<SpendByProjectRow[]>("getSpendByProject", {
      from: toDateFilterString(from),
      to: toDateFilterString(to),
    });

    return rows.map((row) => ({
      projectName: row.project_name,
      projectPath: row.project_path,
      costUsd: row.cost_usd,
      tokenCount: row.token_count,
    }));
  }

  async getSpendByModel(
    projectPath: string | null,
    from?: Date | null,
    to?: Date | null
  ): Promise<Array<{ model: string; costUsd: number; tokenCount: number; responseCount: number }>> {
    const rows = await this.executeQuery<SpendByModelRow[]>("getSpendByModel", {
      projectPath,
      from: toDateFilterString(from),
      to: toDateFilterString(to),
    });

    return rows.map((row) => ({
      model: row.model,
      costUsd: row.cost_usd,
      tokenCount: row.token_count,
      responseCount: row.response_count,
    }));
  }

  async getTimingDistribution(
    metric: "ttft" | "duration" | "tps",
    projectPath: string | null,
    from?: Date | null,
    to?: Date | null
  ): Promise<{
    p50: number;
    p90: number;
    p99: number;
    histogram: Array<{ bucket: number; count: number }>;
  }> {
    const row = await this.executeQuery<TimingDistributionRow>("getTimingDistribution", {
      metric,
      projectPath,
      from: toDateFilterString(from),
      to: toDateFilterString(to),
    });

    return {
      p50: row.percentiles.p50,
      p90: row.percentiles.p90,
      p99: row.percentiles.p99,
      histogram: row.histogram.map((bucket) => ({
        bucket: bucket.bucket,
        count: bucket.count,
      })),
    };
  }

  async getAgentCostBreakdown(
    projectPath: string | null,
    from?: Date | null,
    to?: Date | null
  ): Promise<
    Array<{ agentId: string; costUsd: number; tokenCount: number; responseCount: number }>
  > {
    const rows = await this.executeQuery<AgentCostRow[]>("getAgentCostBreakdown", {
      projectPath,
      from: toDateFilterString(from),
      to: toDateFilterString(to),
    });

    return rows.map((row) => ({
      agentId: row.agent_id,
      costUsd: row.cost_usd,
      tokenCount: row.token_count,
      responseCount: row.response_count,
    }));
  }

  async getCacheHitRatioByProvider(
    projectPath: string | null,
    from?: Date | null,
    to?: Date | null
  ): Promise<Array<{ provider: string; cacheHitRatio: number; responseCount: number }>> {
    const rows = await this.executeQuery<ProviderCacheHitModelRow[]>("getCacheHitRatioByProvider", {
      projectPath,
      from: toDateFilterString(from),
      to: toDateFilterString(to),
    });

    return aggregateProviderCacheHitRows(rows);
  }

  async rebuildAll(): Promise<{ success: boolean; workspacesIngested: number }> {
    await this.ensureWorker();
    const result = await this.dispatch<RebuildAllResult>("rebuildAll", this.buildRebuildAllData());

    return {
      success: true,
      workspacesIngested: result.workspacesIngested,
    };
  }

  dispose(): Promise<void> {
    this.disposePromise ??= Promise.resolve().then(() => {
      this.disposeInternal();
    });
    return this.disposePromise;
  }

  private disposeInternal(): void {
    this.isDisposed = true;

    const disposedError = new Error("Analytics service is shutting down");
    this.workerError = disposedError;
    this.initPromise = null;

    this.rejectPending(disposedError);

    const worker = this.worker;
    if (worker == null) {
      return;
    }

    this.worker = null;
    worker.off("message", this.onWorkerMessage);
    worker.off("error", this.onWorkerError);
    worker.off("exit", this.onWorkerExit);

    // Shut down DuckDB from inside the worker thread first. The worker is
    // already unref'd, so process shutdown does not wait for this cleanup.
    try {
      worker.postMessage({ type: "shutdown" } satisfies WorkerShutdownMessage);
    } catch (error) {
      log.warn("[AnalyticsService] Failed to post graceful shutdown message to analytics worker", {
        error: getErrorMessage(error),
      });
    }
  }

  clearWorkspace(workspaceId: string): void {
    if (workspaceId.trim().length === 0) {
      log.warn("[AnalyticsService] Skipping workspace clear due to missing workspaceId", {
        workspaceId,
      });
      return;
    }

    const runClear = () => {
      this.ensureWorker()
        .then(() => this.dispatch<void>("clearWorkspace", { workspaceId }))
        .catch((error) => {
          log.warn("[AnalyticsService] Failed to clear workspace analytics state", {
            workspaceId,
            error: getErrorMessage(error),
          });
        });
    };

    // Workspace-removal hooks can fire before analytics is ever opened in this
    // process. If analytics DB does not exist yet, skip bootstrapping worker.
    // If DB does exist (from prior runs), bootstrap and clear so stale rows are
    // removed immediately after workspace deletion.
    if (this.worker == null && this.initPromise == null && this.workerError == null) {
      const dbPath = path.join(this.config.rootDir, "analytics", "analytics.db");
      void fs
        .access(dbPath)
        .then(() => {
          runClear();
        })
        .catch((error) => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return;
          }

          // For non-ENOENT access failures, attempt best-effort cleanup anyway.
          runClear();
        });
      return;
    }

    runClear();
  }

  ingestWorkspace(
    workspaceId: string,
    sessionDir: string,
    meta: IngestWorkspaceMeta = EMPTY_INGEST_WORKSPACE_META
  ): void {
    if (workspaceId.trim().length === 0 || sessionDir.trim().length === 0) {
      log.warn("[AnalyticsService] Skipping ingest due to missing workspace information", {
        workspaceId,
        sessionDir,
      });
      return;
    }

    this.ensureWorker()
      .then(() => this.dispatch("ingest", { workspaceId, sessionDir, meta }))
      .catch((error) => {
        log.warn("[AnalyticsService] Failed to ingest workspace", {
          workspaceId,
          error: getErrorMessage(error),
        });
      });
  }
}
