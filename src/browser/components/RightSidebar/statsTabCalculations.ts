import type { SessionTimingStats, StreamTimingStats } from "@/browser/stores/WorkspaceStore";
import { calculateAverageTPS } from "@/browser/utils/messages/StreamingTPSCalculator";
import { formatModelDisplayName } from "@/common/utils/ai/modelDisplay";

export type StatsViewMode = "session" | "last-request";

export interface StatsTabDisplayData {
  totalDuration: number;
  ttft: number | null;
  toolExecutionMs: number;
  modelTime: number;
  isActive: boolean;
  responseCount?: number;
  /** True if waiting for current request's TTFT */
  waitingForTtft?: boolean;
}

export interface ModelBreakdownEntry {
  model: string;
  displayName: string;
  totalDuration: number;
  toolExecutionMs: number;
  modelTime: number;
  avgTtft: number | null;
  responseCount: number;
  totalOutputTokens: number;
  totalReasoningTokens: number;
  tokensPerSec: number | null;
  avgTokensPerMsg: number | null;
  avgReasoningPerMsg: number | null;
  mode?: "plan" | "exec";
}

export interface ModelBreakdownData {
  /** Per-model+mode entries (no consolidation; keys may be model:mode) */
  byKey: ModelBreakdownEntry[];
  /** Consolidated per-model entries (mode ignored) */
  byModel: ModelBreakdownEntry[];
  /** Whether any entries have explicit mode (plan/exec) */
  hasModeData: boolean;
}

export function computeStatsTabDisplayData(params: {
  viewMode: StatsViewMode;
  timingStats: StreamTimingStats | null;
  sessionStats: SessionTimingStats | null;
  now: number;
}): StatsTabDisplayData {
  if (params.viewMode === "session") {
    // Session view: aggregate completed stats + active stream (if present)
    const baseTotal = params.sessionStats?.totalDurationMs ?? 0;
    const baseToolMs = params.sessionStats?.totalToolExecutionMs ?? 0;
    const baseResponseCount = params.sessionStats?.responseCount ?? 0;

    let baseTtftSum = 0;
    let baseTtftCount = 0;
    if (params.sessionStats?.averageTtftMs !== null && params.sessionStats?.responseCount) {
      baseTtftSum = params.sessionStats.averageTtftMs * params.sessionStats.responseCount;
      baseTtftCount = params.sessionStats.responseCount;
    }

    // Add live stats from active stream
    let liveElapsed = 0;
    let liveToolMs = 0;
    let liveTtft: number | null = null;
    let isActive = false;

    if (params.timingStats?.isActive) {
      liveElapsed = params.now - params.timingStats.startTime;
      liveToolMs = params.timingStats.toolExecutionMs;
      isActive = true;

      if (params.timingStats.firstTokenTime !== null) {
        liveTtft = params.timingStats.firstTokenTime - params.timingStats.startTime;
      }
    }

    const totalDuration = baseTotal + liveElapsed;
    const totalToolMs = baseToolMs + liveToolMs;

    // Recalculate average TTFT including the active stream once it has a first token.
    let avgTtft: number | null = null;
    if (liveTtft !== null) {
      avgTtft = (baseTtftSum + liveTtft) / (baseTtftCount + 1);
    } else if (baseTtftCount > 0) {
      avgTtft = baseTtftSum / baseTtftCount;
    }

    return {
      totalDuration,
      ttft: avgTtft,
      toolExecutionMs: totalToolMs,
      modelTime: Math.max(0, totalDuration - totalToolMs),
      isActive,
      responseCount: baseResponseCount + (isActive ? 1 : 0),
      waitingForTtft: isActive && liveTtft === null,
    };
  }

  // Last Request view
  if (!params.timingStats) {
    return {
      totalDuration: 0,
      ttft: null,
      toolExecutionMs: 0,
      modelTime: 0,
      isActive: false,
    };
  }

  const elapsed = params.timingStats.isActive
    ? params.now - params.timingStats.startTime
    : params.timingStats.endTime! - params.timingStats.startTime;

  return {
    totalDuration: elapsed,
    ttft:
      params.timingStats.firstTokenTime !== null
        ? params.timingStats.firstTokenTime - params.timingStats.startTime
        : null,
    toolExecutionMs: params.timingStats.toolExecutionMs,
    modelTime: Math.max(0, elapsed - params.timingStats.toolExecutionMs),
    isActive: params.timingStats.isActive,
  };
}

function getModelDisplayName(model: string): string {
  // Extract model name from "provider:model-name" or "mux-gateway:provider/model-name" format
  const colonIndex = model.indexOf(":");
  const afterProvider = colonIndex >= 0 ? model.slice(colonIndex + 1) : model;

  // For mux-gateway format, extract the actual model name after the slash
  const slashIndex = afterProvider.indexOf("/");
  const modelName = slashIndex >= 0 ? afterProvider.slice(slashIndex + 1) : afterProvider;

  return formatModelDisplayName(modelName);
}

const MODE_SUFFIX_PLAN = ":plan" as const;
const MODE_SUFFIX_EXEC = ":exec" as const;

function parseStatsKey(key: string): { model: string; mode?: "plan" | "exec" } {
  if (key.endsWith(MODE_SUFFIX_PLAN)) {
    return { model: key.slice(0, -MODE_SUFFIX_PLAN.length), mode: "plan" };
  }
  if (key.endsWith(MODE_SUFFIX_EXEC)) {
    return { model: key.slice(0, -MODE_SUFFIX_EXEC.length), mode: "exec" };
  }
  return { model: key };
}

export function computeModelBreakdownData(params: {
  viewMode: StatsViewMode;
  timingStats: StreamTimingStats | null;
  sessionStats: SessionTimingStats | null;
  now: number;
}): ModelBreakdownData {
  if (params.viewMode !== "session") {
    if (!params.timingStats) {
      return { byKey: [], byModel: [], hasModeData: false };
    }

    const elapsed = params.timingStats.isActive
      ? params.now - params.timingStats.startTime
      : params.timingStats.endTime! - params.timingStats.startTime;
    const modelTime = Math.max(0, elapsed - params.timingStats.toolExecutionMs);
    const ttft =
      params.timingStats.firstTokenTime !== null
        ? params.timingStats.firstTokenTime - params.timingStats.startTime
        : null;

    const outputTokens = params.timingStats.isActive
      ? (params.timingStats.liveTokenCount ?? 0)
      : (params.timingStats.outputTokens ?? 0);
    const reasoningTokens = params.timingStats.reasoningTokens ?? 0;

    const rawStreamingMs = params.timingStats.isActive
      ? params.timingStats.firstTokenTime !== null
        ? params.now - params.timingStats.firstTokenTime
        : 0
      : (params.timingStats.streamingMs ?? 0);
    const streamingMs = params.timingStats.isActive
      ? Math.max(0, rawStreamingMs - params.timingStats.toolExecutionMs)
      : rawStreamingMs;

    const tokensPerSec = calculateAverageTPS(
      streamingMs,
      modelTime,
      outputTokens,
      params.timingStats.isActive ? (params.timingStats.liveTPS ?? null) : null
    );

    const entry: ModelBreakdownEntry = {
      model: params.timingStats.model,
      displayName: getModelDisplayName(params.timingStats.model),
      totalDuration: elapsed,
      toolExecutionMs: params.timingStats.toolExecutionMs,
      modelTime,
      avgTtft: ttft,
      responseCount: 1,
      totalOutputTokens: outputTokens,
      totalReasoningTokens: reasoningTokens,
      tokensPerSec,
      avgTokensPerMsg: outputTokens > 0 ? outputTokens : null,
      avgReasoningPerMsg: reasoningTokens > 0 ? reasoningTokens : null,
      mode: params.timingStats.mode,
    };

    return { byKey: [entry], byModel: [entry], hasModeData: false };
  }

  interface BreakdownEntry {
    totalDuration: number;
    toolExecutionMs: number;
    streamingMs: number;
    responseCount: number;
    totalOutputTokens: number;
    totalReasoningTokens: number;
    ttftSum: number;
    ttftCount: number;
    liveTPS: number | null;
    liveTokenCount: number;
    mode?: "plan" | "exec";
  }

  const breakdown: Record<string, BreakdownEntry> = {};

  if (params.sessionStats?.byModel) {
    for (const [key, stats] of Object.entries(params.sessionStats.byModel)) {
      breakdown[key] = {
        totalDuration: stats.totalDurationMs,
        toolExecutionMs: stats.totalToolExecutionMs,
        streamingMs: stats.totalStreamingMs,
        responseCount: stats.responseCount,
        totalOutputTokens: stats.totalOutputTokens,
        totalReasoningTokens: stats.totalReasoningTokens,
        ttftSum: stats.averageTtftMs !== null ? stats.averageTtftMs * stats.responseCount : 0,
        ttftCount: stats.averageTtftMs !== null ? stats.responseCount : 0,
        liveTPS: null,
        liveTokenCount: 0,
        mode: stats.mode,
      };
    }
  }

  if (params.timingStats?.isActive) {
    const activeMode = params.timingStats.mode;
    const activeKey = activeMode
      ? `${params.timingStats.model}:${activeMode}`
      : params.timingStats.model;
    const liveElapsed = params.now - params.timingStats.startTime;
    const rawStreamingMs =
      params.timingStats.firstTokenTime !== null
        ? params.now - params.timingStats.firstTokenTime
        : 0;
    const liveStreamingMs = Math.max(0, rawStreamingMs - params.timingStats.toolExecutionMs);

    const existing = breakdown[activeKey] ?? {
      totalDuration: 0,
      toolExecutionMs: 0,
      streamingMs: 0,
      responseCount: 0,
      totalOutputTokens: 0,
      totalReasoningTokens: 0,
      ttftSum: 0,
      ttftCount: 0,
      liveTPS: null,
      liveTokenCount: 0,
      mode: activeMode,
    };

    existing.totalDuration += liveElapsed;
    existing.toolExecutionMs += params.timingStats.toolExecutionMs;
    existing.streamingMs += liveStreamingMs;
    existing.responseCount += 1;
    existing.liveTokenCount = params.timingStats.liveTokenCount ?? 0;
    existing.totalOutputTokens += existing.liveTokenCount;
    existing.liveTPS = params.timingStats.liveTPS ?? null;
    if (params.timingStats.firstTokenTime !== null) {
      existing.ttftSum += params.timingStats.firstTokenTime - params.timingStats.startTime;
      existing.ttftCount += 1;
    }

    breakdown[activeKey] = existing;
  }

  const toModelBreakdownEntry = (
    model: string,
    stats: BreakdownEntry,
    mode?: "plan" | "exec"
  ): ModelBreakdownEntry => {
    const modelTime = Math.max(0, stats.totalDuration - stats.toolExecutionMs);
    const avgTtft = stats.ttftCount > 0 ? stats.ttftSum / stats.ttftCount : null;
    const tokensPerSec = calculateAverageTPS(
      stats.streamingMs,
      modelTime,
      stats.totalOutputTokens,
      stats.liveTPS
    );
    const avgTokensPerMsg =
      stats.responseCount > 0 && stats.totalOutputTokens > 0
        ? Math.round(stats.totalOutputTokens / stats.responseCount)
        : null;
    const avgReasoningPerMsg =
      stats.responseCount > 0 && stats.totalReasoningTokens > 0
        ? Math.round(stats.totalReasoningTokens / stats.responseCount)
        : null;

    return {
      model,
      displayName: getModelDisplayName(model),
      totalDuration: stats.totalDuration,
      toolExecutionMs: stats.toolExecutionMs,
      modelTime,
      avgTtft,
      responseCount: stats.responseCount,
      totalOutputTokens: stats.totalOutputTokens,
      totalReasoningTokens: stats.totalReasoningTokens,
      tokensPerSec,
      avgTokensPerMsg,
      avgReasoningPerMsg,
      mode,
    };
  };

  const byKey = Object.entries(breakdown).map(([key, stats]) => {
    const { model, mode } = parseStatsKey(key);
    return toModelBreakdownEntry(model, stats, mode ?? stats.mode);
  });

  const consolidated: Record<string, BreakdownEntry> = {};
  for (const [key, stats] of Object.entries(breakdown)) {
    const { model } = parseStatsKey(key);
    const existing = consolidated[model] ?? {
      totalDuration: 0,
      toolExecutionMs: 0,
      streamingMs: 0,
      responseCount: 0,
      totalOutputTokens: 0,
      totalReasoningTokens: 0,
      ttftSum: 0,
      ttftCount: 0,
      liveTPS: null,
      liveTokenCount: 0,
    };

    existing.totalDuration += stats.totalDuration;
    existing.toolExecutionMs += stats.toolExecutionMs;
    existing.streamingMs += stats.streamingMs;
    existing.responseCount += stats.responseCount;
    existing.totalOutputTokens += stats.totalOutputTokens;
    existing.totalReasoningTokens += stats.totalReasoningTokens;
    existing.ttftSum += stats.ttftSum;
    existing.ttftCount += stats.ttftCount;

    // Preserve live data if present (only expected for the active stream)
    existing.liveTPS = stats.liveTPS ?? existing.liveTPS;
    existing.liveTokenCount += stats.liveTokenCount;

    consolidated[model] = existing;
  }

  const byModel = Object.entries(consolidated).map(([model, stats]) => {
    return toModelBreakdownEntry(model, stats);
  });

  const hasModeData = byKey.some((m) => m.mode);

  return { byKey, byModel, hasModeData };
}
