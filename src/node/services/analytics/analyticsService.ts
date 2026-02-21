import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Worker } from "node:worker_threads";
import type {
  AgentCostRow,
  HistogramBucket,
  SpendByModelRow,
  SpendByProjectRow,
  SpendOverTimeRow,
  SummaryRow,
  TimingPercentilesRow,
} from "@/common/orpc/schemas/analytics";
import type { Config } from "@/node/config";
import { getErrorMessage } from "@/common/utils/errors";
import { PlatformPaths } from "@/common/utils/paths";
import { log } from "@/node/services/log";

interface WorkerRequest {
  messageId: number;
  taskName: string;
  data: unknown;
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
  | "getAgentCostBreakdown";

interface IngestWorkspaceMeta {
  projectPath?: string;
  projectName?: string;
  workspaceName?: string;
  parentWorkspaceId?: string;
}

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

export class AnalyticsService {
  private worker: Worker | null = null;
  private messageIdCounter = 0;
  private readonly pendingPromises = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private workerError: Error | null = null;
  private initPromise: Promise<void> | null = null;

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
    const dbDir = path.join(this.config.rootDir, "analytics");
    await fs.mkdir(dbDir, { recursive: true });

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

    // Backfill existing workspace history only when the analytics DB appears
    // uninitialized (no events and no ingest watermarks) and there are session
    // directories to process. Routine worker restarts therefore skip full rebuilds.
    // Awaited so the first query sees complete data instead of an
    // empty/partially-rebuilt database.
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

  async getSummary(projectPath: string | null): Promise<{
    totalSpendUsd: number;
    todaySpendUsd: number;
    avgDailySpendUsd: number;
    cacheHitRatio: number;
    totalTokens: number;
    totalResponses: number;
  }> {
    const row = await this.executeQuery<SummaryRow>("getSummary", { projectPath });

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

  async getSpendByProject(): Promise<
    Array<{ projectName: string; projectPath: string; costUsd: number; tokenCount: number }>
  > {
    const rows = await this.executeQuery<SpendByProjectRow[]>("getSpendByProject", {});

    return rows.map((row) => ({
      projectName: row.project_name,
      projectPath: row.project_path,
      costUsd: row.cost_usd,
      tokenCount: row.token_count,
    }));
  }

  async getSpendByModel(
    projectPath: string | null
  ): Promise<Array<{ model: string; costUsd: number; tokenCount: number; responseCount: number }>> {
    const rows = await this.executeQuery<SpendByModelRow[]>("getSpendByModel", { projectPath });

    return rows.map((row) => ({
      model: row.model,
      costUsd: row.cost_usd,
      tokenCount: row.token_count,
      responseCount: row.response_count,
    }));
  }

  async getTimingDistribution(
    metric: "ttft" | "duration" | "tps",
    projectPath: string | null
  ): Promise<{
    p50: number;
    p90: number;
    p99: number;
    histogram: Array<{ bucket: number; count: number }>;
  }> {
    const row = await this.executeQuery<TimingDistributionRow>("getTimingDistribution", {
      metric,
      projectPath,
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
    projectPath: string | null
  ): Promise<
    Array<{ agentId: string; costUsd: number; tokenCount: number; responseCount: number }>
  > {
    const rows = await this.executeQuery<AgentCostRow[]>("getAgentCostBreakdown", { projectPath });

    return rows.map((row) => ({
      agentId: row.agent_id,
      costUsd: row.cost_usd,
      tokenCount: row.token_count,
      responseCount: row.response_count,
    }));
  }

  async rebuildAll(): Promise<{ success: boolean; workspacesIngested: number }> {
    await this.ensureWorker();
    const result = await this.dispatch<RebuildAllResult>("rebuildAll", this.buildRebuildAllData());

    return {
      success: true,
      workspacesIngested: result.workspacesIngested,
    };
  }

  clearWorkspace(workspaceId: string): void {
    if (workspaceId.trim().length === 0) {
      log.warn("[AnalyticsService] Skipping workspace clear due to missing workspaceId", {
        workspaceId,
      });
      return;
    }

    // Workspace-removal hooks can fire in processes that never touched analytics.
    // Avoid bootstrapping DuckDB/backfill just to clear state that cannot exist yet.
    if (this.worker == null && this.initPromise == null && this.workerError == null) {
      return;
    }

    this.ensureWorker()
      .then(() => this.dispatch<void>("clearWorkspace", { workspaceId }))
      .catch((error) => {
        log.warn("[AnalyticsService] Failed to clear workspace analytics state", {
          workspaceId,
          error: getErrorMessage(error),
        });
      });
  }

  ingestWorkspace(workspaceId: string, sessionDir: string, meta: IngestWorkspaceMeta = {}): void {
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
