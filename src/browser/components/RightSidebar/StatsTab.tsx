import React from "react";

import { usePersistedState } from "@/browser/hooks/usePersistedState";
import { useWorkspaceStatsSnapshot } from "@/browser/stores/WorkspaceStore";
import { ToggleGroup, type ToggleOption } from "../ToggleGroup";
import { useTelemetry } from "@/browser/hooks/useTelemetry";
import { calculateAverageTPS } from "@/browser/utils/messages/StreamingTPSCalculator";

// Colors for timing components (matching TOKEN_COMPONENT_COLORS style)
const TIMING_COLORS = {
  ttft: "#f59e0b", // amber - waiting for first token
  model: "#3b82f6", // blue - model inference
  tools: "#10b981", // green - tool execution
} as const;

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 10000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  const mins = Math.floor(ms / 60000);
  const secs = Math.round((ms % 60000) / 1000);
  return `${mins}m ${secs}s`;
}

function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  return `${(tokens / 1000).toFixed(1)}k`;
}

type ViewMode = "session" | "last-request";

const VIEW_MODE_OPTIONS: Array<ToggleOption<ViewMode>> = [
  { value: "session", label: "Session" },
  { value: "last-request", label: "Last Request" },
];

interface ModelBreakdownEntry {
  key: string;
  model: string;
  mode?: "plan" | "exec";
  totalDurationMs: number;
  totalToolExecutionMs: number;
  totalStreamingMs: number;
  totalTtftMs: number;
  ttftCount: number;
  responseCount: number;
  totalOutputTokens: number;
  totalReasoningTokens: number;
}

function computeAverageTtft(totalTtftMs: number, ttftCount: number): number | null {
  if (ttftCount <= 0) return null;
  return totalTtftMs / ttftCount;
}

export function StatsTab(props: { workspaceId: string }) {
  const snapshot = useWorkspaceStatsSnapshot(props.workspaceId);
  const telemetry = useTelemetry();
  const [viewMode, setViewMode] = usePersistedState<ViewMode>("statsTab:viewMode", "session");
  const [showModeBreakdown, setShowModeBreakdown] = usePersistedState<boolean>(
    "statsTab:showModeBreakdown",
    false
  );

  React.useEffect(() => {
    telemetry.statsTabOpened(viewMode, showModeBreakdown);
  }, [telemetry, viewMode, showModeBreakdown]);

  const active = snapshot?.active;
  const session = snapshot?.session;
  const lastRequest = snapshot?.lastRequest;

  const hasAnyData =
    active !== undefined || lastRequest !== undefined || (session?.responseCount ?? 0) > 0;

  const onClearStats = async (): Promise<void> => {
    const client = window.__ORPC_CLIENT__;
    if (!client) throw new Error("ORPC client not initialized");
    await client.workspace.stats.clear({ workspaceId: props.workspaceId });
  };

  if (!hasAnyData) {
    return (
      <div className="text-light font-primary text-[13px] leading-relaxed">
        <div className="text-secondary px-5 py-10 text-center">
          <p>No timing data yet.</p>
          <p>Send a message to see timing statistics.</p>
        </div>
      </div>
    );
  }

  // --- Timing data selection ---

  const sessionTotalDuration = (session?.totalDurationMs ?? 0) + (active?.elapsedMs ?? 0);
  const sessionToolExecutionMs =
    (session?.totalToolExecutionMs ?? 0) + (active?.toolExecutionMs ?? 0);
  // Includes TTFT (used as a fallback for TPS when streaming time is unavailable/corrupted).
  const sessionModelTimeMs = Math.max(0, sessionTotalDuration - sessionToolExecutionMs);
  const sessionStreamingMs = (session?.totalStreamingMs ?? 0) + (active?.streamingMs ?? 0);
  const sessionAvgTtftMs = computeAverageTtft(session?.totalTtftMs ?? 0, session?.ttftCount ?? 0);
  const sessionTotalTtftMs = (session?.totalTtftMs ?? 0) + (active?.ttftMs ?? 0);

  const lastData = active ?? lastRequest;
  const isActive = Boolean(active);

  const lastTotalDuration = active ? active.elapsedMs : (lastRequest?.totalDurationMs ?? 0);
  const lastToolExecutionMs = active ? active.toolExecutionMs : (lastRequest?.toolExecutionMs ?? 0);
  // Includes TTFT (used as a fallback for TPS when streaming time is unavailable/corrupted).
  const lastModelTimeMs = active
    ? active.modelTimeMs
    : (lastRequest?.modelTimeMs ?? Math.max(0, lastTotalDuration - lastToolExecutionMs));
  const lastStreamingMs = active ? active.streamingMs : (lastRequest?.streamingMs ?? 0);
  const lastTtftMs = active ? active.ttftMs : (lastRequest?.ttftMs ?? null);

  const totalDuration = viewMode === "session" ? sessionTotalDuration : lastTotalDuration;
  const toolExecutionMs = viewMode === "session" ? sessionToolExecutionMs : lastToolExecutionMs;
  const modelTimeMs = viewMode === "session" ? sessionModelTimeMs : lastModelTimeMs;
  const streamingMs = viewMode === "session" ? sessionStreamingMs : lastStreamingMs;
  const ttftMs = viewMode === "session" ? sessionAvgTtftMs : lastTtftMs;
  const ttftMsForBar = viewMode === "session" ? sessionTotalTtftMs : (lastTtftMs ?? 0);

  // Stats snapshot provides both modelTime (includes TTFT) and streaming time.
  // For display breakdowns, prefer streaming time so TTFT isn't double-counted.
  const modelDisplayMs = streamingMs;

  const waitingForTtft = viewMode === "last-request" && isActive && active?.ttftMs === null;

  const toolPercentage = totalDuration > 0 ? (toolExecutionMs / totalDuration) * 100 : 0;
  const modelPercentage = totalDuration > 0 ? (modelDisplayMs / totalDuration) * 100 : 0;
  const ttftPercentage = totalDuration > 0 ? (ttftMsForBar / totalDuration) * 100 : 0;

  const totalTokensForView = (() => {
    if (viewMode === "session") {
      const output = session?.totalOutputTokens ?? 0;
      const reasoning = session?.totalReasoningTokens ?? 0;
      return output + reasoning;
    }

    const output = lastData?.outputTokens ?? 0;
    const reasoning = lastData?.reasoningTokens ?? 0;
    return output + reasoning;
  })();

  const avgTPS = calculateAverageTPS(
    streamingMs,
    modelTimeMs,
    totalTokensForView,
    viewMode === "last-request" ? (active?.liveTPS ?? null) : null
  );

  const components = [
    {
      name: viewMode === "session" ? "Avg. Time to First Token" : "Time to First Token",
      duration: ttftMs,
      color: TIMING_COLORS.ttft,
      show: ttftMs !== null || waitingForTtft,
      waiting: waitingForTtft,
    },
    {
      name: "Model Time",
      duration: modelDisplayMs,
      color: TIMING_COLORS.model,
      show: true,
      percentage: modelPercentage,
    },
    {
      name: "Tool Execution",
      duration: toolExecutionMs,
      color: TIMING_COLORS.tools,
      show: toolExecutionMs > 0,
      percentage: toolPercentage,
    },
  ].filter((c) => c.show);

  // --- Per-model breakdown (session view only) ---

  const modelEntries: ModelBreakdownEntry[] = (() => {
    if (!session) return [];
    return Object.entries(session.byModel).map(([key, entry]) => ({ key, ...entry }));
  })();

  const hasModeData = modelEntries.some((e) => e.mode !== undefined);

  const consolidatedByModel: ModelBreakdownEntry[] = (() => {
    const byModel = new Map<string, ModelBreakdownEntry>();

    for (const entry of modelEntries) {
      const existing = byModel.get(entry.model);
      if (!existing) {
        byModel.set(entry.model, {
          ...entry,
          key: entry.model,
          mode: undefined,
        });
        continue;
      }

      existing.totalDurationMs += entry.totalDurationMs;
      existing.totalToolExecutionMs += entry.totalToolExecutionMs;
      existing.totalStreamingMs += entry.totalStreamingMs;
      existing.totalTtftMs += entry.totalTtftMs;
      existing.ttftCount += entry.ttftCount;
      existing.responseCount += entry.responseCount;
      existing.totalOutputTokens += entry.totalOutputTokens;
      existing.totalReasoningTokens += entry.totalReasoningTokens;
    }

    return Array.from(byModel.values());
  })();

  const breakdownToShow =
    viewMode === "session" && hasModeData && showModeBreakdown ? modelEntries : consolidatedByModel;

  breakdownToShow.sort((a, b) => b.totalDurationMs - a.totalDurationMs);

  // --- Render ---

  return (
    <div className="text-light font-primary text-[13px] leading-relaxed">
      <div data-testid="timing-section" className="mb-6">
        <div className="flex flex-col gap-3">
          <div data-testid="timing-header" className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-3">
              <span className="text-foreground inline-flex shrink-0 items-baseline gap-1 font-medium">
                Timing
                {isActive && <span className="text-accent ml-1 animate-pulse text-xs">●</span>}
              </span>
              <ToggleGroup options={VIEW_MODE_OPTIONS} value={viewMode} onChange={setViewMode} />
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {viewMode === "session" && (
                <button
                  type="button"
                  className="text-muted hover:text-foreground text-xs"
                  onClick={() => {
                    onClearStats().catch(() => {
                      // ignore
                    });
                  }}
                >
                  Clear stats
                </button>
              )}
              <span className="text-muted text-xs">{formatDuration(totalDuration)}</span>
            </div>
          </div>

          {viewMode === "session" && session && session.responseCount > 0 && (
            <div className="text-muted-light flex flex-wrap gap-x-3 gap-y-1 text-xs">
              <span>
                {session.responseCount} response{session.responseCount !== 1 ? "s" : ""}
              </span>
              {(session.totalOutputTokens > 0 || session.totalReasoningTokens > 0) && (
                <>
                  <span>·</span>
                  <span>{formatTokens(session.totalOutputTokens)} output tokens</span>
                  {session.totalReasoningTokens > 0 && (
                    <>
                      <span>·</span>
                      <span>{formatTokens(session.totalReasoningTokens)} thinking</span>
                    </>
                  )}
                </>
              )}
            </div>
          )}

          {lastData?.invalid && viewMode === "last-request" && (
            <div className="text-muted-light text-xs">
              Invalid timing data: {lastData.anomalies.join(", ")}
            </div>
          )}

          {avgTPS !== null && avgTPS > 0 && (
            <div className="text-muted-light text-xs">Avg. TPS: {avgTPS.toFixed(0)} tok/s</div>
          )}

          {/* Progress bar */}
          <div className="relative w-full">
            <div className="bg-border-light flex h-1.5 w-full overflow-hidden rounded-[3px]">
              {ttftPercentage > 0 && (
                <div
                  className="h-full transition-[width] duration-300"
                  style={{ width: `${ttftPercentage}%`, backgroundColor: TIMING_COLORS.ttft }}
                />
              )}
              <div
                className="h-full transition-[width] duration-300"
                style={{ width: `${modelPercentage}%`, backgroundColor: TIMING_COLORS.model }}
              />
              <div
                className="h-full transition-[width] duration-300"
                style={{ width: `${toolPercentage}%`, backgroundColor: TIMING_COLORS.tools }}
              />
            </div>
          </div>

          {/* Components table */}
          <div className="flex flex-col gap-2">
            {components.map((component) => (
              <div key={component.name} className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <div
                    className="h-2 w-2 rounded-full"
                    style={{ backgroundColor: component.color }}
                  />
                  <span className="text-secondary text-xs">{component.name}</span>
                </div>
                <div className="flex items-center gap-2">
                  {component.waiting ? (
                    <span className="text-muted text-xs">waiting…</span>
                  ) : component.duration !== null ? (
                    <span className="text-muted text-xs">{formatDuration(component.duration)}</span>
                  ) : (
                    <span className="text-muted text-xs">—</span>
                  )}
                  {component.percentage !== undefined && component.percentage > 0 && (
                    <span className="text-muted text-[10px]">
                      {component.percentage.toFixed(0)}%
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {viewMode === "session" && breakdownToShow.length > 0 && (
        <div className="mb-2">
          <div className="flex items-center justify-between">
            <span className="text-foreground text-xs font-medium">By model</span>
            {hasModeData && (
              <label className="text-muted flex items-center gap-2 text-xs select-none">
                <input
                  type="checkbox"
                  checked={showModeBreakdown}
                  onChange={(e) => setShowModeBreakdown(e.target.checked)}
                />
                Split by mode
              </label>
            )}
          </div>

          <div className="mt-3 flex flex-col gap-2">
            {breakdownToShow.map((entry) => {
              const avgTtft = computeAverageTtft(entry.totalTtftMs, entry.ttftCount);
              const tokens = entry.totalOutputTokens + entry.totalReasoningTokens;
              const entryAvgTPS = calculateAverageTPS(
                entry.totalStreamingMs,
                Math.max(0, entry.totalDurationMs - entry.totalToolExecutionMs),
                tokens,
                null
              );

              const label =
                entry.mode === "plan"
                  ? `${entry.model} (plan)`
                  : entry.mode === "exec"
                    ? `${entry.model} (exec)`
                    : entry.model;

              return (
                <div key={entry.key} className="bg-border-light/30 rounded-md px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-secondary truncate text-xs" title={label}>
                      {label}
                    </span>
                    <span className="text-muted shrink-0 text-xs">
                      {formatDuration(entry.totalDurationMs)}
                    </span>
                  </div>
                  <div className="text-muted-light mt-1 flex flex-wrap gap-x-2 gap-y-1 text-[11px]">
                    <span>{entry.responseCount} req</span>
                    {avgTtft !== null && (
                      <>
                        <span>·</span>
                        <span>TTFT {formatDuration(avgTtft)}</span>
                      </>
                    )}
                    {entryAvgTPS !== null && entryAvgTPS > 0 && (
                      <>
                        <span>·</span>
                        <span>{entryAvgTPS.toFixed(0)} tok/s</span>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
