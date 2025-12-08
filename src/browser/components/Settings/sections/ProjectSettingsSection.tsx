import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useAPI } from "@/browser/contexts/API";
import { useProjectContext } from "@/browser/contexts/ProjectContext";
import {
  Trash2,
  Play,
  Loader2,
  CheckCircle,
  XCircle,
  Plus,
  ChevronDown,
  Server,
  Pencil,
  Check,
  X,
} from "lucide-react";
import { createEditKeyHandler } from "@/browser/utils/ui/keybinds";
import { formatRelativeTime } from "@/browser/utils/ui/dateTime";
import type { CachedMCPTestResult } from "@/common/types/mcp";
import { getMCPTestResultsKey } from "@/common/constants/storage";
import { readPersistedState, updatePersistedState } from "@/browser/hooks/usePersistedState";

type CachedResults = Record<string, CachedMCPTestResult>;

/** Hook to manage MCP test results with localStorage caching */
function useMCPTestCache(projectPath: string) {
  const storageKey = useMemo(
    () => (projectPath ? getMCPTestResultsKey(projectPath) : ""),
    [projectPath]
  );

  const [cache, setCache] = useState<CachedResults>(() =>
    storageKey ? readPersistedState<CachedResults>(storageKey, {}) : {}
  );

  // Reload cache when project changes
  useEffect(() => {
    if (storageKey) {
      setCache(readPersistedState<CachedResults>(storageKey, {}));
    } else {
      setCache({});
    }
  }, [storageKey]);

  const setResult = useCallback(
    (name: string, result: CachedMCPTestResult["result"]) => {
      const entry: CachedMCPTestResult = { result, testedAt: Date.now() };
      setCache((prev) => {
        const next = { ...prev, [name]: entry };
        if (storageKey) updatePersistedState(storageKey, next);
        return next;
      });
    },
    [storageKey]
  );

  const clearResult = useCallback(
    (name: string) => {
      setCache((prev) => {
        const next = { ...prev };
        delete next[name];
        if (storageKey) updatePersistedState(storageKey, next);
        return next;
      });
    },
    [storageKey]
  );

  return { cache, setResult, clearResult };
}

export const ProjectSettingsSection: React.FC = () => {
  const { api } = useAPI();
  const { projects } = useProjectContext();
  const projectList = Array.from(projects.keys());

  // Core state
  const [selectedProject, setSelectedProject] = useState<string>("");
  const [servers, setServers] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Test state with caching
  const {
    cache: testCache,
    setResult: cacheTestResult,
    clearResult: clearTestResult,
  } = useMCPTestCache(selectedProject);
  const [testingServer, setTestingServer] = useState<string | null>(null);

  // Add form state
  const [newServer, setNewServer] = useState({ name: "", command: "" });
  const [addingServer, setAddingServer] = useState(false);
  const [testingNew, setTestingNew] = useState(false);
  const [newTestResult, setNewTestResult] = useState<CachedMCPTestResult | null>(null);

  // Edit state
  const [editing, setEditing] = useState<{ name: string; command: string } | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);

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
  }, [refresh]);

  // Clear new command test result when command changes
  useEffect(() => {
    setNewTestResult(null);
  }, [newServer.command]);

  const handleRemove = useCallback(
    async (name: string) => {
      if (!api || !selectedProject) return;
      setLoading(true);
      try {
        const result = await api.projects.mcp.remove({ projectPath: selectedProject, name });
        if (!result.success) {
          setError(result.error ?? "Failed to remove MCP server");
        } else {
          clearTestResult(name);
          await refresh();
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to remove MCP server");
      } finally {
        setLoading(false);
      }
    },
    [api, selectedProject, refresh, clearTestResult]
  );

  const handleTest = useCallback(
    async (name: string) => {
      if (!api || !selectedProject) return;
      setTestingServer(name);
      try {
        const result = await api.projects.mcp.test({ projectPath: selectedProject, name });
        cacheTestResult(name, result);
      } catch (err) {
        cacheTestResult(name, {
          success: false,
          error: err instanceof Error ? err.message : "Test failed",
        });
      } finally {
        setTestingServer(null);
      }
    },
    [api, selectedProject, cacheTestResult]
  );

  const handleTestNewCommand = useCallback(async () => {
    if (!api || !selectedProject || !newServer.command.trim()) return;
    setTestingNew(true);
    setNewTestResult(null);
    try {
      const result = await api.projects.mcp.test({
        projectPath: selectedProject,
        command: newServer.command.trim(),
      });
      setNewTestResult({ result, testedAt: Date.now() });
    } catch (err) {
      setNewTestResult({
        result: { success: false, error: err instanceof Error ? err.message : "Test failed" },
        testedAt: Date.now(),
      });
    } finally {
      setTestingNew(false);
    }
  }, [api, selectedProject, newServer.command]);

  const handleAddServer = useCallback(async () => {
    if (!api || !selectedProject || !newServer.name.trim() || !newServer.command.trim()) return;
    setAddingServer(true);
    setError(null);
    try {
      const result = await api.projects.mcp.add({
        projectPath: selectedProject,
        name: newServer.name.trim(),
        command: newServer.command.trim(),
      });
      if (!result.success) {
        setError(result.error ?? "Failed to add MCP server");
      } else {
        // Cache the test result if we have one
        if (newTestResult?.result.success) {
          cacheTestResult(newServer.name.trim(), newTestResult.result);
        }
        setNewServer({ name: "", command: "" });
        setNewTestResult(null);
        await refresh();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add MCP server");
    } finally {
      setAddingServer(false);
    }
  }, [api, selectedProject, newServer, newTestResult, refresh, cacheTestResult]);

  const handleStartEdit = useCallback((name: string, command: string) => {
    setEditing({ name, command });
  }, []);

  const handleCancelEdit = useCallback(() => {
    setEditing(null);
  }, []);

  const handleSaveEdit = useCallback(async () => {
    if (!api || !selectedProject || !editing?.command.trim()) return;
    setSavingEdit(true);
    setError(null);
    try {
      const result = await api.projects.mcp.add({
        projectPath: selectedProject,
        name: editing.name,
        command: editing.command.trim(),
      });
      if (!result.success) {
        setError(result.error ?? "Failed to update MCP server");
      } else {
        // Clear cached test result since command changed
        clearTestResult(editing.name);
        setEditing(null);
        await refresh();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update MCP server");
    } finally {
      setSavingEdit(false);
    }
  }, [api, selectedProject, editing, refresh, clearTestResult]);

  if (projectList.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <Server className="text-muted-foreground mb-3 h-10 w-10" />
        <p className="text-muted-foreground text-sm">
          No projects configured. Add a project first to manage MCP servers.
        </p>
      </div>
    );
  }

  const projectName = (path: string) => path.split(/[\\/]/).pop() ?? path;
  const canAdd = newServer.name.trim() && newServer.command.trim();
  const canTest = newServer.command.trim();

  return (
    <div className="space-y-6">
      {/* Project selector */}
      <div className="space-y-1.5">
        <label htmlFor="project-select" className="text-sm font-medium">
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
          <ChevronDown className="text-muted-foreground pointer-events-none absolute top-1/2 right-2.5 h-4 w-4 -translate-y-1/2" />
        </div>
        <p className="text-muted-foreground truncate text-xs" title={selectedProject}>
          {selectedProject}
        </p>
      </div>

      {/* MCP Servers header */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="font-medium">MCP Servers</h3>
          <p className="text-muted-foreground text-xs">
            Stored in <code className="bg-secondary/50 rounded px-1">.mux/mcp.jsonc</code>
          </p>
        </div>
      </div>

      {error && (
        <div className="bg-destructive/10 text-destructive flex items-center gap-2 rounded-md px-3 py-2 text-sm">
          <XCircle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      {/* Server list */}
      {loading ? (
        <div className="text-muted-foreground flex items-center gap-2 py-4 text-sm">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading servers…
        </div>
      ) : Object.keys(servers).length === 0 ? (
        <p className="text-muted-foreground py-4 text-sm">No MCP servers configured yet.</p>
      ) : (
        <ul className="space-y-2">
          {Object.entries(servers).map(([name, command]) => {
            const isTesting = testingServer === name;
            const cached = testCache[name];
            const isEditing = editing?.name === name;
            return (
              <li key={name} className="border-border-medium bg-secondary/20 rounded-lg border p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{name}</span>
                      {cached?.result.success && !isEditing && (
                        <span
                          className="rounded bg-green-500/10 px-1.5 py-0.5 text-xs text-green-500"
                          title={`Tested ${formatRelativeTime(cached.testedAt)}`}
                        >
                          {cached.result.tools.length} tools
                        </span>
                      )}
                    </div>
                    {isEditing ? (
                      <input
                        type="text"
                        value={editing.command}
                        onChange={(e) => setEditing({ ...editing, command: e.target.value })}
                        className="border-border-medium bg-secondary/30 text-foreground placeholder:text-muted-foreground focus:ring-accent mt-1 w-full rounded-md border px-2 py-1 font-mono text-xs focus:ring-1 focus:outline-none"
                        autoFocus
                        spellCheck={false}
                        onKeyDown={createEditKeyHandler({
                          onSave: () => void handleSaveEdit(),
                          onCancel: handleCancelEdit,
                        })}
                      />
                    ) : (
                      <p className="text-muted-foreground mt-0.5 font-mono text-xs break-all">
                        {command}
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0 gap-1">
                    {isEditing ? (
                      <>
                        <button
                          type="button"
                          onClick={() => void handleSaveEdit()}
                          disabled={savingEdit || !editing.command.trim()}
                          className="text-muted-foreground rounded p-1.5 transition-colors hover:bg-green-500/10 hover:text-green-500 disabled:opacity-50"
                          title="Save (Enter)"
                        >
                          {savingEdit ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <Check className="h-4 w-4" />
                          )}
                        </button>
                        <button
                          type="button"
                          onClick={handleCancelEdit}
                          disabled={savingEdit}
                          className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive rounded p-1.5 transition-colors"
                          title="Cancel (Esc)"
                        >
                          <X className="h-4 w-4" />
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          onClick={() => void handleTest(name)}
                          disabled={isTesting}
                          className="text-muted-foreground hover:bg-secondary hover:text-accent rounded p-1.5 transition-colors disabled:opacity-50"
                          title="Test connection"
                        >
                          {isTesting ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <Play className="h-4 w-4" />
                          )}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleStartEdit(name, command)}
                          className="text-muted-foreground hover:bg-secondary hover:text-accent rounded p-1.5 transition-colors"
                          title="Edit command"
                        >
                          <Pencil className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleRemove(name)}
                          disabled={loading}
                          className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive rounded p-1.5 transition-colors"
                          title="Remove server"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </>
                    )}
                  </div>
                </div>
                {cached && !cached.result.success && !isEditing && (
                  <div className="text-destructive mt-2 flex items-start gap-1.5 text-xs">
                    <XCircle className="mt-0.5 h-3 w-3 shrink-0" />
                    <span>{cached.result.error}</span>
                  </div>
                )}
                {cached?.result.success && cached.result.tools.length > 0 && !isEditing && (
                  <p className="text-muted-foreground mt-2 text-xs">
                    Tools: {cached.result.tools.join(", ")}
                    <span className="text-muted-foreground/60 ml-2">
                      ({formatRelativeTime(cached.testedAt)})
                    </span>
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {/* Add server form */}
      <div className="border-border-medium bg-secondary/10 space-y-3 rounded-lg border p-4">
        <h4 className="font-medium">Add Server</h4>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <label htmlFor="server-name" className="text-muted-foreground text-xs">
              Name
            </label>
            <input
              id="server-name"
              type="text"
              placeholder="e.g., memory"
              value={newServer.name}
              onChange={(e) => setNewServer((prev) => ({ ...prev, name: e.target.value }))}
              className="border-border-medium bg-secondary/30 text-foreground placeholder:text-muted-foreground focus:ring-accent w-full rounded-md border px-3 py-2 text-sm focus:ring-1 focus:outline-none"
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="server-command" className="text-muted-foreground text-xs">
              Command
            </label>
            <input
              id="server-command"
              type="text"
              placeholder="e.g., npx -y @modelcontextprotocol/server-memory"
              value={newServer.command}
              onChange={(e) => setNewServer((prev) => ({ ...prev, command: e.target.value }))}
              spellCheck={false}
              className="border-border-medium bg-secondary/30 text-foreground placeholder:text-muted-foreground focus:ring-accent w-full rounded-md border px-3 py-2 font-mono text-sm focus:ring-1 focus:outline-none"
            />
          </div>

          {/* Test result for new command */}
          {newTestResult && (
            <div
              className={`flex items-start gap-2 rounded-md px-3 py-2 text-sm ${
                newTestResult.result.success
                  ? "bg-green-500/10 text-green-500"
                  : "bg-destructive/10 text-destructive"
              }`}
            >
              {newTestResult.result.success ? (
                <>
                  <CheckCircle className="mt-0.5 h-4 w-4 shrink-0" />
                  <div>
                    <span className="font-medium">
                      Connection successful — {newTestResult.result.tools.length} tools available
                    </span>
                    {newTestResult.result.tools.length > 0 && (
                      <p className="mt-0.5 text-xs opacity-80">
                        {newTestResult.result.tools.join(", ")}
                      </p>
                    )}
                  </div>
                </>
              ) : (
                <>
                  <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{newTestResult.result.error}</span>
                </>
              )}
            </div>
          )}

          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void handleTestNewCommand()}
              disabled={!canTest || testingNew}
              className="border-border-medium hover:bg-secondary flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm transition-colors disabled:opacity-50"
            >
              {testingNew ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Play className="h-4 w-4" />
              )}
              {testingNew ? "Testing…" : "Test"}
            </button>
            <button
              type="button"
              onClick={() => void handleAddServer()}
              disabled={!canAdd || addingServer}
              className="bg-accent hover:bg-accent/90 flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm text-white transition-colors disabled:opacity-50"
            >
              {addingServer ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Plus className="h-4 w-4" />
              )}
              {addingServer ? "Adding…" : "Add"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
