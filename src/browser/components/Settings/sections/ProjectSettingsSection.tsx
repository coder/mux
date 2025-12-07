import React, { useCallback, useEffect, useState } from "react";
import { useAPI } from "@/browser/contexts/API";
import { useWorkspaceContext } from "@/browser/contexts/WorkspaceContext";
import { Trash2, Play, Loader2, CheckCircle, XCircle } from "lucide-react";

type TestResult = { success: true; tools: string[] } | { success: false; error: string };

export const ProjectSettingsSection: React.FC = () => {
  const { api } = useAPI();
  const { selectedWorkspace } = useWorkspaceContext();
  const projectPath = selectedWorkspace?.projectPath;

  const [servers, setServers] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testingServer, setTestingServer] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Map<string, TestResult>>(new Map());

  const refresh = useCallback(async () => {
    if (!api || !projectPath) return;
    setLoading(true);
    try {
      const result = await api.projects.mcp.list({ projectPath });
      setServers(result ?? {});
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load MCP servers");
    } finally {
      setLoading(false);
    }
  }, [api, projectPath]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleRemove = useCallback(
    async (name: string) => {
      if (!api || !projectPath) return;
      setLoading(true);
      try {
        const result = await api.projects.mcp.remove({ projectPath, name });
        if (!result.success) {
          setError(result.error ?? "Failed to remove MCP server");
        } else {
          await refresh();
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to remove MCP server");
      } finally {
        setLoading(false);
      }
    },
    [api, projectPath, refresh]
  );

  const handleTest = useCallback(
    async (name: string) => {
      if (!api || !projectPath) return;
      setTestingServer(name);
      // Clear previous result for this server
      setTestResults((prev) => {
        const next = new Map(prev);
        next.delete(name);
        return next;
      });
      try {
        const result = await api.projects.mcp.test({ projectPath, name });
        setTestResults((prev) => new Map(prev).set(name, result));
      } catch (err) {
        setTestResults((prev) =>
          new Map(prev).set(name, {
            success: false,
            error: err instanceof Error ? err.message : "Test failed",
          })
        );
      } finally {
        setTestingServer(null);
      }
    },
    [api, projectPath]
  );

  if (!projectPath) {
    return (
      <p className="text-muted-foreground text-sm">
        Select a workspace to manage project settings.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-lg font-semibold">MCP Servers</h3>
        <p className="text-muted-foreground text-sm">
          Servers are stored in <code>.mux/mcp.jsonc</code> in this project. Use{" "}
          <code>/mcp add</code> to add new entries.
        </p>
      </div>

      {error && <p className="text-destructive text-sm">{error}</p>}

      {loading && <p className="text-muted-foreground text-sm">Loading…</p>}

      {!loading && Object.keys(servers).length === 0 && (
        <p className="text-muted-foreground text-sm">No MCP servers configured.</p>
      )}

      <ul className="space-y-2">
        {Object.entries(servers).map(([name, command]) => {
          const isTesting = testingServer === name;
          const testResult = testResults.get(name);
          return (
            <li
              key={name}
              className="border-border-medium/60 bg-secondary/30 rounded-md border px-3 py-2"
            >
              <div className="flex items-start justify-between">
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="font-medium">{name}</div>
                  <div className="text-muted-foreground text-xs break-all">{command}</div>
                </div>
                <div className="ml-2 flex shrink-0 items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void handleTest(name)}
                    className="text-muted-foreground hover:text-accent flex items-center gap-1 text-xs disabled:opacity-50"
                    aria-label={`Test MCP server ${name}`}
                    disabled={loading || isTesting}
                  >
                    {isTesting ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Play className="h-4 w-4" />
                    )}
                    {isTesting ? "Testing…" : "Test"}
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleRemove(name)}
                    className="text-muted-foreground hover:text-destructive flex items-center gap-1 text-xs"
                    aria-label={`Remove MCP server ${name}`}
                    disabled={loading}
                  >
                    <Trash2 className="h-4 w-4" /> Remove
                  </button>
                </div>
              </div>
              {/* Test result display */}
              {testResult && (
                <div
                  className={`mt-2 flex items-start gap-1.5 text-xs ${testResult.success ? "text-green-500" : "text-destructive"}`}
                >
                  {testResult.success ? (
                    <>
                      <CheckCircle className="mt-0.5 h-3 w-3 shrink-0" />
                      <span>
                        {testResult.tools.length} tools: {testResult.tools.slice(0, 5).join(", ")}
                        {testResult.tools.length > 5 && ` (+${testResult.tools.length - 5} more)`}
                      </span>
                    </>
                  ) : (
                    <>
                      <XCircle className="mt-0.5 h-3 w-3 shrink-0" />
                      <span>{testResult.error}</span>
                    </>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
};
