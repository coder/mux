import React, { useCallback, useEffect, useRef, useState } from "react";
import { Server, Loader2 } from "lucide-react";
import { Button } from "@/browser/components/Button/Button";
import { Switch } from "@/browser/components/Switch/Switch";
import { useSettings } from "@/browser/contexts/SettingsContext";
import { useAPI } from "@/browser/contexts/API";
import { cn } from "@/common/lib/utils";
import type { MCPServerInfo, WorkspaceMCPOverrides } from "@/common/types/mcp";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/browser/components/Dialog/Dialog";
import { useMCPTestCache } from "@/browser/hooks/useMCPTestCache";
import { ToolSelector } from "@/browser/components/ToolSelector/ToolSelector";
import { MCPAddServerForm } from "@/browser/components/MCPAddServerForm/MCPAddServerForm";
import {
  isServerEffectivelyEnabled,
  toggleServerOverride,
} from "@/common/utils/workspaceMcpEffective";

/**
 * Workspace mode: load+save overrides for an existing workspace via api.workspace.mcp.{get,set}.
 * Used from inside an open workspace (kebab menu → "Configure MCP servers").
 */
export interface WorkspaceMCPModalWorkspaceProps {
  mode?: "workspace";
  workspaceId: string;
  projectPath: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Draft mode: no workspace exists yet (creation page). Overrides are staged in
 * the caller's state via `initialOverrides`/`onSave`; persistence happens when
 * the chat is actually submitted and the workspace is created.
 *
 * In draft mode the tool-allowlist UI is hidden (per product decision) and the
 * built-in "Add server" form is shown inline so the user does not have to
 * detour through Settings.
 */
interface WorkspaceMCPModalDraftProps {
  mode: "draft";
  projectPath: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Overrides currently staged in the parent (used as the starting point). */
  initialOverrides: WorkspaceMCPOverrides;
  /** Called on Save with the new staged overrides; the parent owns persistence. */
  onSave: (overrides: WorkspaceMCPOverrides) => void;
}

type WorkspaceMCPModalProps = WorkspaceMCPModalWorkspaceProps | WorkspaceMCPModalDraftProps;

export const WorkspaceMCPModal: React.FC<WorkspaceMCPModalProps> = (props) => {
  const isDraft = props.mode === "draft";
  const mode: "workspace" | "draft" = isDraft ? "draft" : "workspace";
  const { projectPath, open, onOpenChange } = props;
  const workspaceId = isDraft ? null : props.workspaceId;
  const draftInitialOverrides = isDraft ? props.initialOverrides : null;
  const draftOnSave = isDraft ? props.onSave : null;

  const settings = useSettings();
  const { api } = useAPI();

  // State for project servers and workspace overrides
  const [servers, setServers] = useState<Record<string, MCPServerInfo>>({});
  const [overrides, setOverrides] = useState<WorkspaceMCPOverrides>(
    () => draftInitialOverrides ?? {}
  );
  const [loadingTools, setLoadingTools] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Use shared cache for tool test results (workspace mode only; harmless in draft).
  const { getTools, setResult, reload: reloadCache } = useMCPTestCache(projectPath);

  // Ref so the effect can call reloadCache without depending on its identity.
  const reloadCacheRef = useRef(reloadCache);
  reloadCacheRef.current = reloadCache;

  // Snapshot the initial-overrides reference so we can reset the local state when the
  // modal re-opens in draft mode (without resetting on every parent re-render).
  const initialOverridesRef = useRef<WorkspaceMCPOverrides | null>(draftInitialOverrides);
  if (isDraft) {
    initialOverridesRef.current = draftInitialOverrides;
  }

  // Load project servers (and, in workspace mode, the persisted overrides) when the modal opens.
  useEffect(() => {
    if (!open || !api) return;

    // Reload cache when modal opens
    reloadCacheRef.current();

    const loadData = async () => {
      setLoading(true);
      setError(null);
      try {
        const projectServersPromise = api.mcp.list({ projectPath });

        if (mode === "workspace" && workspaceId) {
          const [projectServers, workspaceOverrides] = await Promise.all([
            projectServersPromise,
            api.workspace.mcp.get({ workspaceId }),
          ]);
          setServers(projectServers ?? {});
          setOverrides(workspaceOverrides ?? {});
        } else {
          const projectServers = await projectServersPromise;
          setServers(projectServers ?? {});
          // Draft mode: reset to the snapshot we took when the modal opened.
          setOverrides(initialOverridesRef.current ?? {});
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load MCP configuration");
      } finally {
        setLoading(false);
      }
    };

    void loadData();
  }, [open, api, projectPath, workspaceId, mode]);

  // Refresh the project servers list (used after adding a server in draft mode).
  const refreshServers = useCallback(async () => {
    if (!api) return;
    try {
      const result = await api.mcp.list({ projectPath });
      setServers(result ?? {});
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load MCP servers");
    }
  }, [api, projectPath]);

  // Fetch/refresh tools for a server (workspace mode only — allowlist UI is hidden in draft).
  const fetchTools = useCallback(
    async (serverName: string) => {
      if (!api) return;
      setLoadingTools((prev) => ({ ...prev, [serverName]: true }));
      try {
        const result = await api.mcp.test({ projectPath, name: serverName });
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
    [api, projectPath, setResult]
  );

  /**
   * Determine if a server is effectively enabled for this workspace.
   * Shared three-way rule lives in @/common/utils/workspaceMcpEffective so the
   * creation-page count and the modal toggles always agree.
   */
  const isServerEnabled = useCallback(
    (serverName: string, projectDisabled: boolean): boolean =>
      isServerEffectivelyEnabled(serverName, projectDisabled, overrides),
    [overrides]
  );

  // Toggle server enabled/disabled for workspace
  const toggleServerEnabled = useCallback(
    (serverName: string, enabled: boolean, projectDisabled: boolean) => {
      setOverrides((prev) => toggleServerOverride(prev, serverName, enabled, projectDisabled));
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

  // Save overrides.
  // In workspace mode this persists immediately via api.workspace.mcp.set.
  // In draft mode this delegates to the parent (which stages the overrides for later persistence).
  const handleSave = useCallback(async () => {
    if (isDraft) {
      draftOnSave?.(overrides);
      onOpenChange(false);
      return;
    }

    if (!api || !workspaceId) return;
    setSaving(true);
    setError(null);
    try {
      const result = await api.workspace.mcp.set({ workspaceId, overrides });
      if (!result.success) {
        setError(result.error);
      } else {
        onOpenChange(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save configuration");
    } finally {
      setSaving(false);
    }
  }, [api, workspaceId, overrides, onOpenChange, isDraft, draftOnSave]);

  const serverEntries = Object.entries(servers);

  const handleOpenProjectSettings = useCallback(() => {
    onOpenChange(false);
    settings.open("mcp");
  }, [onOpenChange, settings]);
  const hasServers = serverEntries.length > 0;

  const title = isDraft ? "MCP servers for this chat" : "Workspace MCP Configuration";
  const subtitle = isDraft
    ? "Customize which MCP servers are available for the workspace this chat will create."
    : "Customize which MCP servers and tools are available in this workspace. Changes only affect this workspace.";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[80vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Server className="h-5 w-5" />
            {title}
          </DialogTitle>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="text-muted h-6 w-6 animate-spin" />
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-start justify-between gap-3">
              <p className="text-muted flex-1 pr-3 text-sm">{subtitle}</p>
              <div className="flex shrink-0 items-center gap-2 pt-0.5">
                <Button variant="ghost" onClick={() => onOpenChange(false)}>
                  Cancel
                </Button>
                <Button onClick={() => void handleSave()} disabled={saving}>
                  {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                  Save
                </Button>
              </div>
            </div>

            {error && (
              <div className="bg-danger-soft/10 text-danger-soft rounded-md p-3 text-sm">
                {error}
              </div>
            )}

            {!hasServers ? (
              <div className="text-muted py-2 text-center text-sm">
                {isDraft ? (
                  "No MCP servers configured yet. Add one below."
                ) : (
                  <>
                    <p>No MCP servers configured for this project.</p>
                    <p className="mt-2 text-sm">
                      Configure servers in{" "}
                      <Button
                        type="button"
                        variant="link"
                        className="h-auto p-0 align-baseline"
                        onClick={handleOpenProjectSettings}
                      >
                        Settings → MCP
                      </Button>{" "}
                      to use them here.
                    </p>
                  </>
                )}
              </div>
            ) : (
              <div className="space-y-4">
                {serverEntries.map(([name, info]) => {
                  const projectDisabled = info.disabled;
                  const effectivelyEnabled = isServerEnabled(name, projectDisabled);
                  const tools = getTools(name);
                  const isLoadingTools = loadingTools[name];
                  const allowedTools = overrides.toolAllowlist?.[name] ?? tools ?? [];

                  return (
                    <div
                      key={name}
                      className={cn(
                        "border-border rounded-lg border p-4",
                        !effectivelyEnabled && "opacity-50"
                      )}
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <Switch
                            checked={effectivelyEnabled}
                            onCheckedChange={(checked) =>
                              toggleServerEnabled(name, checked, projectDisabled)
                            }
                            aria-label={`Toggle ${name} MCP server`}
                          />
                          <div>
                            <div className="font-medium">{name}</div>
                            {projectDisabled && (
                              <div className="text-muted text-xs">(disabled at project level)</div>
                            )}
                          </div>
                        </div>
                        {/* Tool allowlist UI is workspace-only (out of scope for the creation modal). */}
                        {!isDraft && effectivelyEnabled && (
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
                        )}
                      </div>

                      {/* Tool allowlist section — workspace mode only */}
                      {!isDraft && effectivelyEnabled && tools && tools.length > 0 && (
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

                      {!isDraft && effectivelyEnabled && tools?.length === 0 && (
                        <div className="text-muted mt-2 text-sm">No tools available</div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {/* Inline "Add server" — draft mode only (workspace mode keeps Settings → MCP as the canonical add surface). */}
            {isDraft && (
              <div className="border-border-medium border-t pt-3">
                <MCPAddServerForm existingServers={servers} onAdded={() => refreshServers()} />
                <div className="text-muted mt-2 text-xs">
                  Need to edit or remove a server?{" "}
                  <Button
                    type="button"
                    variant="link"
                    className="h-auto p-0 align-baseline text-xs"
                    onClick={handleOpenProjectSettings}
                  >
                    Open Settings → MCP
                  </Button>
                  .
                </div>
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
};
