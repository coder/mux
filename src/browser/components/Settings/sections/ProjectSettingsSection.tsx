import React, { useCallback, useEffect, useState } from "react";
import { useAPI } from "@/browser/contexts/API";
import { useProjectContext } from "@/browser/contexts/ProjectContext";
import { Trash2, Play, Loader2, CheckCircle, XCircle, Plus, ChevronDown } from "lucide-react";

type TestResult = { success: true; tools: string[] } | { success: false; error: string };

export const ProjectSettingsSection: React.FC = () => {
  const { api } = useAPI();
  const { projects } = useProjectContext();
  const projectList = Array.from(projects.keys());

  const [selectedProject, setSelectedProject] = useState<string>("");
  const [servers, setServers] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testingServer, setTestingServer] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Map<string, TestResult>>(new Map());

  // Add server form state
  const [newServerName, setNewServerName] = useState("");
  const [newServerCommand, setNewServerCommand] = useState("");
  const [addingServer, setAddingServer] = useState(false);

  // Set default project when projects load
  useEffect(() => {
    if (projectList.length > 0 && !selectedProject) {
      setSelectedProject(projectList[0]);
    }
  }, [projectList, selectedProject]);

  const refresh = useCallback(async () => {
    if (!api || !selectedProject) return;
    setLoading(true);
    try {
      const result = await api.projects.mcp.list({ projectPath: selectedProject });
      setServers(result ?? {});
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load MCP servers");
    } finally {
      setLoading(false);
    }
  }, [api, selectedProject]);

  useEffect(() => {
    void refresh();
    // Clear test results when project changes
    setTestResults(new Map());
  }, [refresh]);

  const handleRemove = useCallback(
    async (name: string) => {
      if (!api || !selectedProject) return;
      setLoading(true);
      try {
        const result = await api.projects.mcp.remove({ projectPath: selectedProject, name });
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
    [api, selectedProject, refresh]
  );

  const handleTest = useCallback(
    async (name: string) => {
      if (!api || !selectedProject) return;
      setTestingServer(name);
      // Clear previous result for this server
      setTestResults((prev) => {
        const next = new Map(prev);
        next.delete(name);
        return next;
      });
      try {
        const result = await api.projects.mcp.test({ projectPath: selectedProject, name });
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
    [api, selectedProject]
  );

  const handleAddServer = useCallback(async () => {
    if (!api || !selectedProject || !newServerName.trim() || !newServerCommand.trim()) return;
    setAddingServer(true);
    setError(null);
    try {
      const result = await api.projects.mcp.add({
        projectPath: selectedProject,
        name: newServerName.trim(),
        command: newServerCommand.trim(),
      });
      if (!result.success) {
        setError(result.error ?? "Failed to add MCP server");
      } else {
        setNewServerName("");
        setNewServerCommand("");
        await refresh();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add MCP server");
    } finally {
      setAddingServer(false);
    }
  }, [api, selectedProject, newServerName, newServerCommand, refresh]);

  if (projectList.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        No projects configured. Add a project first to manage its settings.
      </p>
    );
  }

  const projectName = (path: string) => path.split(/[\\/]/).pop() ?? path;

  return (
    <div className="space-y-6">
      {/* Project selector */}
      <div>
        <label htmlFor="project-select" className="mb-1.5 block text-sm font-medium">
          Project
        </label>
        <div className="relative">
          <select
            id="project-select"
            value={selectedProject}
            onChange={(e) => setSelectedProject(e.target.value)}
            className="border-border-medium bg-secondary/30 text-foreground focus:ring-accent w-full appearance-none rounded-md border py-2 pr-8 pl-3 text-sm focus:ring-1 focus:outline-none"
          >
            {projectList.map((path) => (
              <option key={path} value={path}>
                {projectName(path)}
              </option>
            ))}
          </select>
          <ChevronDown className="text-muted-foreground pointer-events-none absolute top-1/2 right-2 h-4 w-4 -translate-y-1/2" />
        </div>
        <p className="text-muted-foreground mt-1 text-xs">{selectedProject}</p>
      </div>

      {/* MCP Servers section */}
      <div>
        <h3 className="text-base font-semibold">MCP Servers</h3>
        <p className="text-muted-foreground text-sm">
          Servers are stored in <code className="bg-secondary/50 rounded px-1">.mux/mcp.jsonc</code>
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

      {/* Add server form */}
      <div className="border-border-medium/60 space-y-3 rounded-md border p-3">
        <h4 className="text-sm font-medium">Add MCP Server</h4>
        <div className="space-y-2">
          <input
            type="text"
            placeholder="Server name (e.g., memory)"
            value={newServerName}
            onChange={(e) => setNewServerName(e.target.value)}
            className="border-border-medium bg-secondary/30 text-foreground placeholder:text-muted-foreground focus:ring-accent w-full rounded-md border px-3 py-1.5 text-sm focus:ring-1 focus:outline-none"
          />
          <input
            type="text"
            placeholder="Command (e.g., npx -y @modelcontextprotocol/server-memory)"
            value={newServerCommand}
            onChange={(e) => setNewServerCommand(e.target.value)}
            className="border-border-medium bg-secondary/30 text-foreground placeholder:text-muted-foreground focus:ring-accent w-full rounded-md border px-3 py-1.5 text-sm focus:ring-1 focus:outline-none"
            onKeyDown={(e) => {
              if (e.key === "Enter" && newServerName.trim() && newServerCommand.trim()) {
                void handleAddServer();
              }
            }}
          />
        </div>
        <button
          type="button"
          onClick={() => void handleAddServer()}
          disabled={addingServer || !newServerName.trim() || !newServerCommand.trim()}
          className="bg-accent hover:bg-accent/90 flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm text-white disabled:opacity-50"
        >
          {addingServer ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Plus className="h-4 w-4" />
          )}
          {addingServer ? "Adding…" : "Add Server"}
        </button>
      </div>
    </div>
  );
};
