import React, { useCallback, useEffect, useState } from "react";
import { useAPI } from "@/browser/contexts/API";
import { useProjectContext } from "@/browser/contexts/ProjectContext";
import {
  Trash2,
  Play,
  Loader2,
  CheckCircle,
  XCircle,
  Plus,
  Server,
  Pencil,
  Check,
  X,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import { Button } from "@/browser/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/browser/components/ui/select";
import { createEditKeyHandler } from "@/browser/utils/ui/keybinds";
import { Switch } from "@/browser/components/ui/switch";
import { cn } from "@/common/lib/utils";
import { formatRelativeTime } from "@/browser/utils/ui/dateTime";
import type { CachedMCPTestResult, MCPServerInfo } from "@/common/types/mcp";
import { useMCPTestCache } from "@/browser/hooks/useMCPTestCache";
import { ToolSelector } from "@/browser/components/ToolSelector";

/** Component for managing tool allowlist for a single MCP server */
const ToolAllowlistSection: React.FC<{
  serverName: string;
  availableTools: string[];
  currentAllowlist?: string[];
  testedAt: number;
  projectPath: string;
}> = ({ serverName, availableTools, currentAllowlist, testedAt, projectPath }) => {
  const { api } = useAPI();
  const [expanded, setExpanded] = useState(false);
  const [saving, setSaving] = useState(false);
  // Always use an array internally - undefined from props means all tools allowed
  const [localAllowlist, setLocalAllowlist] = useState<string[]>(
    () => currentAllowlist ?? [...availableTools]
  );

  // Sync local state when prop changes
  useEffect(() => {
    setLocalAllowlist(currentAllowlist ?? [...availableTools]);
  }, [currentAllowlist, availableTools]);

  const allAllowed = localAllowlist.length === availableTools.length;
  const allDisabled = localAllowlist.length === 0;

  const handleToggleTool = useCallback(
    async (toolName: string, allowed: boolean) => {
      if (!api) return;

      const newAllowlist = allowed
        ? [...localAllowlist, toolName]
        : localAllowlist.filter((t) => t !== toolName);

      // Optimistic update
      setLocalAllowlist(newAllowlist);
      setSaving(true);

      try {
        const result = await api.projects.mcp.setToolAllowlist({
          projectPath,
          name: serverName,
          toolAllowlist: newAllowlist,
        });
        if (!result.success) {
          setLocalAllowlist(currentAllowlist ?? [...availableTools]);
          console.error("Failed to update tool allowlist:", result.error);
        }
      } catch (err) {
        setLocalAllowlist(currentAllowlist ?? [...availableTools]);
        console.error("Failed to update tool allowlist:", err);
      } finally {
        setSaving(false);
      }
    },
    [api, projectPath, serverName, localAllowlist, currentAllowlist, availableTools]
  );

  const handleAllowAll = useCallback(async () => {
    if (!api || allAllowed) return;

    const newAllowlist = [...availableTools];
    setLocalAllowlist(newAllowlist);
    setSaving(true);

    try {
      const result = await api.projects.mcp.setToolAllowlist({
        projectPath,
        name: serverName,
        toolAllowlist: newAllowlist,
      });
      if (!result.success) {
        setLocalAllowlist(currentAllowlist ?? [...availableTools]);
        console.error("Failed to clear tool allowlist:", result.error);
      }
    } catch (err) {
      setLocalAllowlist(currentAllowlist ?? [...availableTools]);
      console.error("Failed to clear tool allowlist:", err);
    } finally {
      setSaving(false);
    }
  }, [api, projectPath, serverName, allAllowed, currentAllowlist, availableTools]);

  const handleSelectNone = useCallback(async () => {
    if (!api || allDisabled) return;

    setLocalAllowlist([]);
    setSaving(true);

    try {
      const result = await api.projects.mcp.setToolAllowlist({
        projectPath,
        name: serverName,
        toolAllowlist: [],
      });
      if (!result.success) {
        setLocalAllowlist(currentAllowlist ?? [...availableTools]);
        console.error("Failed to set empty tool allowlist:", result.error);
      }
    } catch (err) {
      setLocalAllowlist(currentAllowlist ?? [...availableTools]);
      console.error("Failed to set empty tool allowlist:", err);
    } finally {
      setSaving(false);
    }
  }, [api, projectPath, serverName, allDisabled, currentAllowlist, availableTools]);

  return (
    <div className="mt-2">
      <button
        onClick={() => setExpanded(!expanded)}
        className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-xs"
      >
        {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        <span>
          Tools: {localAllowlist.length}/{availableTools.length}
        </span>
        <span className="text-muted-foreground/60 ml-1">({formatRelativeTime(testedAt)})</span>
        {saving && <Loader2 className="ml-1 h-3 w-3 animate-spin" />}
      </button>

      {expanded && (
        <div className="border-border-light mt-2 border-l-2 pl-3">
          <ToolSelector
            availableTools={availableTools}
            allowedTools={localAllowlist}
            onToggle={(tool, allowed) => void handleToggleTool(tool, allowed)}
            onSelectAll={() => void handleAllowAll()}
            onSelectNone={() => void handleSelectNone()}
            disabled={saving}
          />
        </div>
      )}
    </div>
  );
};

export const ProjectSettingsSection: React.FC = () => {
  const { api } = useAPI();
  const { projects } = useProjectContext();
  const projectList = Array.from(projects.keys());

  // Core state
  const [selectedProject, setSelectedProject] = useState<string>("");
  const [servers, setServers] = useState<Record<string, MCPServerInfo>>({});
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

  // Idle compaction state
  const [idleHours, setIdleHours] = useState<number | null>(null);
  const [idleHoursInput, setIdleHoursInput] = useState<string>("");
  const [savingIdleHours, setSavingIdleHours] = useState(false);

  // Sync input field when idleHours loads/changes
  // Show "24" as default placeholder when disabled
  useEffect(() => {
    setIdleHoursInput(idleHours?.toString() ?? "24");
  }, [idleHours]);

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
      const [mcpResult, idleResult] = await Promise.all([
        api.projects.mcp.list({ projectPath: selectedProject }),
        api.projects.idleCompaction.get({ projectPath: selectedProject }),
      ]);
      setServers(mcpResult ?? {});
      setIdleHours(idleResult.hours);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load project settings");
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

  const handleToggleEnabled = useCallback(
    async (name: string, enabled: boolean) => {
      if (!api || !selectedProject) return;
      // Optimistic update
      setServers((prev) => ({
        ...prev,
        [name]: { ...prev[name], disabled: !enabled },
      }));
      try {
        const result = await api.projects.mcp.setEnabled({
          projectPath: selectedProject,
          name,
          enabled,
        });
        if (!result.success) {
          // Revert on error
          setServers((prev) => ({
            ...prev,
            [name]: { ...prev[name], disabled: enabled },
          }));
          setError(result.error ?? "Failed to update server");
        }
      } catch (err) {
        // Revert on error
        setServers((prev) => ({
          ...prev,
          [name]: { ...prev[name], disabled: enabled },
        }));
        setError(err instanceof Error ? err.message : "Failed to update server");
      }
    },
    [api, selectedProject]
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

  const handleIdleHoursChange = useCallback(
    async (hours: number | null) => {
      if (!api || !selectedProject) return;
      setSavingIdleHours(true);
      try {
        const result = await api.projects.idleCompaction.set({
          projectPath: selectedProject,
          hours,
        });
        if (result.success) {
          setIdleHours(hours);
        } else {
          setError(result.error ?? "Failed to update idle compaction setting");
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to update idle compaction setting");
      } finally {
        setSavingIdleHours(false);
      }
    },
    [api, selectedProject]
  );

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
        <label className="text-sm font-medium">Project</label>
        <Select value={selectedProject} onValueChange={setSelectedProject}>
          <SelectTrigger className="w-full">
            <SelectValue placeholder="Select project" />
          </SelectTrigger>
          <SelectContent>
            {projectList.map((path) => (
              <SelectItem key={path} value={path}>
                {projectName(path)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-muted-foreground truncate text-xs" title={selectedProject}>
          {selectedProject}
        </p>
      </div>

      {/* Idle Compaction */}
      <div className="space-y-4">
        <div>
          <h3 className="font-medium">Idle Compaction</h3>
          <p className="text-muted-foreground text-xs">
            Automatically compact workspaces after a period of inactivity to provide helpful
            summaries when returning
          </p>
        </div>

        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={idleHours !== null}
              onChange={(e) => void handleIdleHoursChange(e.target.checked ? 24 : null)}
              disabled={savingIdleHours}
              className="accent-accent h-4 w-4 rounded"
            />
            <span className="text-sm">Enable idle compaction</span>
          </label>
          {savingIdleHours && <Loader2 className="text-muted-foreground h-4 w-4 animate-spin" />}
        </div>

        <div
          className={cn(
            "flex items-center gap-2",
            idleHours === null && "pointer-events-none opacity-50"
          )}
        >
          <span className="text-sm">Compact after</span>
          <input
            type="number"
            min={1}
            value={idleHoursInput}
            onChange={(e) => setIdleHoursInput(e.target.value)}
            onBlur={(e) => {
              const val = parseInt(e.target.value, 10);
              if (!isNaN(val) && val >= 1 && val !== idleHours) {
                void handleIdleHoursChange(val);
              } else if (e.target.value === "" || isNaN(val) || val < 1) {
                // Reset to current value on invalid input
                setIdleHoursInput(idleHours?.toString() ?? "24");
              }
            }}
            disabled={savingIdleHours || idleHours === null}
            className="border-border-medium bg-secondary/30 focus:ring-accent w-20 rounded-md border px-2 py-1 text-sm focus:ring-1 focus:outline-none disabled:cursor-not-allowed"
          />
          <span className="text-sm">hours of inactivity</span>
        </div>
      </div>

      {/* MCP Servers header */}
      <div className="border-border-medium flex items-center justify-between border-t pt-6">
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
          {Object.entries(servers).map(([name, entry]) => {
            const isTesting = testingServer === name;
            const cached = testCache[name];
            const isEditing = editing?.name === name;
            const isEnabled = !entry.disabled;
            return (
              <li key={name} className="border-border-medium bg-secondary/20 rounded-lg border p-3">
                <div className="flex items-start gap-3">
                  <Switch
                    checked={isEnabled}
                    onCheckedChange={(checked) => void handleToggleEnabled(name, checked)}
                    title={isEnabled ? "Disable server" : "Enable server"}
                    className="mt-0.5 shrink-0"
                  />
                  <div className={cn("min-w-0 flex-1", !isEnabled && "opacity-50")}>
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{name}</span>
                      {cached?.result.success && !isEditing && isEnabled && (
                        <span
                          className="rounded bg-green-500/10 px-1.5 py-0.5 text-xs text-green-500"
                          title={`Tested ${formatRelativeTime(cached.testedAt)}`}
                        >
                          {cached.result.tools.length} tools
                        </span>
                      )}
                      {!isEnabled && (
                        <span className="text-muted-foreground text-xs">disabled</span>
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
                        {entry.command}
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {isEditing ? (
                      <>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => void handleSaveEdit()}
                          disabled={savingEdit || !editing.command.trim()}
                          className="h-7 w-7 text-green-500 hover:text-green-400"
                          title="Save (Enter)"
                        >
                          {savingEdit ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <Check className="h-4 w-4" />
                          )}
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={handleCancelEdit}
                          disabled={savingEdit}
                          className="text-muted hover:text-foreground h-7 w-7"
                          title="Cancel (Esc)"
                        >
                          <X className="h-4 w-4" />
                        </Button>
                      </>
                    ) : (
                      <>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => void handleTest(name)}
                          disabled={isTesting}
                          className="text-muted hover:text-accent h-7 w-7"
                          title="Test connection"
                        >
                          {isTesting ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <Play className="h-4 w-4" />
                          )}
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => handleStartEdit(name, entry.command)}
                          className="text-muted hover:text-accent h-7 w-7"
                          title="Edit command"
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => void handleRemove(name)}
                          disabled={loading}
                          className="text-muted hover:text-error h-7 w-7"
                          title="Remove server"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
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
                  <ToolAllowlistSection
                    serverName={name}
                    availableTools={cached.result.tools}
                    currentAllowlist={entry.toolAllowlist}
                    testedAt={cached.testedAt}
                    projectPath={selectedProject}
                  />
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
            <Button
              variant="outline"
              onClick={() => void handleTestNewCommand()}
              disabled={!canTest || testingNew}
              className="h-auto px-3 py-1.5"
            >
              {testingNew ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Play className="h-4 w-4" />
              )}
              {testingNew ? "Testing…" : "Test"}
            </Button>
            <Button onClick={() => void handleAddServer()} disabled={!canAdd || addingServer}>
              {addingServer ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Plus className="h-4 w-4" />
              )}
              {addingServer ? "Adding…" : "Add"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
};
