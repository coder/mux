import React, { useCallback, useEffect, useState } from "react";
import { usePolicy } from "@/browser/contexts/PolicyContext";
import { useAPI } from "@/browser/contexts/API";
import {
  Trash2,
  Play,
  Loader2,
  XCircle,
  Pencil,
  Check,
  X,
  LogIn,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import { Button } from "@/browser/components/Button/Button";
import { createEditKeyHandler } from "@/browser/utils/ui/keybinds";
import { Switch } from "@/browser/components/Switch/Switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/browser/components/Tooltip/Tooltip";
import { cn } from "@/common/lib/utils";
import { formatRelativeTime } from "@/browser/utils/ui/dateTime";
import type { MCPServerInfo, MCPServerTransport } from "@/common/types/mcp";
import { useMCPTestCache } from "@/browser/hooks/useMCPTestCache";
import { MCPHeadersEditor } from "@/browser/components/MCPHeadersEditor/MCPHeadersEditor";
import {
  mcpHeaderRowsToRecord,
  mcpHeadersRecordToRows,
  type MCPHeaderRow,
} from "@/browser/utils/mcpHeaders";
import { ToolSelector } from "@/browser/components/ToolSelector/ToolSelector";
import { KebabMenu, type KebabMenuItem } from "@/browser/components/KebabMenu/KebabMenu";
import { getErrorMessage } from "@/common/utils/errors";
import { MCPAddServerForm } from "@/browser/components/MCPAddServerForm/MCPAddServerForm";
import {
  getMCPOAuthAPI,
  getMCPOAuthLoginFlowMode,
  MCPOAuthRequiredCallout,
  useMCPOAuthLogin,
  type MCPOAuthAuthStatus,
} from "@/browser/components/MCPOAuth/MCPOAuth";

/** Component for managing tool allowlist for a single MCP server */
const ToolAllowlistSection: React.FC<{
  serverName: string;
  availableTools: string[];
  currentAllowlist?: string[];
  testedAt: number;
}> = ({ serverName, availableTools, currentAllowlist, testedAt }) => {
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
        const result = await api.mcp.setToolAllowlist({
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
    [api, serverName, localAllowlist, currentAllowlist, availableTools]
  );

  const handleAllowAll = useCallback(async () => {
    if (!api || allAllowed) return;

    const newAllowlist = [...availableTools];
    setLocalAllowlist(newAllowlist);
    setSaving(true);

    try {
      const result = await api.mcp.setToolAllowlist({
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
  }, [api, serverName, allAllowed, currentAllowlist, availableTools]);

  const handleSelectNone = useCallback(async () => {
    if (!api || allDisabled) return;

    setLocalAllowlist([]);
    setSaving(true);

    try {
      const result = await api.mcp.setToolAllowlist({
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
  }, [api, serverName, allDisabled, currentAllowlist, availableTools]);

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

const RemoteMCPOAuthSection: React.FC<{
  serverName: string;
  transport: Exclude<MCPServerTransport, "stdio">;
  url: string;
  oauthRefreshNonce?: number;
}> = ({ serverName, transport, url, oauthRefreshNonce }) => {
  const { api } = useAPI();
  const isDesktop = !!window.api;

  const [authStatus, setAuthStatus] = useState<MCPOAuthAuthStatus | null>(null);
  const [authStatusLoading, setAuthStatusLoading] = useState(false);
  const [authStatusError, setAuthStatusError] = useState<string | null>(null);

  const [logoutInProgress, setLogoutInProgress] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);

  const refreshAuthStatus = useCallback(async () => {
    const mcpOauthApi = getMCPOAuthAPI(api);
    if (!mcpOauthApi) {
      setAuthStatus(null);
      setAuthStatusLoading(false);
      setAuthStatusError(null);
      return;
    }

    setAuthStatusLoading(true);
    setAuthStatusError(null);

    try {
      const status = await mcpOauthApi.getAuthStatus({ serverUrl: url });
      setAuthStatus(status);
    } catch (err) {
      setAuthStatus(null);
      setAuthStatusError(err instanceof Error ? err.message : "Failed to load OAuth status");
    } finally {
      setAuthStatusLoading(false);
    }
  }, [api, url]);

  useEffect(() => {
    void refreshAuthStatus();
  }, [refreshAuthStatus, transport, url, oauthRefreshNonce]);

  const { loginStatus, loginError, loginInProgress, startLogin, cancelLogin } = useMCPOAuthLogin({
    api,
    isDesktop,
    serverName,
    onSuccess: refreshAuthStatus,
  });

  const mcpOauthApi = getMCPOAuthAPI(api);
  const oauthAvailable = Boolean(mcpOauthApi);
  const loginFlowMode = getMCPOAuthLoginFlowMode({ isDesktop, mcpOauthApi });
  const oauthActionsAvailable = oauthAvailable && Boolean(loginFlowMode);

  const isLoggedIn = (authStatus?.isLoggedIn ?? false) || loginStatus === "success";

  const oauthDebugErrors = [
    authStatusError ? { label: "Status", message: authStatusError } : null,
    loginStatus === "error" && loginError ? { label: "Login", message: loginError } : null,
    logoutError ? { label: "Logout", message: logoutError } : null,
  ].filter((entry): entry is { label: string; message: string } => entry !== null);

  const authStatusText = !oauthAvailable
    ? "Not available"
    : authStatusLoading
      ? "Checking..."
      : loginInProgress
        ? "Waiting..."
        : oauthDebugErrors.length > 0
          ? "Error"
          : isLoggedIn
            ? "Logged in"
            : "Not logged in";

  const updatedAtText =
    oauthAvailable && isLoggedIn && authStatus?.updatedAtMs
      ? ` (${formatRelativeTime(authStatus.updatedAtMs)})`
      : "";

  const loginButtonLabel = loginStatus === "error" ? "Retry" : "Login";
  const reloginMenuLabel = loginStatus === "error" ? "Retry login" : "Re-login";

  const logout = useCallback(async () => {
    const mcpOauthApi = getMCPOAuthAPI(api);
    if (!mcpOauthApi) {
      setLogoutError("OAuth is not available in this environment.");
      return;
    }

    setLogoutError(null);
    cancelLogin();
    setLogoutInProgress(true);

    try {
      const result = await mcpOauthApi.logout({ serverUrl: url });
      if (!result.success) {
        setLogoutError(result.error);
        return;
      }

      await refreshAuthStatus();
    } catch (err) {
      const message = getErrorMessage(err);
      setLogoutError(message);
    } finally {
      setLogoutInProgress(false);
    }
  }, [api, cancelLogin, refreshAuthStatus, url]);

  return (
    <div className="mt-1 flex items-center justify-between gap-2">
      <div className="flex min-w-0 items-center gap-2 text-xs">
        <span className="text-foreground font-medium">OAuth</span>
        <span className="text-muted truncate">
          {authStatusText}
          {updatedAtText}
        </span>

        {oauthDebugErrors.length > 0 && (
          <details className="group inline-block">
            <summary className="text-muted hover:text-foreground cursor-pointer list-none text-[11px] underline-offset-2 group-open:underline">
              Details
            </summary>
            <div className="border-border-medium bg-background-secondary mt-1 space-y-1 rounded-md border px-2 py-1 text-xs">
              {oauthDebugErrors.map((entry) => (
                <div key={entry.label} className="text-destructive break-words">
                  <span className="font-medium">{entry.label}:</span> {entry.message}
                </div>
              ))}
            </div>
          </details>
        )}
      </div>

      {oauthActionsAvailable && (
        <div className="flex shrink-0 items-center gap-1">
          {loginInProgress ? (
            <>
              <Button variant="outline" size="sm" className="h-7 px-2" disabled>
                <Loader2 className="h-3 w-3 animate-spin" />
                {isLoggedIn ? "Re-login" : "Login"}
              </Button>

              <Button variant="ghost" size="sm" className="h-7 px-2" onClick={cancelLogin}>
                Cancel
              </Button>
            </>
          ) : isLoggedIn ? (
            <>
              {logoutInProgress && <Loader2 className="text-muted h-3 w-3 animate-spin" />}
              <KebabMenu
                className="h-7 w-7 px-0 text-xs"
                items={
                  [
                    {
                      label: reloginMenuLabel,
                      onClick: () => {
                        void startLogin();
                      },
                      disabled: logoutInProgress,
                    },
                    {
                      label: logoutInProgress ? "Logging out..." : "Logout",
                      onClick: () => {
                        void logout();
                      },
                      disabled: logoutInProgress,
                    },
                  ] satisfies KebabMenuItem[]
                }
              />
            </>
          ) : (
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2"
              onClick={() => {
                void startLogin();
              }}
              disabled={logoutInProgress}
            >
              <LogIn />
              {loginButtonLabel}
            </Button>
          )}
        </div>
      )}
    </div>
  );
};

export const MCPSettingsSection: React.FC = () => {
  const { api } = useAPI();
  const policyState = usePolicy();
  const mcpAllowUserDefined =
    policyState.status.state === "enforced" ? policyState.policy?.mcp.allowUserDefined : undefined;
  const mcpDisabledByPolicy = Boolean(
    mcpAllowUserDefined?.stdio === false && mcpAllowUserDefined.remote === false
  );
  const [servers, setServers] = useState<Record<string, MCPServerInfo>>({});
  const [loading, setLoading] = useState(false);
  const [globalSecretKeys, setGlobalSecretKeys] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Test state with caching (global MCP config)
  const {
    cache: testCache,
    setResult: cacheTestResult,
    clearResult: clearTestResult,
  } = useMCPTestCache("__global__");
  const [testingServer, setTestingServer] = useState<string | null>(null);
  const [mcpOauthRefreshNonce, setMcpOauthRefreshNonce] = useState(0);

  interface EditableServer {
    name: string;
    transport: MCPServerTransport;
    /** command (stdio) or url (http/sse/auto) */
    value: string;
    /** Headers (http/sse/auto only) */
    headersRows: MCPHeaderRow[];
  }

  // Edit state
  const [editing, setEditing] = useState<EditableServer | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);

  const refresh = useCallback(async () => {
    if (!api) return;
    setLoading(true);
    try {
      const mcpResult = await api.mcp.list({});
      setServers(mcpResult ?? {});
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load MCP servers");
    } finally {
      setLoading(false);
    }
  }, [api]);

  // Load global secrets (used for {secret:"KEY"} header values).
  useEffect(() => {
    if (!api) {
      setGlobalSecretKeys([]);
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const secrets = await api.secrets.get({});
        if (cancelled) return;
        setGlobalSecretKeys(secrets.map((s) => s.key));
      } catch (err) {
        if (cancelled) return;
        console.error("Failed to load global secrets:", err);
        setGlobalSecretKeys([]);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleRemove = useCallback(
    async (name: string) => {
      if (!api) return;
      setLoading(true);
      try {
        const result = await api.mcp.remove({ name });
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
    [api, refresh, clearTestResult]
  );

  const handleToggleEnabled = useCallback(
    async (name: string, enabled: boolean) => {
      if (!api) return;
      // Optimistic update
      setServers((prev) => ({
        ...prev,
        [name]: { ...prev[name], disabled: !enabled },
      }));
      try {
        const result = await api.mcp.setEnabled({
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
    [api]
  );

  const handleTest = useCallback(
    async (name: string) => {
      if (!api) return;
      setTestingServer(name);
      try {
        const result = await api.mcp.test({ name });
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
    [api, cacheTestResult]
  );

  const serverDisplayValue = (entry: MCPServerInfo): string =>
    entry.transport === "stdio" ? entry.command : entry.url;

  const handleStartEdit = useCallback((name: string, entry: MCPServerInfo) => {
    setEditing({
      name,
      transport: entry.transport,
      value: entry.transport === "stdio" ? entry.command : entry.url,
      headersRows: entry.transport === "stdio" ? [] : mcpHeadersRecordToRows(entry.headers),
    });
  }, []);

  const handleCancelEdit = useCallback(() => {
    setEditing(null);
  }, []);

  const handleSaveEdit = useCallback(async () => {
    if (!api || !editing?.value.trim()) return;
    setSavingEdit(true);
    setError(null);

    try {
      const { headers, validation } =
        editing.transport === "stdio"
          ? { headers: undefined, validation: { errors: [], warnings: [] } }
          : mcpHeaderRowsToRecord(editing.headersRows, {
              knownSecretKeys: new Set(globalSecretKeys),
            });

      if (validation.errors.length > 0) {
        throw new Error(validation.errors[0]);
      }

      const result = await api.mcp.add({
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
  }, [api, editing, refresh, clearTestResult, globalSecretKeys]);

  const editHeadersValidation =
    editing && editing.transport !== "stdio"
      ? mcpHeaderRowsToRecord(editing.headersRows, {
          knownSecretKeys: new Set(globalSecretKeys),
        }).validation
      : { errors: [], warnings: [] };

  return (
    <div className="space-y-6">
      {/* Intro */}
      <div>
        <p className="text-muted mb-4 text-xs">
          Configure global MCP servers. Global config lives in{" "}
          <code className="text-accent">~/.mux/mcp.jsonc</code>, with optional repo overrides in{" "}
          <code className="text-accent">./.mux/mcp.jsonc</code> and workspace overrides in{" "}
          <code className="text-accent">.mux/mcp.local.jsonc</code>.
        </p>
      </div>

      {/* MCP Servers */}
      <div>
        <h3 className="text-foreground mb-4 text-sm font-medium">MCP Servers</h3>

        {mcpDisabledByPolicy ? (
          <p className="text-muted py-2 text-sm">MCP servers are disabled by policy.</p>
        ) : (
          <>
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
                  const remoteEntry = entry.transport === "stdio" ? null : entry;
                  return (
                    <div
                      key={name}
                      className="border-border-medium bg-background-secondary overflow-hidden rounded-md border"
                    >
                      <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-3 px-3 py-2">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <div className="mt-0.5 shrink-0">
                              <Switch
                                checked={isEnabled}
                                onCheckedChange={(checked) =>
                                  void handleToggleEnabled(name, checked)
                                }
                                aria-label={`Toggle ${name} enabled`}
                              />
                            </div>
                          </TooltipTrigger>
                          <TooltipContent side="top">
                            {isEnabled ? "Disable server" : "Enable server"}
                          </TooltipContent>
                        </Tooltip>
                        <div className={cn("min-w-0", !isEnabled && "opacity-50")}>
                          <div className="flex items-center gap-2">
                            <span className="text-foreground text-sm font-medium">{name}</span>
                            {cached?.result.success && !isEditing && isEnabled && (
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <span className="rounded bg-green-500/10 px-1.5 py-0.5 text-xs text-green-500">
                                    {cached.result.tools.length} tools
                                  </span>
                                </TooltipTrigger>
                                <TooltipContent side="top">
                                  Tested {formatRelativeTime(cached.testedAt)}
                                </TooltipContent>
                              </Tooltip>
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
                                <div>
                                  <div className="text-muted mb-1 text-[11px]">
                                    HTTP headers (optional)
                                  </div>
                                  <MCPHeadersEditor
                                    rows={editing.headersRows}
                                    onChange={(rows) =>
                                      setEditing({
                                        ...editing,
                                        headersRows: rows,
                                      })
                                    }
                                    secretKeys={globalSecretKeys}
                                    disabled={savingEdit}
                                  />
                                </div>
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
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <span className="inline-flex">
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      onClick={() => void handleSaveEdit()}
                                      disabled={
                                        savingEdit ||
                                        !editing.value.trim() ||
                                        editHeadersValidation.errors.length > 0
                                      }
                                      className="h-7 w-7 text-green-500 hover:text-green-400"
                                      aria-label="Save"
                                    >
                                      {savingEdit ? (
                                        <Loader2 className="h-4 w-4 animate-spin" />
                                      ) : (
                                        <Check className="h-4 w-4" />
                                      )}
                                    </Button>
                                  </span>
                                </TooltipTrigger>
                                <TooltipContent side="top">Save (Enter)</TooltipContent>
                              </Tooltip>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <span className="inline-flex">
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      onClick={handleCancelEdit}
                                      disabled={savingEdit}
                                      className="text-muted hover:text-foreground h-7 w-7"
                                      aria-label="Cancel"
                                    >
                                      <X className="h-4 w-4" />
                                    </Button>
                                  </span>
                                </TooltipTrigger>
                                <TooltipContent side="top">Cancel (Esc)</TooltipContent>
                              </Tooltip>
                            </>
                          ) : (
                            <>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <span className="inline-flex">
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      onClick={() => void handleTest(name)}
                                      disabled={isTesting}
                                      className="text-muted hover:text-accent h-7 w-7"
                                      aria-label="Test connection"
                                    >
                                      {isTesting ? (
                                        <Loader2 className="h-4 w-4 animate-spin" />
                                      ) : (
                                        <Play className="h-4 w-4" />
                                      )}
                                    </Button>
                                  </span>
                                </TooltipTrigger>
                                <TooltipContent side="top">Test connection</TooltipContent>
                              </Tooltip>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <span className="inline-flex">
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      onClick={() => handleStartEdit(name, entry)}
                                      className="text-muted hover:text-accent h-7 w-7"
                                      aria-label="Edit server"
                                    >
                                      <Pencil className="h-4 w-4" />
                                    </Button>
                                  </span>
                                </TooltipTrigger>
                                <TooltipContent side="top">Edit server</TooltipContent>
                              </Tooltip>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <span className="inline-flex">
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      onClick={() => void handleRemove(name)}
                                      disabled={loading}
                                      className="text-muted hover:text-error h-7 w-7"
                                      aria-label="Remove server"
                                    >
                                      <Trash2 className="h-4 w-4" />
                                    </Button>
                                  </span>
                                </TooltipTrigger>
                                <TooltipContent side="top">Remove server</TooltipContent>
                              </Tooltip>
                            </>
                          )}
                        </div>
                        {!isEditing && remoteEntry && (
                          <div
                            className={cn(
                              "col-start-2 col-span-2 min-w-0",
                              !isEnabled && "opacity-50"
                            )}
                          >
                            <RemoteMCPOAuthSection
                              serverName={name}
                              transport={remoteEntry.transport}
                              url={remoteEntry.url}
                              oauthRefreshNonce={mcpOauthRefreshNonce}
                            />
                          </div>
                        )}
                      </div>
                      {cached && !cached.result.success && !isEditing && (
                        <div className="border-border-medium border-t px-3 py-2 text-xs">
                          <div className="text-destructive flex items-start gap-1.5">
                            <XCircle className="mt-0.5 h-3 w-3 shrink-0" />
                            <span>{cached.result.error}</span>
                          </div>

                          {cached.result.oauthChallenge && (
                            <div className="mt-2">
                              <MCPOAuthRequiredCallout
                                serverName={name}
                                disabledReason={
                                  remoteEntry
                                    ? undefined
                                    : "OAuth login is only supported for remote (http/sse) MCP servers."
                                }
                                onLoginSuccess={async () => {
                                  setMcpOauthRefreshNonce((prev) => prev + 1);
                                  await handleTest(name);
                                }}
                              />
                            </div>
                          )}
                        </div>
                      )}
                      {cached?.result.success && cached.result.tools.length > 0 && !isEditing && (
                        <div className="border-border-medium border-t px-3 py-2">
                          <ToolAllowlistSection
                            serverName={name}
                            availableTools={cached.result.tools}
                            currentAllowlist={entry.toolAllowlist}
                            testedAt={cached.testedAt}
                          />
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>

            {/* Add server form */}
            <MCPAddServerForm existingServers={servers} onAdded={() => refresh()} />
          </>
        )}
      </div>
    </div>
  );
};
