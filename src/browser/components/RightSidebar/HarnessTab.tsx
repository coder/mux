import React from "react";

import { Button } from "@/browser/components/ui/button";
import { useAPI, type APIClient } from "@/browser/contexts/API";
import type {
  HarnessGateRunResult,
  HarnessLoopState,
  GitCheckpointResult,
  WorkspaceHarnessConfig,
} from "@/common/types/harness";

interface HarnessGetData {
  config: WorkspaceHarnessConfig;
  paths: { configPath: string; progressPath: string };
  exists: boolean;
  lastGateRun: HarnessGateRunResult | null;
  lastCheckpoint: GitCheckpointResult | null;
  loopState: HarnessLoopState;
}

function formatChecklistStatus(status: string): string {
  if (status === "done") return "[x]";
  if (status === "doing") return "[~]";
  if (status === "blocked") return "[!]";
  return "[ ]";
}

function formatTimestamp(ts: number | null | undefined): string {
  if (!ts) return "—";
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return String(ts);
  }
}

export function HarnessTab(props: { workspaceId: string }): React.ReactNode {
  const apiState = useAPI();

  const [data, setData] = React.useState<HarnessGetData | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const refresh = React.useCallback(async () => {
    if (!apiState.api) return;

    setError(null);
    try {
      const result = await apiState.api.workspace.harness.get({ workspaceId: props.workspaceId });
      if (!result.success) {
        setError(result.error);
        return;
      }
      setData(result.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [apiState.api, props.workspaceId]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  // Keep loop state live while the tab is mounted.
  React.useEffect(() => {
    const api = apiState.api;
    if (!api) return;

    const abortController = new AbortController();
    const { signal } = abortController;

    (async () => {
      try {
        const iterator = await api.workspace.loop.subscribe(
          { workspaceId: props.workspaceId },
          { signal }
        );

        for await (const loopState of iterator) {
          if (signal.aborted) break;
          setData((prev) => (prev ? { ...prev, loopState } : prev));
        }
      } catch (err) {
        if (!signal.aborted) {
          console.error("Failed to subscribe to loop state:", err);
        }
      }
    })();

    return () => abortController.abort();
  }, [apiState.api, props.workspaceId]);

  const runAction = React.useCallback(
    async (fn: (api: APIClient) => Promise<void>) => {
      const api = apiState.api;
      if (!api) return;

      setBusy(true);
      setError(null);
      try {
        await fn(api);
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [apiState.api, refresh]
  );

  if (apiState.status !== "connected" && apiState.status !== "degraded") {
    return (
      <div className="text-light font-primary text-[13px] leading-relaxed">
        <div className="text-secondary px-5 py-10 text-center">
          <p>API not connected.</p>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="text-light font-primary text-[13px] leading-relaxed">
        <div className="flex items-center justify-between">
          <h3 className="m-0 text-sm font-medium">Harness</h3>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void refresh()}>
            Refresh
          </Button>
        </div>
        {error && <div className="text-error mt-3 text-xs">{error}</div>}
        <div className="text-secondary px-5 py-10 text-center">Loading…</div>
      </div>
    );
  }

  const loopState = data.loopState;

  return (
    <div className="text-light font-primary text-[13px] leading-relaxed">
      <div className="flex items-center justify-between gap-2">
        <h3 className="m-0 text-sm font-medium">Harness</h3>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void refresh()}>
            Refresh
          </Button>
        </div>
      </div>

      {error && <div className="text-error mt-3 text-xs">{error}</div>}

      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="secondary"
          disabled={busy}
          onClick={() =>
            void runAction(async (api) => {
              const result = await api.workspace.harness.runGates({
                workspaceId: props.workspaceId,
              });
              if (!result.success) throw new Error(result.error);
            })
          }
        >
          Run gates
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={busy}
          onClick={() =>
            void runAction(async (api) => {
              const result = await api.workspace.harness.checkpoint({
                workspaceId: props.workspaceId,
              });
              if (!result.success) throw new Error(result.error);
            })
          }
        >
          Checkpoint
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() =>
            void runAction(async (api) => {
              const result = await api.workspace.harness.resetContext({
                workspaceId: props.workspaceId,
              });
              if (!result.success) throw new Error(result.error);
            })
          }
        >
          Reset context
        </Button>
      </div>

      <div className="border-border-light mt-4 rounded border p-3">
        <div className="text-secondary text-xs">Files</div>
        <div className="mt-1 font-mono text-xs">
          <div>{data.paths.progressPath}</div>
          <div>{data.paths.configPath}</div>
        </div>
        {!data.exists && (
          <div className="text-secondary mt-2 text-xs">
            No harness file yet. Create it by editing the config path above.
          </div>
        )}
      </div>

      <div className="border-border-light mt-4 rounded border p-3">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-secondary text-xs">Loop</div>
            <div className="mt-1 text-sm">
              {loopState.status} • iteration {loopState.iteration}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {loopState.status !== "running" ? (
              <Button
                size="sm"
                disabled={busy}
                onClick={() =>
                  void runAction(async (api) => {
                    const result = await api.workspace.loop.start({
                      workspaceId: props.workspaceId,
                    });
                    if (!result.success) throw new Error(result.error);
                  })
                }
              >
                Start
              </Button>
            ) : (
              <Button
                size="sm"
                variant="secondary"
                disabled={busy}
                onClick={() =>
                  void runAction(async (api) => {
                    const result = await api.workspace.loop.pause({
                      workspaceId: props.workspaceId,
                    });
                    if (!result.success) throw new Error(result.error);
                  })
                }
              >
                Pause
              </Button>
            )}
            <Button
              size="sm"
              variant="destructive"
              disabled={busy}
              onClick={() =>
                void runAction(async (api) => {
                  const result = await api.workspace.loop.stop({
                    workspaceId: props.workspaceId,
                  });
                  if (!result.success) throw new Error(result.error);
                })
              }
            >
              Stop
            </Button>
          </div>
        </div>

        <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
          <div>
            <div className="text-secondary">Started</div>
            <div>{formatTimestamp(loopState.startedAt)}</div>
          </div>
          <div>
            <div className="text-secondary">Failures</div>
            <div>{loopState.consecutiveFailures}</div>
          </div>
          <div>
            <div className="text-secondary">Current item</div>
            <div>{loopState.currentItemTitle ?? "—"}</div>
          </div>
          <div>
            <div className="text-secondary">Stopped reason</div>
            <div>{loopState.stoppedReason ?? "—"}</div>
          </div>
        </div>
      </div>

      <div className="border-border-light mt-4 rounded border p-3">
        <div className="text-secondary text-xs">Checklist</div>
        <div className="mt-2">
          {data.config.checklist.length === 0 ? (
            <div className="text-secondary text-xs">(no checklist items)</div>
          ) : (
            <ul className="m-0 list-none p-0">
              {data.config.checklist.map((item) => (
                <li key={item.id} className="py-0.5">
                  <span className="font-mono text-xs">{formatChecklistStatus(item.status)}</span>{" "}
                  {item.title}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="border-border-light mt-4 rounded border p-3">
        <div className="text-secondary text-xs">Last gates</div>
        <div className="mt-1 text-xs">
          {data.lastGateRun ? (
            <>
              <div>
                {data.lastGateRun.ok ? "PASS" : "FAIL"} •{" "}
                {Math.round(data.lastGateRun.totalDurationMs / 1000)}s • finished{" "}
                {formatTimestamp(data.lastGateRun.finishedAt)}
              </div>
              {data.lastGateRun.results.length > 0 && (
                <details className="mt-2">
                  <summary className="cursor-pointer">Details</summary>
                  <div className="mt-2 flex flex-col gap-2">
                    {data.lastGateRun.results.map((r, idx) => (
                      <div key={`${idx}:${r.command}`} className="rounded bg-black/20 p-2">
                        <div className="font-mono text-xs">{r.command}</div>
                        <div className="text-secondary text-xs">exit {r.exitCode}</div>
                        {(r.stderr || r.stdout) && (
                          <pre className="mt-1 max-h-48 overflow-auto text-xs whitespace-pre-wrap">
                            {(r.stderr ? `stderr:\n${r.stderr}\n` : "") +
                              (r.stdout ? `stdout:\n${r.stdout}` : "")}
                          </pre>
                        )}
                      </div>
                    ))}
                  </div>
                </details>
              )}
            </>
          ) : (
            <div className="text-secondary">(not run yet)</div>
          )}
        </div>
      </div>

      <div className="border-border-light mt-4 rounded border p-3">
        <div className="text-secondary text-xs">Last checkpoint</div>
        <div className="mt-1 text-xs">
          {data.lastCheckpoint ? (
            <>
              <div>{data.lastCheckpoint.committed ? "Committed" : "No changes"}</div>
              <div className="font-mono">{data.lastCheckpoint.commitSha ?? "—"}</div>
              <div className="text-secondary">{data.lastCheckpoint.commitMessage ?? "—"}</div>
            </>
          ) : (
            <div className="text-secondary">(none)</div>
          )}
        </div>
      </div>
    </div>
  );
}
