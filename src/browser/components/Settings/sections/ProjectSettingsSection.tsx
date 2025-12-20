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
import type {
  CachedMCPTestResult,
  MCPHeaderValue,
  MCPServerInfo,
  MCPServerTransport,
} from "@/common/types/mcp";
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
    <div>
      <button
        onClick={() => setExpanded(!expanded)}
        className="text-muted hover:text-foreground flex items-center gap-1 text-xs"
      >
        {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        <span>
          Tools: {localAllowlist.length}/{availableTools.length}
        </span>
        <span className="text-muted/60 ml-1">({formatRelativeTime(testedAt)})</span>
        {saving && <Loader2 className="ml-1 h-3 w-3 animate-spin" />}
      </button>

      {expanded && (
        <div className="mt-2">
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

  interface EditableServer {
    name: string;
    transport: MCPServerTransport;
    /** command (stdio) or url (http/sse/auto) */
    value: string;
    /** JSON string for headers (http/sse/auto only) */
    headersJson: string;
  }

  // Add form state
  const [newServer, setNewServer] = useState<EditableServer>({
    name: "",
    transport: "stdio",
    value: "",
    headersJson: "",
  });
  const [addingServer, setAddingServer] = useState(false);
  const [testingNew, setTestingNew] = useState(false);
  const [newTestResult, setNewTestResult] = useState<CachedMCPTestResult | null>(null);

  // Edit state
  const [editing, setEditing] = useState<EditableServer | null>(null);
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

  // Clear new-server test result when transport/value/headers change
  useEffect(() => {
    setNewTestResult(null);
  }, [newServer.transport, newServer.value, newServer.headersJson]);

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

  const parseHeadersJson = (headersJson: string): Record<string, MCPHeaderValue> | undefined => {
    const trimmed = headersJson.trim();
    if (!trimmed) {
      return undefined;
    }

    const parsed: unknown = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Headers must be a JSON object");
    }

    const out: Record<string, MCPHeaderValue> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "string") {
        out[key] = value;
        continue;
      }
      if (value && typeof value === "object" && !Array.isArray(value)) {
        const secret = (value as Record<string, unknown>).secret;
        if (typeof secret === "string") {
          out[key] = { secret };
          continue;
        }
      }
      throw new Error(`Invalid header value for ${key}`);
    }

    return out;
  };

  const serverDisplayValue = (entry: MCPServerInfo): string =>
    entry.transport === "stdio" ? entry.command : entry.url;

  const serverHeadersJson = (entry: MCPServerInfo): string => {
    if (entry.transport === "stdio") {
      return "";
    }
    return entry.headers ? JSON.stringify(entry.headers, null, 2) : "";
  };

  const handleTestNewServer = useCallback(async () => {
    if (!api || !selectedProject || !newServer.value.trim()) return;
    setTestingNew(true);
    setNewTestResult(null);

    try {
      const headers =
        newServer.transport === "stdio" ? undefined : parseHeadersJson(newServer.headersJson);

      const result = await api.projects.mcp.test({
        projectPath: selectedProject,
        ...(newServer.transport === "stdio"
          ? { command: newServer.value.trim() }
          : {
              transport: newServer.transport,
              url: newServer.value.trim(),
              headers,
            }),
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
  }, [api, selectedProject, newServer.transport, newServer.value, newServer.headersJson]);

  const handleAddServer = useCallback(async () => {
    if (!api || !selectedProject || !newServer.name.trim() || !newServer.value.trim()) return;
    setAddingServer(true);
    setError(null);

    try {
      const headers =
        newServer.transport === "stdio" ? undefined : parseHeadersJson(newServer.headersJson);

      const result = await api.projects.mcp.add({
        projectPath: selectedProject,
        name: newServer.name.trim(),
        ...(newServer.transport === "stdio"
          ? { transport: "stdio", command: newServer.value.trim() }
          : {
              transport: newServer.transport,
              url: newServer.value.trim(),
              headers,
            }),
      });

      if (!result.success) {
        setError(result.error ?? "Failed to add MCP server");
      } else {
        // Cache the test result if we have one
        if (newTestResult?.result.success) {
          cacheTestResult(newServer.name.trim(), newTestResult.result);
        }
        setNewServer({ name: "", transport: "stdio", value: "", headersJson: "" });
        setNewTestResult(null);
        await refresh();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add MCP server");
    } finally {
      setAddingServer(false);
    }
  }, [api, selectedProject, newServer, newTestResult, refresh, cacheTestResult]);

  const handleStartEdit = useCallback((name: string, entry: MCPServerInfo) => {
    setEditing({
      name,
      transport: entry.transport,
      value: serverDisplayValue(entry),
      headersJson: serverHeadersJson(entry),
    });
  }, []);

  const handleCancelEdit = useCallback(() => {
    setEditing(null);
  }, []);

  const handleSaveEdit = useCallback(async () => {
    if (!api || !selectedProject || !editing?.value.trim()) return;
    setSavingEdit(true);
    setError(null);

    try {
      const headers =
        editing.transport === "stdio" ? undefined : parseHeadersJson(editing.headersJson);

      const result = await api.projects.mcp.add({
        projectPath: selectedProject,
        name: editing.name,
        ...(editing.transport === "stdio"
          ? { transport: "stdio", command: editing.value.trim() }
          : {
              transport: editing.transport,
              url: editing.value.trim(),
              headers,
            }),
      });

      if (!result.success) {
        setError(result.error ?? "Failed to update MCP server");
      } else {
        // Clear cached test result since config changed
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
        <Server className="text-muted mb-3 h-10 w-10" />
        <p className="text-muted text-sm">
          No projects configured. Add a project first to manage settings.
        </p>
      </div>
    );
  }

  const projectName = (path: string) => path.split(/[\\/]/).pop() ?? path;
  const canAdd = newServer.name.trim() && newServer.value.trim();
  const canTest = newServer.value.trim();

  return (
    <div className="space-y-6">
      {/* Intro + Project selector */}
      <div>
        <p className="text-muted mb-4 text-xs">
          Configure project-specific settings. Settings are stored in{" "}
          <code className="text-accent">.mux/</code> within your project.
        </p>
        <div className="flex items-center justify-between">
          <div>
            <div className="text-foreground text-sm">Project</div>
            <div className="text-muted text-xs">Select a project to configure</div>
          </div>
          <Select value={selectedProject} onValueChange={setSelectedProject}>
            <SelectTrigger className="border-border-medium bg-background-secondary hover:bg-hover h-9 w-auto min-w-[160px] cursor-pointer rounded-md border px-3 text-sm transition-colors">
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
        </div>
      </div>

      {/* Idle Compaction */}
      <div>
        <h3 className="text-foreground mb-4 text-sm font-medium">Idle Compaction</h3>
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-foreground text-sm">Auto-compact</div>
              <div className="text-muted text-xs">Summarize inactive workspaces automatically</div>
            </div>
            <div className="flex items-center gap-2">
              {savingIdleHours && <Loader2 className="text-muted h-4 w-4 animate-spin" />}
              <Switch
                checked={idleHours !== null}
                onCheckedChange={(checked) => void handleIdleHoursChange(checked ? 24 : null)}
                disabled={savingIdleHours}
              />
            </div>
          </div>

          <div
            className={cn(
              "flex items-center justify-between",
              idleHours === null && "pointer-events-none opacity-50"
            )}
          >
            <div>
              <div className="text-foreground text-sm">Idle threshold</div>
              <div className="text-muted text-xs">Hours of inactivity before compacting</div>
            </div>
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
                  setIdleHoursInput(idleHours?.toString() ?? "24");
                }
              }}
              disabled={savingIdleHours || idleHours === null}
              className="border-border-medium bg-background-secondary focus:border-accent h-9 w-20 rounded-md border px-3 text-center text-sm focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
            />
          </div>
        </div>
      </div>

      {/* MCP Servers */}
      <div>
        <h3 className="text-foreground mb-4 text-sm font-medium">MCP Servers</h3>

        {error && (
          <div className="bg-destructive/10 text-destructive mb-3 flex items-center gap-2 rounded-md px-3 py-2 text-sm">
            <XCircle className="h-4 w-4 shrink-0" />
            {error}
          </div>
        )}

        {/* Server list */}
        <div className="space-y-2">
          {loading ? (
            <div className="text-muted flex items-center gap-2 py-4 text-sm">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading servers…
            </div>
          ) : Object.keys(servers).length === 0 ? (
            <p className="text-muted py-2 text-sm">No MCP servers configured yet.</p>
          ) : (
            Object.entries(servers).map(([name, entry]) => {
              const isTesting = testingServer === name;
              const cached = testCache[name];
              const isEditing = editing?.name === name;
              const isEnabled = !entry.disabled;
              return (
                <div
                  key={name}
                  className="border-border-medium bg-background-secondary overflow-hidden rounded-md border"
                >
                  <div className="flex items-start gap-3 px-3 py-2.5">
                    <Switch
                      checked={isEnabled}
                      onCheckedChange={(checked) => void handleToggleEnabled(name, checked)}
                      title={isEnabled ? "Disable server" : "Enable server"}
                      className="mt-0.5 shrink-0"
                    />
                    <div className={cn("min-w-0 flex-1", !isEnabled && "opacity-50")}>
                      <div className="flex items-center gap-2">
                        <span className="text-foreground text-sm font-medium">{name}</span>
                        {cached?.result.success && !isEditing && isEnabled && (
                          <span
                            className="rounded bg-green-500/10 px-1.5 py-0.5 text-xs text-green-500"
                            title={`Tested ${formatRelativeTime(cached.testedAt)}`}
                          >
                            {cached.result.tools.length} tools
                          </span>
                        )}
                        {!isEnabled && <span className="text-muted text-xs">disabled</span>}
                      </div>
                      {isEditing ? (
                        <div className="mt-2 space-y-2">
                          <p className="text-muted text-xs">transport: {editing.transport}</p>
                          <input
                            type="text"
                            value={editing.value}
                            onChange={(e) => setEditing({ ...editing, value: e.target.value })}
                            className="bg-modal-bg border-border-medium focus:border-accent w-full rounded border px-2 py-1.5 font-mono text-xs focus:outline-none"
                            autoFocus
                            spellCheck={false}
                            onKeyDown={createEditKeyHandler({
                              onSave: () => void handleSaveEdit(),
                              onCancel: handleCancelEdit,
                            })}
                          />
                          {editing.transport !== "stdio" && (
                            <textarea
                              value={editing.headersJson}
                              onChange={(e) =>
                                setEditing({ ...editing, headersJson: e.target.value })
                              }
                              rows={3}
                              spellCheck={false}
                              className="bg-modal-bg border-border-medium focus:border-accent w-full rounded border px-2 py-1.5 font-mono text-xs focus:outline-none"
                            />
                          )}
                        </div>
                      ) : (
                        <p className="text-muted mt-0.5 font-mono text-xs break-all">
                          {serverDisplayValue(entry)}
                        </p>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-0.5">
                      {isEditing ? (
                        <>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => void handleSaveEdit()}
                            disabled={savingEdit || !editing.value.trim()}
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
                            onClick={() => handleStartEdit(name, entry)}
                            className="text-muted hover:text-accent h-7 w-7"
                            title="Edit server"
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
                    <div className="border-border-medium text-destructive border-t px-3 py-2 text-xs">
                      <div className="flex items-start gap-1.5">
                        <XCircle className="mt-0.5 h-3 w-3 shrink-0" />
                        <span>{cached.result.error}</span>
                      </div>
                    </div>
                  )}
                  {cached?.result.success && cached.result.tools.length > 0 && !isEditing && (
                    <div className="border-border-medium border-t px-3 py-2">
                      <ToolAllowlistSection
                        serverName={name}
                        availableTools={cached.result.tools}
                        currentAllowlist={entry.toolAllowlist}
                        testedAt={cached.testedAt}
                        projectPath={selectedProject}
                      />
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>

        {/* Add server form */}
        <details className="group mt-3">
          <summary className="text-accent hover:text-accent/80 flex cursor-pointer list-none items-center gap-1 text-sm font-medium">
            <ChevronRight className="h-4 w-4 transition-transform group-open:rotate-90" />
            Add server
          </summary>
          <div className="border-border-medium bg-background-secondary mt-2 space-y-3 rounded-md border p-3">
            <div>
              <label htmlFor="server-name" className="text-muted mb-1 block text-xs">
                Name
              </label>
              <input
                id="server-name"
                type="text"
                placeholder="e.g., memory"
                value={newServer.name}
                onChange={(e) => setNewServer((prev) => ({ ...prev, name: e.target.value }))}
                className="bg-modal-bg border-border-medium focus:border-accent w-full rounded border px-2 py-1.5 text-sm focus:outline-none"
              />
            </div>

            <div>
              <label className="text-muted mb-1 block text-xs">Transport</label>
              <Select
                value={newServer.transport}
                onValueChange={(value) =>
                  setNewServer((prev) => ({
                    ...prev,
                    transport: value as MCPServerTransport,
                    value: "",
                    headersJson: "",
                  }))
                }
              >
                <SelectTrigger className="border-border-medium bg-modal-bg h-8 w-full text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="stdio">Stdio</SelectItem>
                  <SelectItem value="http">HTTP (Streamable)</SelectItem>
                  <SelectItem value="sse">SSE (Legacy)</SelectItem>
                  <SelectItem value="auto">Auto (HTTP → SSE)</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div>
              <label htmlFor="server-value" className="text-muted mb-1 block text-xs">
                {newServer.transport === "stdio" ? "Command" : "URL"}
              </label>
              <input
                id="server-value"
                type="text"
                placeholder={
                  newServer.transport === "stdio"
                    ? "e.g., npx -y @modelcontextprotocol/server-memory"
                    : "e.g., http://localhost:3333/mcp"
                }
                value={newServer.value}
                onChange={(e) => setNewServer((prev) => ({ ...prev, value: e.target.value }))}
                spellCheck={false}
                className="bg-modal-bg border-border-medium focus:border-accent w-full rounded border px-2 py-1.5 font-mono text-sm focus:outline-none"
              />
            </div>

            {newServer.transport !== "stdio" && (
              <div>
                <label htmlFor="server-headers" className="text-muted mb-1 block text-xs">
                  Headers (JSON)
                </label>
                <textarea
                  id="server-headers"
                  placeholder='e.g., {"Authorization": {"secret": "MCP_TOKEN"}}'
                  value={newServer.headersJson}
                  onChange={(e) =>
                    setNewServer((prev) => ({ ...prev, headersJson: e.target.value }))
                  }
                  spellCheck={false}
                  rows={3}
                  className="bg-modal-bg border-border-medium focus:border-accent w-full rounded border px-2 py-1.5 font-mono text-xs focus:outline-none"
                />
              </div>
            )}

            {/* Test result */}
            {newTestResult && (
              <div
                className={cn(
                  "flex items-start gap-2 rounded-md px-3 py-2 text-sm",
                  newTestResult.result.success
                    ? "bg-green-500/10 text-green-500"
                    : "bg-destructive/10 text-destructive"
                )}
              >
                {newTestResult.result.success ? (
                  <>
                    <CheckCircle className="mt-0.5 h-4 w-4 shrink-0" />
                    <div>
                      <span className="font-medium">
                        Connected — {newTestResult.result.tools.length} tools
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

            <div className="flex gap-2 pt-1">
              <Button
                variant="outline"
                size="sm"
                onClick={() => void handleTestNewServer()}
                disabled={!canTest || testingNew}
              >
                {testingNew ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Play className="h-3.5 w-3.5" />
                )}
                {testingNew ? "Testing…" : "Test"}
              </Button>
              <Button
                size="sm"
                onClick={() => void handleAddServer()}
                disabled={!canAdd || addingServer}
              >
                {addingServer ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Plus className="h-3.5 w-3.5" />
                )}
                {addingServer ? "Adding…" : "Add"}
              </Button>
            </div>
          </div>
        </details>
      </div>
    </div>
  );
};
