import assert from "@/common/utils/assert";
import * as fs from "fs/promises";
import * as path from "path";
import { EventEmitter } from "events";
import writeFileAtomic from "write-file-atomic";
import type { Config } from "@/node/config";
import { workspaceFileLocks } from "@/node/utils/concurrency/workspaceFileLocks";
import { normalizeGatewayModel } from "@/common/utils/ai/models";
import {
  ActiveStreamStatsSchema,
  CompletedStreamStatsSchema,
  SessionTimingFileSchema,
} from "@/common/orpc/schemas/workspaceStats";
import type {
  ActiveStreamStats,
  CompletedStreamStats,
  SessionTimingFile,
  TimingAnomaly,
  WorkspaceStatsSnapshot,
} from "@/common/orpc/schemas/workspaceStats";
import type {
  StreamStartEvent,
  StreamDeltaEvent,
  ReasoningDeltaEvent,
  ToolCallStartEvent,
  ToolCallDeltaEvent,
  ToolCallEndEvent,
  StreamEndEvent,
  StreamAbortEvent,
} from "@/common/types/stream";
import { createDeltaStorage, type DeltaRecordStorage } from "@/common/utils/tokens/tps";
import { log } from "./log";
import type { TelemetryService } from "./telemetryService";
import { roundToBase2 } from "@/common/telemetry/utils";

const SESSION_TIMING_FILE = "session-timing.json";

export type StatsTabVariant = "control" | "stats";
export type StatsTabOverride = "default" | "on" | "off";

export interface StatsTabState {
  enabled: boolean;
  variant: StatsTabVariant;
  override: StatsTabOverride;
}

interface ActiveStreamState {
  workspaceId: string;
  messageId: string;
  model: string;
  mode?: "plan" | "exec";

  startTimeMs: number;
  firstTokenTimeMs: number | null;

  completedToolExecutionMs: number;
  pendingToolStarts: Map<string, number>;

  outputTokensByDelta: number;
  reasoningTokensByDelta: number;

  deltaStorage: DeltaRecordStorage;

  lastEventTimestampMs: number;
}

function getModelKey(model: string, mode: "plan" | "exec" | undefined): string {
  return mode ? `${model}:${mode}` : model;
}

function createEmptyTimingFile(): SessionTimingFile {
  return {
    version: 1,
    session: {
      totalDurationMs: 0,
      totalToolExecutionMs: 0,
      totalStreamingMs: 0,
      totalTtftMs: 0,
      ttftCount: 0,
      responseCount: 0,
      totalOutputTokens: 0,
      totalReasoningTokens: 0,
      byModel: {},
    },
  };
}

function isFiniteNumber(value: number): boolean {
  return Number.isFinite(value);
}

function validateTiming(params: {
  totalDurationMs: number;
  toolExecutionMs: number;
  ttftMs: number | null;
  modelTimeMs: number;
  streamingMs: number;
}): { invalid: boolean; anomalies: TimingAnomaly[] } {
  const anomalies: TimingAnomaly[] = [];

  if (
    !isFiniteNumber(params.totalDurationMs) ||
    !isFiniteNumber(params.toolExecutionMs) ||
    !isFiniteNumber(params.modelTimeMs) ||
    !isFiniteNumber(params.streamingMs) ||
    (params.ttftMs !== null && !isFiniteNumber(params.ttftMs))
  ) {
    anomalies.push("nan");
  }

  if (
    params.totalDurationMs < 0 ||
    params.toolExecutionMs < 0 ||
    params.modelTimeMs < 0 ||
    params.streamingMs < 0 ||
    (params.ttftMs !== null && params.ttftMs < 0)
  ) {
    anomalies.push("negative_duration");
  }

  if (params.toolExecutionMs > params.totalDurationMs) {
    anomalies.push("tool_gt_total");
  }

  if (params.ttftMs !== null && params.ttftMs > params.totalDurationMs) {
    anomalies.push("ttft_gt_total");
  }

  if (params.totalDurationMs > 0) {
    const toolPercent = (params.toolExecutionMs / params.totalDurationMs) * 100;
    const modelPercent = (params.modelTimeMs / params.totalDurationMs) * 100;
    if (
      toolPercent < 0 ||
      toolPercent > 100 ||
      modelPercent < 0 ||
      modelPercent > 100 ||
      !Number.isFinite(toolPercent) ||
      !Number.isFinite(modelPercent)
    ) {
      anomalies.push("percent_out_of_range");
    }
  }

  return { invalid: anomalies.length > 0, anomalies };
}

/**
 * SessionTimingService
 *
 * Backend source-of-truth for timing stats.
 * - Keeps active stream timing in memory
 * - Persists cumulative session timing to ~/.mux/sessions/{workspaceId}/session-timing.json
 * - Emits snapshots to oRPC subscribers
 */
export class SessionTimingService {
  private readonly config: Config;
  private readonly telemetryService: TelemetryService;
  private readonly fileLocks = workspaceFileLocks;

  private readonly activeStreams = new Map<string, ActiveStreamState>();
  private readonly timingFileCache = new Map<string, SessionTimingFile>();

  private readonly emitter = new EventEmitter();
  private readonly subscriberCounts = new Map<string, number>();

  // Serialize disk writes per workspace; useful for tests and crash-safe ordering.
  private readonly pendingWrites = new Map<string, Promise<void>>();
  private readonly writeEpoch = new Map<string, number>();
  private readonly tickIntervals = new Map<string, NodeJS.Timeout>();

  private statsTabState: StatsTabState = {
    enabled: false,
    variant: "control",
    override: "default",
  };

  constructor(config: Config, telemetryService: TelemetryService) {
    this.config = config;
    this.telemetryService = telemetryService;
  }

  setStatsTabState(state: StatsTabState): void {
    this.statsTabState = state;
  }

  isEnabled(): boolean {
    return this.statsTabState.enabled;
  }

  addSubscriber(workspaceId: string): void {
    const next = (this.subscriberCounts.get(workspaceId) ?? 0) + 1;
    this.subscriberCounts.set(workspaceId, next);
    this.ensureTicking(workspaceId);
  }

  removeSubscriber(workspaceId: string): void {
    const current = this.subscriberCounts.get(workspaceId) ?? 0;
    const next = Math.max(0, current - 1);
    if (next === 0) {
      this.subscriberCounts.delete(workspaceId);
      const interval = this.tickIntervals.get(workspaceId);
      if (interval) {
        clearInterval(interval);
        this.tickIntervals.delete(workspaceId);
      }
      return;
    }
    this.subscriberCounts.set(workspaceId, next);
  }

  onStatsChange(listener: (workspaceId: string) => void): void {
    this.emitter.on("change", listener);
  }

  offStatsChange(listener: (workspaceId: string) => void): void {
    this.emitter.off("change", listener);
  }

  private emitChange(workspaceId: string): void {
    // Only wake subscribers if anyone is listening for this workspace.
    if ((this.subscriberCounts.get(workspaceId) ?? 0) === 0) {
      return;
    }
    this.emitter.emit("change", workspaceId);
  }

  private ensureTicking(workspaceId: string): void {
    if (this.tickIntervals.has(workspaceId)) {
      return;
    }

    // Tick only while there is an active stream.
    const interval = setInterval(() => {
      if (!this.activeStreams.has(workspaceId)) {
        return;
      }
      this.emitChange(workspaceId);
    }, 1000);

    this.tickIntervals.set(workspaceId, interval);
  }

  private getFilePath(workspaceId: string): string {
    return path.join(this.config.getSessionDir(workspaceId), SESSION_TIMING_FILE);
  }

  private async readTimingFile(workspaceId: string): Promise<SessionTimingFile> {
    try {
      const data = await fs.readFile(this.getFilePath(workspaceId), "utf-8");
      const parsed = JSON.parse(data) as unknown;
      const validated = SessionTimingFileSchema.parse(parsed);
      return validated;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return createEmptyTimingFile();
      }
      log.warn(`session-timing.json corrupted for ${workspaceId}; resetting`, { error });
      return createEmptyTimingFile();
    }
  }

  private async writeTimingFile(workspaceId: string, data: SessionTimingFile): Promise<void> {
    const filePath = this.getFilePath(workspaceId);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await writeFileAtomic(filePath, JSON.stringify(data, null, 2));
  }

  async waitForIdle(workspaceId: string): Promise<void> {
    await (this.pendingWrites.get(workspaceId) ?? Promise.resolve());
  }

  private applyCompletedStreamToFile(
    file: SessionTimingFile,
    completed: CompletedStreamStats
  ): void {
    file.lastRequest = completed;

    file.session.totalDurationMs += completed.totalDurationMs;
    file.session.totalToolExecutionMs += completed.toolExecutionMs;
    file.session.totalStreamingMs += completed.streamingMs;
    if (completed.ttftMs !== null) {
      file.session.totalTtftMs += completed.ttftMs;
      file.session.ttftCount += 1;
    }
    file.session.responseCount += 1;
    file.session.totalOutputTokens += completed.outputTokens;
    file.session.totalReasoningTokens += completed.reasoningTokens;

    const key = getModelKey(completed.model, completed.mode);
    const existing = file.session.byModel[key];
    const base = existing ?? {
      model: completed.model,
      mode: completed.mode,
      totalDurationMs: 0,
      totalToolExecutionMs: 0,
      totalStreamingMs: 0,
      totalTtftMs: 0,
      ttftCount: 0,
      responseCount: 0,
      totalOutputTokens: 0,
      totalReasoningTokens: 0,
    };

    base.totalDurationMs += completed.totalDurationMs;
    base.totalToolExecutionMs += completed.toolExecutionMs;
    base.totalStreamingMs += completed.streamingMs;
    if (completed.ttftMs !== null) {
      base.totalTtftMs += completed.ttftMs;
      base.ttftCount += 1;
    }
    base.responseCount += 1;
    base.totalOutputTokens += completed.outputTokens;
    base.totalReasoningTokens += completed.reasoningTokens;

    file.session.byModel[key] = base;
  }

  private queuePersistCompletedStream(workspaceId: string, completed: CompletedStreamStats): void {
    const epoch = this.writeEpoch.get(workspaceId) ?? 0;

    const previous = this.pendingWrites.get(workspaceId) ?? Promise.resolve();

    const next = previous
      .then(async () => {
        await this.fileLocks.withLock(workspaceId, async () => {
          // If a clear() happened after this persist was scheduled, skip.
          if ((this.writeEpoch.get(workspaceId) ?? 0) !== epoch) {
            return;
          }

          const current = await this.readTimingFile(workspaceId);
          this.applyCompletedStreamToFile(current, completed);

          await this.writeTimingFile(workspaceId, current);
          this.timingFileCache.set(workspaceId, current);
        });

        // Telemetry (only when feature enabled)
        const durationSecs = Math.max(0, completed.totalDurationMs / 1000);

        const toolPercentBucket =
          completed.totalDurationMs > 0
            ? Math.max(
                0,
                Math.min(
                  100,
                  Math.round(((completed.toolExecutionMs / completed.totalDurationMs) * 100) / 5) *
                    5
                )
              )
            : 0;

        this.telemetryService.capture({
          event: "stream_timing_computed",
          properties: {
            model: completed.model,
            mode: completed.mode ?? "unknown",
            duration_b2: roundToBase2(durationSecs),
            ttft_ms_b2: completed.ttftMs !== null ? roundToBase2(completed.ttftMs) : 0,
            tool_ms_b2: roundToBase2(completed.toolExecutionMs),
            streaming_ms_b2: roundToBase2(completed.streamingMs),
            tool_percent_bucket: toolPercentBucket,
            invalid: completed.invalid,
          },
        });

        if (completed.invalid) {
          const reason = completed.anomalies[0] ?? "unknown";
          this.telemetryService.capture({
            event: "stream_timing_invalid",
            properties: {
              reason,
            },
          });
        }
      })
      .catch((error) => {
        log.warn(`Failed to persist session-timing.json for ${workspaceId}`, error);
      });

    this.pendingWrites.set(workspaceId, next);
  }
  private async getCachedTimingFile(workspaceId: string): Promise<SessionTimingFile> {
    const cached = this.timingFileCache.get(workspaceId);
    if (cached) {
      return cached;
    }

    const loaded = await this.fileLocks.withLock(workspaceId, async () => {
      return this.readTimingFile(workspaceId);
    });
    this.timingFileCache.set(workspaceId, loaded);
    return loaded;
  }

  async clearTimingFile(workspaceId: string): Promise<void> {
    // Invalidate any pending writes.
    this.writeEpoch.set(workspaceId, (this.writeEpoch.get(workspaceId) ?? 0) + 1);

    await this.fileLocks.withLock(workspaceId, async () => {
      this.timingFileCache.delete(workspaceId);
      try {
        await fs.unlink(this.getFilePath(workspaceId));
      } catch (error) {
        if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
          throw error;
        }
      }
    });

    this.emitChange(workspaceId);
  }

  getActiveStreamStats(workspaceId: string): ActiveStreamStats | undefined {
    const state = this.activeStreams.get(workspaceId);
    if (!state) return undefined;

    const now = Date.now();
    const elapsedMs = Math.max(0, now - state.startTimeMs);

    let toolExecutionMs = state.completedToolExecutionMs;
    for (const toolStart of state.pendingToolStarts.values()) {
      toolExecutionMs += Math.max(0, now - toolStart);
    }

    const ttftMs =
      state.firstTokenTimeMs !== null
        ? Math.max(0, state.firstTokenTimeMs - state.startTimeMs)
        : null;

    const modelTimeMs = Math.max(0, elapsedMs - toolExecutionMs);
    const streamingMs = Math.max(0, elapsedMs - toolExecutionMs - (ttftMs ?? 0));

    const validation = validateTiming({
      totalDurationMs: elapsedMs,
      toolExecutionMs,
      ttftMs,
      modelTimeMs,
      streamingMs,
    });

    const stats: ActiveStreamStats = {
      messageId: state.messageId,
      model: state.model,
      mode: state.mode,
      elapsedMs,
      ttftMs,
      toolExecutionMs,
      modelTimeMs,
      streamingMs,
      outputTokens: state.outputTokensByDelta,
      reasoningTokens: state.reasoningTokensByDelta,
      liveTokenCount: state.deltaStorage.getTokenCount(),
      liveTPS: state.deltaStorage.calculateTPS(now),
      invalid: validation.invalid,
      anomalies: validation.anomalies,
    };

    return ActiveStreamStatsSchema.parse(stats);
  }

  async getSnapshot(workspaceId: string): Promise<WorkspaceStatsSnapshot> {
    const file = await this.getCachedTimingFile(workspaceId);
    const active = this.getActiveStreamStats(workspaceId);

    return {
      workspaceId,
      generatedAt: Date.now(),
      active,
      lastRequest: file.lastRequest,
      session: file.session,
    };
  }

  // --- Stream event handlers (wired from AIService) ---

  handleStreamStart(data: StreamStartEvent): void {
    if (!this.isEnabled()) return;

    assert(typeof data.workspaceId === "string" && data.workspaceId.length > 0);
    assert(typeof data.messageId === "string" && data.messageId.length > 0);

    const model = normalizeGatewayModel(data.model);

    const state: ActiveStreamState = {
      workspaceId: data.workspaceId,
      messageId: data.messageId,
      model,
      mode: data.mode,
      startTimeMs: data.startTime,
      firstTokenTimeMs: null,
      completedToolExecutionMs: 0,
      pendingToolStarts: new Map(),
      outputTokensByDelta: 0,
      reasoningTokensByDelta: 0,
      deltaStorage: createDeltaStorage(),
      lastEventTimestampMs: data.startTime,
    };

    this.activeStreams.set(data.workspaceId, state);
    this.emitChange(data.workspaceId);
  }

  handleStreamDelta(data: StreamDeltaEvent): void {
    const state = this.activeStreams.get(data.workspaceId);
    if (!state) return;

    state.lastEventTimestampMs = Math.max(state.lastEventTimestampMs, data.timestamp);

    if (data.delta.length > 0 && state.firstTokenTimeMs === null) {
      state.firstTokenTimeMs = data.timestamp;
      this.emitChange(data.workspaceId);
    }

    state.outputTokensByDelta += data.tokens;
    state.deltaStorage.addDelta({ tokens: data.tokens, timestamp: data.timestamp, type: "text" });

    this.emitChange(data.workspaceId);
  }

  handleReasoningDelta(data: ReasoningDeltaEvent): void {
    const state = this.activeStreams.get(data.workspaceId);
    if (!state) return;

    state.lastEventTimestampMs = Math.max(state.lastEventTimestampMs, data.timestamp);

    if (data.delta.length > 0 && state.firstTokenTimeMs === null) {
      state.firstTokenTimeMs = data.timestamp;
      this.emitChange(data.workspaceId);
    }

    state.reasoningTokensByDelta += data.tokens;
    state.deltaStorage.addDelta({
      tokens: data.tokens,
      timestamp: data.timestamp,
      type: "reasoning",
    });

    this.emitChange(data.workspaceId);
  }

  handleToolCallStart(data: ToolCallStartEvent): void {
    const state = this.activeStreams.get(data.workspaceId);
    if (!state) return;

    state.lastEventTimestampMs = Math.max(state.lastEventTimestampMs, data.timestamp);
    state.pendingToolStarts.set(data.toolCallId, data.timestamp);

    // Tool args contribute to the visible token count + TPS.
    state.deltaStorage.addDelta({
      tokens: data.tokens,
      timestamp: data.timestamp,
      type: "tool-args",
    });

    this.emitChange(data.workspaceId);
  }

  handleToolCallDelta(data: ToolCallDeltaEvent): void {
    const state = this.activeStreams.get(data.workspaceId);
    if (!state) return;

    state.lastEventTimestampMs = Math.max(state.lastEventTimestampMs, data.timestamp);
    state.deltaStorage.addDelta({
      tokens: data.tokens,
      timestamp: data.timestamp,
      type: "tool-args",
    });

    this.emitChange(data.workspaceId);
  }

  handleToolCallEnd(data: ToolCallEndEvent): void {
    const state = this.activeStreams.get(data.workspaceId);
    if (!state) return;

    state.lastEventTimestampMs = Math.max(state.lastEventTimestampMs, data.timestamp);

    const start = state.pendingToolStarts.get(data.toolCallId);
    if (start !== undefined) {
      state.completedToolExecutionMs += Math.max(0, data.timestamp - start);
      state.pendingToolStarts.delete(data.toolCallId);
    }

    this.emitChange(data.workspaceId);
  }

  handleStreamAbort(data: StreamAbortEvent): void {
    // We currently ignore aborted streams for session timing.
    this.activeStreams.delete(data.workspaceId);
    this.emitChange(data.workspaceId);
  }

  handleStreamEnd(data: StreamEndEvent): void {
    const state = this.activeStreams.get(data.workspaceId);
    if (!state) {
      return;
    }

    // Stop tracking active stream state immediately.
    this.activeStreams.delete(data.workspaceId);

    const durationMs =
      typeof data.metadata.duration === "number" && Number.isFinite(data.metadata.duration)
        ? data.metadata.duration
        : Math.max(0, Date.now() - state.startTimeMs);

    // Include time for any in-flight tools (should not happen, but keep defensive).
    let toolExecutionMs = state.completedToolExecutionMs;
    const endTimestamp = Math.max(state.lastEventTimestampMs, state.startTimeMs + durationMs);
    for (const toolStart of state.pendingToolStarts.values()) {
      toolExecutionMs += Math.max(0, endTimestamp - toolStart);
    }

    const ttftMs =
      state.firstTokenTimeMs !== null
        ? Math.max(0, state.firstTokenTimeMs - state.startTimeMs)
        : null;

    const modelTimeMs = Math.max(0, durationMs - toolExecutionMs);
    const streamingMs = Math.max(0, durationMs - toolExecutionMs - (ttftMs ?? 0));

    const usage = data.metadata.usage;
    const outputTokens =
      typeof usage?.outputTokens === "number" ? usage.outputTokens : state.outputTokensByDelta;
    const reasoningTokens =
      typeof usage?.reasoningTokens === "number"
        ? usage.reasoningTokens
        : state.reasoningTokensByDelta;

    const validation = validateTiming({
      totalDurationMs: durationMs,
      toolExecutionMs,
      ttftMs,
      modelTimeMs,
      streamingMs,
    });

    const completed = {
      messageId: data.messageId,
      model: state.model,
      mode: state.mode,
      totalDurationMs: durationMs,
      ttftMs,
      toolExecutionMs,
      modelTimeMs,
      streamingMs,
      outputTokens,
      reasoningTokens,
      invalid: validation.invalid,
      anomalies: validation.anomalies,
    };

    const completedValidated = CompletedStreamStatsSchema.parse(completed);

    // Optimistically update cache so subscribers see the updated session immediately.
    const cached = this.timingFileCache.get(data.workspaceId);
    if (cached) {
      this.applyCompletedStreamToFile(cached, completedValidated);
    }

    this.queuePersistCompletedStream(data.workspaceId, completedValidated);

    this.emitChange(data.workspaceId);
  }
}
