import React, { useCallback, useEffect, useState } from "react";
import { Server, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/browser/components/ui/button";
import { Switch } from "@/browser/components/ui/switch";
import { useSettings } from "@/browser/contexts/SettingsContext";
import { useAPI } from "@/browser/contexts/API";
import { cn } from "@/common/lib/utils";
import type {
  MCPServerInfo,
  MCPServerOrigin,
  MCPServerRuntimeStatus,
  WorkspaceMCPOverrides,
} from "@/common/types/mcp";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/browser/components/ui/dialog";
import { useMCPTestCache } from "@/browser/hooks/useMCPTestCache";
import { ToolSelector } from "@/browser/components/ToolSelector";

interface WorkspaceMCPModalProps {
  workspaceId: string;
  projectPath: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const McpRuntimeStatusBadge: React.FC<{ status?: MCPServerRuntimeStatus; className?: string }> = ({
  status,
  className,
}) => {
  if (!status) {
    return null;
  }

  const label = (() => {
    switch (status.state) {
      case "running":
        return "running";
      case "starting":
        return "starting";
      case "failed":
        return "failed";
      case "stopped":
        return "stopped";
      case "not_started":
        return "not started";
      default:
        return status.state;
    }
  })();

  const getStatusStyle = () => {
    switch (status.state) {
      case "running":
        return "bg-success/20 text-success";
      case "starting":
        return "bg-pending/20 text-pending";
      case "failed":
        return "bg-danger/20 text-danger";
      case "stopped":
      case "not_started":
        return "bg-muted/20 text-muted";
      default:
        return "bg-muted/20 text-muted";
    }
  };

  return (
    <span
      className={cn(
        "inline-block shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium whitespace-nowrap",
        getStatusStyle(),
        className
      )}
    >
      {label}
    </span>
  );
};

function workspaceMcpOverridesKey(overrides: WorkspaceMCPOverrides): string {
  const toolAllowlist = overrides.toolAllowlist
    ? Object.fromEntries(
        Object.entries(overrides.toolAllowlist)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([serverName, tools]) => [serverName, [...tools].sort((a, b) => a.localeCompare(b))])
      )
    : undefined;

  return JSON.stringify({
    disabledServers: overrides.disabledServers
      ? [...overrides.disabledServers].sort((a, b) => a.localeCompare(b))
      : undefined,
    enabledServers: overrides.enabledServers
      ? [...overrides.enabledServers].sort((a, b) => a.localeCompare(b))
      : undefined,
    toolAllowlist,
  });
}

export const WorkspaceMCPModal: React.FC<WorkspaceMCPModalProps> = ({
  workspaceId,
  projectPath,
  open,
  onOpenChange,
}) => {
  const settings = useSettings();
  const { api } = useAPI();

  // State for servers (global + project) and workspace overrides
  const [servers, setServers] = useState<Record<string, MCPServerInfo>>({});
  const [serverOrigins, setServerOrigins] = useState<Record<string, MCPServerOrigin>>({});
  const [runtimeStatus, setRuntimeStatus] = useState<{
    isLeased: boolean;
    servers: Record<string, MCPServerRuntimeStatus>;
  } | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(false);
  const [restartingServers, setRestartingServers] = useState<Record<string, boolean>>({});
  const [overrides, setOverrides] = useState<WorkspaceMCPOverrides>({});
  const [savedOverrides, setSavedOverrides] = useState<WorkspaceMCPOverrides>({});
  const [loadingTools, setLoadingTools] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Use shared cache for tool test results
  const { getTools, setResult, reload: reloadCache } = useMCPTestCache(projectPath);

  // Load servers (global + project), runtime status, and workspace overrides when modal opens
  useEffect(() => {
    if (!open || !api) return;

    reloadCache();

    const loadData = async () => {
      setLoading(true);
      setError(null);
      setRuntimeStatus(null);

      try {
        const [globalServers, projectServers, workspaceOverrides] = await Promise.all([
          api.global.mcp.list(),
          api.projects.mcp.list({ projectPath }),
          api.workspace.mcp.get({ workspaceId }),
        ]);

        const origins: Record<string, MCPServerOrigin> = {};
        for (const name of Object.keys(globalServers ?? {})) {
          origins[name] = "global";
        }
        for (const name of Object.keys(projectServers ?? {})) {
          origins[name] = "project";
        }

        // Precedence: global < project.
        setServers({ ...(globalServers ?? {}), ...(projectServers ?? {}) });
        setServerOrigins(origins);
        setOverrides(workspaceOverrides ?? {});
        setSavedOverrides(workspaceOverrides ?? {});
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load MCP configuration");
      } finally {
        setLoading(false);
      }

      setLoadingStatus(true);
      try {
        const status = await api.workspace.mcp.status({ workspaceId });
        setRuntimeStatus(status);
      } catch {
        // Best-effort: runtime status should never block config UI.
        setRuntimeStatus(null);
      } finally {
        setLoadingStatus(false);
      }
    };

    void loadData();
  }, [open, api, projectPath, workspaceId, reloadCache]);

  // Fetch/refresh tools for a server
  const fetchTools = useCallback(
    async (serverName: string) => {
      if (!api) return;
      setLoadingTools((prev) => ({ ...prev, [serverName]: true }));
      try {
        const origin = serverOrigins[serverName];
        const result =
          origin === "global"
            ? await api.global.mcp.test({ projectPath, name: serverName })
            : await api.projects.mcp.test({ projectPath, name: serverName });

        setResult(serverName, result);
        if (!result.success) {
          setError(`Failed to fetch tools for ${serverName}: ${result.error}`);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : `Failed to fetch tools for ${serverName}`);
      } finally {
        setLoadingTools((prev) => ({ ...prev, [serverName]: false }));
      }
    },
    [api, projectPath, serverOrigins, setResult]
  );

  const refreshRuntimeStatus = useCallback(async () => {
    if (!api) return;

    setLoadingStatus(true);
    try {
      const status = await api.workspace.mcp.status({ workspaceId });
      setRuntimeStatus(status);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load MCP runtime status");
    } finally {
      setLoadingStatus(false);
    }
  }, [api, workspaceId]);

  const restartServer = useCallback(
    async (serverName?: string) => {
      if (!api) return;

      const key = serverName ?? "__all__";
      setRestartingServers((prev) => ({ ...prev, [key]: true }));
      setError(null);
      try {
        const result = await api.workspace.mcp.restart({ workspaceId, serverName });
        if (!result.success) {
          setError(result.error);
          return;
        }

        await refreshRuntimeStatus();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to restart MCP server");
      } finally {
        setRestartingServers((prev) => ({ ...prev, [key]: false }));
      }
    },
    [api, workspaceId, refreshRuntimeStatus]
  );

  /**
   * Determine if a server is effectively enabled for this workspace.
   * Logic:
   * - If in enabledServers: enabled (overrides config disabled)
   * - If in disabledServers: disabled (overrides config enabled)
   * - Otherwise: use config-level state (info.disabled)
   */
  const isServerEnabled = useCallback(
    (serverName: string, configDisabled: boolean): boolean => {
      if (overrides.enabledServers?.includes(serverName)) return true;
      if (overrides.disabledServers?.includes(serverName)) return false;
      return !configDisabled;
    },
    [overrides.enabledServers, overrides.disabledServers]
  );

  // Toggle server enabled/disabled for workspace
  const toggleServerEnabled = useCallback(
    (serverName: string, enabled: boolean, configDisabled: boolean) => {
      setOverrides((prev) => {
        const currentEnabled = prev.enabledServers ?? [];
        const currentDisabled = prev.disabledServers ?? [];

        let newEnabled: string[];
        let newDisabled: string[];

        if (enabled) {
          // Enabling the server
          newDisabled = currentDisabled.filter((s) => s !== serverName);
          if (configDisabled) {
            // Need explicit enable to override disabled config
            newEnabled = [...currentEnabled, serverName];
          } else {
            // Config already enabled, just remove from disabled list
            newEnabled = currentEnabled.filter((s) => s !== serverName);
          }
        } else {
          // Disabling the server
          newEnabled = currentEnabled.filter((s) => s !== serverName);
          if (configDisabled) {
            // Config already disabled, just remove from enabled list
            newDisabled = currentDisabled.filter((s) => s !== serverName);
          } else {
            // Need explicit disable to override enabled config
            newDisabled = [...currentDisabled, serverName];
          }
        }

        return {
          ...prev,
          enabledServers: newEnabled.length > 0 ? newEnabled : undefined,
          disabledServers: newDisabled.length > 0 ? newDisabled : undefined,
        };
      });
    },
    []
  );

  // Check if all tools are allowed (no allowlist set)
  const hasNoAllowlist = useCallback(
    (serverName: string): boolean => {
      return !overrides.toolAllowlist?.[serverName];
    },
    [overrides.toolAllowlist]
  );

  // Toggle tool in allowlist
  const toggleToolAllowed = useCallback(
    (serverName: string, toolName: string, allowed: boolean) => {
      const allTools = getTools(serverName) ?? [];
      setOverrides((prev) => {
        const currentAllowlist = prev.toolAllowlist ?? {};
        const serverAllowlist = currentAllowlist[serverName];

        let newServerAllowlist: string[];
        if (allowed) {
          // Adding tool to allowlist
          if (!serverAllowlist) {
            // No allowlist yet - create one with all tools except this one removed
            // Actually, if we're adding and there's no allowlist, all are already allowed
            // So we don't need to do anything
            return prev;
          }
          newServerAllowlist = [...serverAllowlist, toolName];
        } else {
          // Removing tool from allowlist
          if (!serverAllowlist) {
            // No allowlist yet - create one with all tools except this one
            newServerAllowlist = allTools.filter((t) => t !== toolName);
          } else {
            newServerAllowlist = serverAllowlist.filter((t) => t !== toolName);
          }
        }

        // If allowlist contains all tools, remove it (same as no restriction)
        const newAllowlist = { ...currentAllowlist };
        if (newServerAllowlist.length === allTools.length) {
          delete newAllowlist[serverName];
        } else {
          newAllowlist[serverName] = newServerAllowlist;
        }

        return {
          ...prev,
          toolAllowlist: Object.keys(newAllowlist).length > 0 ? newAllowlist : undefined,
        };
      });
    },
    [getTools]
  );

  // Set "all tools allowed" for a server (remove from allowlist)
  const setAllToolsAllowed = useCallback((serverName: string) => {
    setOverrides((prev) => {
      const newAllowlist = { ...prev.toolAllowlist };
      delete newAllowlist[serverName];
      return {
        ...prev,
        toolAllowlist: Object.keys(newAllowlist).length > 0 ? newAllowlist : undefined,
      };
    });
  }, []);

  // Set "no tools allowed" for a server (empty allowlist)
  const setNoToolsAllowed = useCallback((serverName: string) => {
    setOverrides((prev) => {
      return {
        ...prev,
        toolAllowlist: {
          ...prev.toolAllowlist,
          [serverName]: [],
        },
      };
    });
  }, []);

  // Save overrides
  const handleSave = useCallback(async () => {
    if (!api) return;
    setSaving(true);
    setError(null);
    try {
      const result = await api.workspace.mcp.set({ workspaceId, overrides });
      if (!result.success) {
        setError(result.error);
        return;
      }

      setSavedOverrides(overrides);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save configuration");
    } finally {
      setSaving(false);
    }
  }, [api, workspaceId, overrides]);

  const serverEntries = Object.entries(servers).sort(([a], [b]) => a.localeCompare(b));
  const isLeased = runtimeStatus?.isLeased ?? false;
  const hasUnsavedChanges =
    workspaceMcpOverridesKey(overrides) !== workspaceMcpOverridesKey(savedOverrides);

  const handleOpenProjectSettings = useCallback(() => {
    onOpenChange(false);
    settings.open("projects");
  }, [onOpenChange, settings]);
  const hasServers = serverEntries.length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[80vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Server className="h-5 w-5" />
            Workspace MCP Configuration
          </DialogTitle>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="text-muted h-6 w-6 animate-spin" />
          </div>
        ) : !hasServers ? (
          <div className="text-muted py-8 text-center">
            <p>No MCP servers configured for this project (or globally).</p>
            <p className="mt-2 text-sm">
              Configure servers in{" "}
              <Button
                type="button"
                variant="link"
                className="h-auto p-0 align-baseline"
                onClick={handleOpenProjectSettings}
              >
                Settings → Projects
              </Button>{" "}
              to use them here.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-muted text-sm">
              Customize which MCP servers and tools are available in this workspace. Servers can be
              configured globally or per-project in Settings → Projects. Changes here only affect
              this workspace.
            </p>

            {error && (
              <div className="bg-danger-soft/10 text-danger-soft rounded-md p-3 text-sm">
                {error}
              </div>
            )}

            {hasUnsavedChanges && (
              <div className="bg-warning/10 border-warning/30 text-warning rounded-md border p-3 text-sm">
                You have unsaved MCP changes. Save to enable restarts.
              </div>
            )}

            {isLeased && (
              <div className="bg-warning/10 border-warning/30 text-warning rounded-md border p-3 text-sm">
                A stream is active. MCP servers can&apos;t be restarted until it finishes.
              </div>
            )}

            <div className="space-y-4">
              {serverEntries.map(([name, info]) => {
                const origin: MCPServerOrigin = serverOrigins[name] ?? "project";
                const configDisabled = info.disabled;
                const effectivelyEnabled = isServerEnabled(name, configDisabled);
                const tools = getTools(name);
                const isLoadingTools = loadingTools[name];
                const allowedTools = overrides.toolAllowlist?.[name] ?? tools ?? [];
                const status = runtimeStatus?.servers[name];
                const showStatusSpinner = loadingStatus && !status;
                const isRestarting = restartingServers[name];
                const restartLabel = status?.state === "not_started" ? "Start" : "Restart";

                return (
                  <div
                    key={name}
                    className={cn(
                      "border-border rounded-lg border p-4",
                      !effectivelyEnabled && "opacity-50"
                    )}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-start gap-3">
                        <Switch
                          checked={effectivelyEnabled}
                          onCheckedChange={(checked) =>
                            toggleServerEnabled(name, checked, configDisabled)
                          }
                        />
                        <div className="space-y-1">
                          <div className="flex items-center gap-2">
                            <div className="font-medium">{name}</div>
                            <span className="border-muted/50 text-muted inline-block shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-medium whitespace-nowrap">
                              {origin}
                            </span>
                            {showStatusSpinner ? (
                              <Loader2 className="text-muted h-3 w-3 animate-spin" />
                            ) : (
                              <McpRuntimeStatusBadge status={status} />
                            )}
                            {status?.state === "running" &&
                              typeof status.toolCount === "number" && (
                                <span className="text-muted text-xs">{status.toolCount} tools</span>
                              )}
                          </div>
                          {configDisabled && (
                            <div className="text-muted text-xs">(disabled in {origin} config)</div>
                          )}
                        </div>
                      </div>

                      {effectivelyEnabled && (
                        <div className="flex items-center gap-2">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => void restartServer(name)}
                            disabled={hasUnsavedChanges || Boolean(isRestarting) || isLeased}
                          >
                            {isRestarting ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <RefreshCw className="h-4 w-4" />
                            )}
                            {restartLabel}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => void fetchTools(name)}
                            disabled={isLoadingTools}
                          >
                            {isLoadingTools ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : tools ? (
                              "Refresh Tools"
                            ) : (
                              "Fetch Tools"
                            )}
                          </Button>
                        </div>
                      )}
                    </div>

                    {status?.state === "failed" && status.lastError && (
                      <div className="text-danger mt-2 text-xs whitespace-pre-wrap">
                        {status.lastError}
                      </div>
                    )}

                    {/* Tool allowlist section */}
                    {effectivelyEnabled && tools && tools.length > 0 && (
                      <div className="mt-4 border-t pt-4">
                        <ToolSelector
                          availableTools={tools}
                          allowedTools={allowedTools}
                          onToggle={(tool, allowed) => toggleToolAllowed(name, tool, allowed)}
                          onSelectAll={() => setAllToolsAllowed(name)}
                          onSelectNone={() => setNoToolsAllowed(name)}
                        />
                        {!hasNoAllowlist(name) && (
                          <div className="text-muted mt-2 text-xs">
                            {allowedTools.length} of {tools.length} tools enabled
                          </div>
                        )}
                      </div>
                    )}

                    {effectivelyEnabled && tools?.length === 0 && (
                      <div className="text-muted mt-2 text-sm">No tools available</div>
                    )}
                  </div>
                );
              })}
            </div>

            <div className="flex justify-end gap-2 pt-4">
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button onClick={() => void handleSave()} disabled={saving}>
                {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                Save
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
};
