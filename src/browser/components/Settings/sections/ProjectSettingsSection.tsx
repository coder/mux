import React, { useCallback, useEffect, useRef, useState } from "react";
import { usePolicy } from "@/browser/contexts/PolicyContext";
import { useAPI } from "@/browser/contexts/API";
import { useSettings } from "@/browser/contexts/SettingsContext";
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
  LogIn,
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
import type { CachedMCPTestResult, MCPServerInfo, MCPServerTransport } from "@/common/types/mcp";
import type { MCPOAuthPendingServerConfig } from "@/common/types/mcpOauth";
import { useMCPTestCache } from "@/browser/hooks/useMCPTestCache";
import { MCPHeadersEditor } from "@/browser/components/MCPHeadersEditor";
import {
  mcpHeaderRowsToRecord,
  mcpHeadersRecordToRows,
  type MCPHeaderRow,
} from "@/browser/utils/mcpHeaders";
import { ToolSelector } from "@/browser/components/ToolSelector";
import { KebabMenu, type KebabMenuItem } from "@/browser/components/KebabMenu";

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

type MCPOAuthLoginStatus = "idle" | "starting" | "waiting" | "success" | "error";

interface MCPOAuthAuthStatus {
  serverUrl?: string;
  isLoggedIn: boolean;
  hasRefreshToken: boolean;
  scope?: string;
  updatedAtMs?: number;
}

type MCPOAuthAPI = NonNullable<ReturnType<typeof useAPI>["api"]>["projects"]["mcpOauth"];

function isRecord(value: unknown): value is Record<string, unknown> {
  // In dev-server (browser) mode, the ORPC client can surface namespaces/procedures as Proxy
  // functions (callable objects). Treat functions as record-like so runtime guards don't
  // incorrectly report "OAuth is not available".
  if (value === null) return false;
  const type = typeof value;
  return type === "object" || type === "function";
}

/**
 * Defensive runtime guard: `projects.mcpOauth` may not exist when running against older backends
 * or in non-desktop environments. Treat OAuth as unavailable instead of surfacing raw exceptions.
 */
function getMCPOAuthAPI(api: ReturnType<typeof useAPI>["api"]): MCPOAuthAPI | null {
  if (!api) return null;

  // Avoid direct property access since `api.projects.mcpOauth` may be missing at runtime.
  const maybeOauth: unknown = Reflect.get(api.projects, "mcpOauth");
  if (!isRecord(maybeOauth)) return null;

  const requiredFns = ["getAuthStatus", "logout"] as const;

  for (const fn of requiredFns) {
    if (typeof maybeOauth[fn] !== "function") {
      return null;
    }
  }

  // Login flow support depends on whether the client can complete the callback.
  const hasDesktopFlowFns =
    typeof maybeOauth.startDesktopFlow === "function" &&
    typeof maybeOauth.waitForDesktopFlow === "function" &&
    typeof maybeOauth.cancelDesktopFlow === "function";

  const hasServerFlowFns =
    typeof maybeOauth.startServerFlow === "function" &&
    typeof maybeOauth.waitForServerFlow === "function" &&
    typeof maybeOauth.cancelServerFlow === "function";

  if (!hasDesktopFlowFns && !hasServerFlowFns) {
    return null;
  }

  return maybeOauth as unknown as MCPOAuthAPI;
}

type MCPOAuthLoginFlowMode = "desktop" | "server";

function getMCPOAuthLoginFlowMode(input: {
  isDesktop: boolean;
  mcpOauthApi: MCPOAuthAPI | null;
}): MCPOAuthLoginFlowMode | null {
  const api = input.mcpOauthApi;
  if (!api || !isRecord(api)) {
    return null;
  }

  const hasDesktopFlowFns =
    typeof api.startDesktopFlow === "function" &&
    typeof api.waitForDesktopFlow === "function" &&
    typeof api.cancelDesktopFlow === "function";

  const hasServerFlowFns =
    typeof api.startServerFlow === "function" &&
    typeof api.waitForServerFlow === "function" &&
    typeof api.cancelServerFlow === "function";

  if (input.isDesktop) {
    return hasDesktopFlowFns ? "desktop" : null;
  }

  return hasServerFlowFns ? "server" : null;
}

function useMCPOAuthLogin(input: {
  api: ReturnType<typeof useAPI>["api"];
  isDesktop: boolean;
  projectPath: string;
  serverName: string;
  pendingServer?: MCPOAuthPendingServerConfig;
  onSuccess?: () => void | Promise<void>;
}) {
  const { api, isDesktop, projectPath, serverName, pendingServer, onSuccess } = input;
  const loginAttemptRef = useRef(0);
  const [flowId, setFlowId] = useState<string | null>(null);

  const [loginStatus, setLoginStatus] = useState<MCPOAuthLoginStatus>("idle");
  const [loginError, setLoginError] = useState<string | null>(null);

  const loginInProgress = loginStatus === "starting" || loginStatus === "waiting";

  const cancelLogin = useCallback(() => {
    loginAttemptRef.current++;

    const mcpOauthApi = getMCPOAuthAPI(api);
    const loginFlowMode = getMCPOAuthLoginFlowMode({
      isDesktop,
      mcpOauthApi,
    });

    if (mcpOauthApi && flowId && loginFlowMode === "desktop") {
      void mcpOauthApi.cancelDesktopFlow({ flowId });
    }

    if (mcpOauthApi && flowId && loginFlowMode === "server") {
      void mcpOauthApi.cancelServerFlow({ flowId });
    }

    setFlowId(null);
    setLoginStatus("idle");
    setLoginError(null);
  }, [api, flowId, isDesktop]);

  const startLogin = useCallback(async () => {
    const attempt = ++loginAttemptRef.current;

    try {
      setLoginError(null);
      setFlowId(null);

      if (!api) {
        setLoginStatus("error");
        setLoginError("Mux API not connected.");
        return;
      }

      if (!serverName.trim()) {
        setLoginStatus("error");
        setLoginError("Server name is required to start OAuth login.");
        return;
      }

      const mcpOauthApi = getMCPOAuthAPI(api);
      if (!mcpOauthApi) {
        setLoginStatus("error");
        setLoginError("OAuth is not available in this environment.");
        return;
      }

      const loginFlowMode = getMCPOAuthLoginFlowMode({
        isDesktop,
        mcpOauthApi,
      });
      if (!loginFlowMode) {
        setLoginStatus("error");
        setLoginError("OAuth login is not available in this environment.");
        return;
      }

      setLoginStatus("starting");

      const startResult =
        loginFlowMode === "desktop"
          ? await mcpOauthApi.startDesktopFlow({ projectPath, serverName, pendingServer })
          : await mcpOauthApi.startServerFlow({ projectPath, serverName, pendingServer });

      if (attempt !== loginAttemptRef.current) {
        if (startResult.success) {
          if (loginFlowMode === "desktop") {
            void mcpOauthApi.cancelDesktopFlow({ flowId: startResult.data.flowId });
          } else {
            void mcpOauthApi.cancelServerFlow({ flowId: startResult.data.flowId });
          }
        }
        return;
      }

      if (!startResult.success) {
        setLoginStatus("error");
        setLoginError(startResult.error);
        return;
      }

      const { flowId: nextFlowId, authorizeUrl } = startResult.data;
      setFlowId(nextFlowId);
      setLoginStatus("waiting");

      // Desktop main process intercepts external window.open() calls and routes them via shell.openExternal.
      // In browser mode, this opens a new tab/window.
      const popup = window.open(authorizeUrl, "_blank", "noopener");

      if (!isDesktop && popup === null) {
        setLoginStatus("error");
        setLoginError("If your browser blocked the popup, allow popups and try again.");
        setFlowId(null);
        void mcpOauthApi.cancelServerFlow({ flowId: nextFlowId });
        return;
      }

      if (attempt !== loginAttemptRef.current) {
        return;
      }

      const waitResult =
        loginFlowMode === "desktop"
          ? await mcpOauthApi.waitForDesktopFlow({ flowId: nextFlowId })
          : await mcpOauthApi.waitForServerFlow({ flowId: nextFlowId });

      if (attempt !== loginAttemptRef.current) {
        return;
      }

      if (waitResult.success) {
        setLoginStatus("success");
        await onSuccess?.();
        return;
      }

      setLoginStatus("error");
      setLoginError(waitResult.error);
    } catch (err) {
      if (attempt !== loginAttemptRef.current) {
        return;
      }

      const message = err instanceof Error ? err.message : String(err);
      setLoginStatus("error");
      setLoginError(message);
    }
  }, [api, isDesktop, onSuccess, pendingServer, projectPath, serverName]);

  return {
    loginStatus,
    loginError,
    loginInProgress,
    startLogin,
    cancelLogin,
  };
}

const MCPOAuthRequiredCallout: React.FC<{
  projectPath: string;
  serverName: string;
  pendingServer?: MCPOAuthPendingServerConfig;
  disabledReason?: string;
  onLoginSuccess?: () => void | Promise<void>;
}> = ({ projectPath, serverName, pendingServer, disabledReason, onLoginSuccess }) => {
  const { api } = useAPI();
  const isDesktop = !!window.api;

  const { loginStatus, loginError, loginInProgress, startLogin, cancelLogin } = useMCPOAuthLogin({
    api,
    isDesktop,
    projectPath,
    serverName,
    pendingServer,
    onSuccess: onLoginSuccess,
  });

  const mcpOauthApi = getMCPOAuthAPI(api);
  const loginFlowMode = getMCPOAuthLoginFlowMode({
    isDesktop,
    mcpOauthApi,
  });

  const disabledTitle =
    disabledReason ??
    (!api
      ? "Mux API not connected"
      : !mcpOauthApi
        ? "OAuth is not available in this environment."
        : !loginFlowMode
          ? isDesktop
            ? "OAuth login is not available in this environment."
            : "OAuth login is only available in the desktop app."
          : undefined);

  const loginDisabled = Boolean(disabledReason) || !api || !loginFlowMode || loginInProgress;

  return (
    <div className="bg-warning/10 border-warning/30 text-warning rounded-md border px-3 py-2 text-xs">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium">This server requires OAuth.</p>
          {disabledReason && <p className="text-muted mt-0.5">{disabledReason}</p>}

          {loginStatus === "waiting" && (
            <p className="text-muted mt-0.5">
              Finish the login flow in your browser, then return here.
            </p>
          )}

          {loginStatus === "success" && <p className="text-muted mt-0.5">Logged in.</p>}

          {loginStatus === "error" && loginError && (
            <p className="text-destructive mt-0.5">OAuth error: {loginError}</p>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <Button
            size="sm"
            onClick={() => {
              void startLogin();
            }}
            disabled={loginDisabled}
            title={disabledTitle}
          >
            {loginInProgress ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Waiting for login...
              </>
            ) : (
              "Login via OAuth"
            )}
          </Button>

          {loginStatus === "waiting" && (
            <Button variant="secondary" size="sm" onClick={cancelLogin}>
              Cancel
            </Button>
          )}
        </div>
      </div>
    </div>
  );
};

const RemoteMCPOAuthSection: React.FC<{
  projectPath: string;
  serverName: string;
  transport: Exclude<MCPServerTransport, "stdio">;
  url: string;
  oauthRefreshNonce?: number;
}> = ({ projectPath, serverName, transport, url, oauthRefreshNonce }) => {
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
      const status = await mcpOauthApi.getAuthStatus({ projectPath, serverName });
      setAuthStatus(status);
    } catch (err) {
      setAuthStatus(null);
      setAuthStatusError(err instanceof Error ? err.message : "Failed to load OAuth status");
    } finally {
      setAuthStatusLoading(false);
    }
  }, [api, projectPath, serverName]);

  useEffect(() => {
    void refreshAuthStatus();
  }, [refreshAuthStatus, transport, url, oauthRefreshNonce]);

  const { loginStatus, loginError, loginInProgress, startLogin, cancelLogin } = useMCPOAuthLogin({
    api,
    isDesktop,
    projectPath,
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
      const result = await mcpOauthApi.logout({ projectPath, serverName });
      if (!result.success) {
        setLogoutError(result.error);
        return;
      }

      await refreshAuthStatus();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setLogoutError(message);
    } finally {
      setLogoutInProgress(false);
    }
  }, [api, cancelLogin, projectPath, refreshAuthStatus, serverName]);

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

export const ProjectSettingsSection: React.FC = () => {
  const { api } = useAPI();
  const policyState = usePolicy();
  const mcpAllowUserDefined =
    policyState.status.state === "enforced" ? policyState.policy?.mcp.allowUserDefined : undefined;
  const mcpDisabledByPolicy = Boolean(
    mcpAllowUserDefined?.stdio === false && mcpAllowUserDefined.remote === false
  );
  const { projectsTargetProjectPath, clearProjectsTargetProjectPath } = useSettings();
  const { projects, getSecrets } = useProjectContext();
  const projectList = Array.from(projects.keys());

  // Core state
  const [selectedProject, setSelectedProject] = useState<string>("");
  const [servers, setServers] = useState<Record<string, MCPServerInfo>>({});
  const [loading, setLoading] = useState(false);

  const [projectSecretKeys, setProjectSecretKeys] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Test state with caching
  const {
    cache: testCache,
    setResult: cacheTestResult,
    clearResult: clearTestResult,
  } = useMCPTestCache(selectedProject);
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

  // Add form state

  // Ensure the "Add server" transport select always points to a policy-allowed value.
  useEffect(() => {
    if (!mcpAllowUserDefined) {
      return;
    }

    const isAllowed = (transport: MCPServerTransport): boolean => {
      if (transport === "stdio") {
        return mcpAllowUserDefined.stdio;
      }

      return mcpAllowUserDefined.remote;
    };

    setNewServer((prev) => {
      if (isAllowed(prev.transport)) {
        return prev;
      }

      const fallback: MCPServerTransport | null = mcpAllowUserDefined.stdio
        ? "stdio"
        : mcpAllowUserDefined.remote
          ? "http"
          : null;

      if (!fallback) {
        return prev;
      }

      return { ...prev, transport: fallback, value: "", headersRows: [] };
    });
  }, [mcpAllowUserDefined]);
  const [newServer, setNewServer] = useState<EditableServer>({
    name: "",
    transport: "stdio",
    value: "",
    headersRows: [],
  });
  const [addingServer, setAddingServer] = useState(false);
  const [testingNew, setTestingNew] = useState(false);
  const [newTestResult, setNewTestResult] = useState<CachedMCPTestResult | null>(null);

  // Edit state
  const [editing, setEditing] = useState<EditableServer | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);

  // Set default project when projects load (or when deep-linking into a specific project)
  useEffect(() => {
    if (projectList.length === 0) return;

    if (projectsTargetProjectPath) {
      const target = projectsTargetProjectPath;
      clearProjectsTargetProjectPath();

      if (projectList.includes(target)) {
        setSelectedProject(target);
      } else if (!selectedProject || !projectList.includes(selectedProject)) {
        setSelectedProject(projectList[0]);
      }

      return;
    }

    if (!selectedProject || !projectList.includes(selectedProject)) {
      setSelectedProject(projectList[0]);
    }
  }, [projectList, selectedProject, projectsTargetProjectPath, clearProjectsTargetProjectPath]);

  const refresh = useCallback(async () => {
    if (!api || !selectedProject) return;
    setLoading(true);
    try {
      const mcpResult = await api.projects.mcp.list({ projectPath: selectedProject });
      setServers(mcpResult ?? {});
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load project settings");
    } finally {
      setLoading(false);
    }
  }, [api, selectedProject]);

  useEffect(() => {
    if (!selectedProject) {
      setProjectSecretKeys([]);
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const secrets = await getSecrets(selectedProject);
        if (cancelled) return;
        setProjectSecretKeys(secrets.map((s) => s.key));
      } catch (err) {
        if (cancelled) return;
        console.error("Failed to load project secrets:", err);
        setProjectSecretKeys([]);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [getSecrets, selectedProject]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Clear new-server test result when transport/value/headers change
  useEffect(() => {
    setNewTestResult(null);
  }, [newServer.transport, newServer.value, newServer.headersRows]);

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

  const serverDisplayValue = (entry: MCPServerInfo): string =>
    entry.transport === "stdio" ? entry.command : entry.url;

  const handleTestNewServer = useCallback(async () => {
    if (!api || !selectedProject || !newServer.value.trim()) return;
    setTestingNew(true);
    setNewTestResult(null);

    try {
      const { headers, validation } =
        newServer.transport === "stdio"
          ? { headers: undefined, validation: { errors: [], warnings: [] } }
          : mcpHeaderRowsToRecord(newServer.headersRows, {
              knownSecretKeys: new Set(projectSecretKeys),
            });

      if (validation.errors.length > 0) {
        throw new Error(validation.errors[0]);
      }

      const pendingName = newServer.name.trim();

      const result = await api.projects.mcp.test({
        projectPath: selectedProject,
        ...(newServer.transport === "stdio"
          ? { command: newServer.value.trim() }
          : {
              ...(pendingName ? { name: pendingName } : {}),
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
  }, [
    api,
    selectedProject,
    newServer.name,
    newServer.transport,
    newServer.value,
    newServer.headersRows,
    projectSecretKeys,
  ]);

  const handleAddServer = useCallback(async () => {
    if (!api || !selectedProject || !newServer.name.trim() || !newServer.value.trim()) return;

    const serverName = newServer.name.trim();
    const serverTransport = newServer.transport;
    const serverValue = newServer.value.trim();
    const serverHeadersRows = newServer.headersRows;
    const existingTestResult = newTestResult;

    setAddingServer(true);
    setError(null);

    try {
      const { headers, validation } =
        serverTransport === "stdio"
          ? { headers: undefined, validation: { errors: [], warnings: [] } }
          : mcpHeaderRowsToRecord(serverHeadersRows, {
              knownSecretKeys: new Set(projectSecretKeys),
            });

      if (validation.errors.length > 0) {
        throw new Error(validation.errors[0]);
      }

      const result = await api.projects.mcp.add({
        projectPath: selectedProject,
        name: serverName,
        ...(serverTransport === "stdio"
          ? { transport: "stdio", command: serverValue }
          : {
              transport: serverTransport,
              url: serverValue,
              headers,
            }),
      });

      if (!result.success) {
        setError(result.error ?? "Failed to add MCP server");
        return;
      }

      setNewServer({ name: "", transport: "stdio", value: "", headersRows: [] });
      setNewTestResult(null);
      await refresh();

      // For stdio, avoid running arbitrary user-provided commands automatically.
      if (serverTransport === "stdio") {
        if (existingTestResult?.result.success) {
          cacheTestResult(serverName, existingTestResult.result);
        }
        return;
      }

      // For remote servers, always run a test immediately after adding so OAuth-required servers can
      // surface an OAuth callout without requiring a manual Test click.
      setTestingServer(serverName);
      try {
        const testResult = await api.projects.mcp.test({
          projectPath: selectedProject,
          name: serverName,
        });
        cacheTestResult(serverName, testResult);
      } catch (err) {
        cacheTestResult(serverName, {
          success: false,
          error: err instanceof Error ? err.message : "Test failed",
        });
      } finally {
        setTestingServer(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add MCP server");
    } finally {
      setAddingServer(false);
    }
  }, [api, selectedProject, newServer, newTestResult, refresh, cacheTestResult, projectSecretKeys]);

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
    if (!api || !selectedProject || !editing?.value.trim()) return;
    setSavingEdit(true);
    setError(null);

    try {
      const { headers, validation } =
        editing.transport === "stdio"
          ? { headers: undefined, validation: { errors: [], warnings: [] } }
          : mcpHeaderRowsToRecord(editing.headersRows, {
              knownSecretKeys: new Set(projectSecretKeys),
            });

      if (validation.errors.length > 0) {
        throw new Error(validation.errors[0]);
      }

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
  }, [api, selectedProject, editing, refresh, clearTestResult, projectSecretKeys]);

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

  const newHeadersValidation =
    newServer.transport === "stdio"
      ? { errors: [], warnings: [] }
      : mcpHeaderRowsToRecord(newServer.headersRows, {
          knownSecretKeys: new Set(projectSecretKeys),
        }).validation;

  const canAdd =
    newServer.name.trim().length > 0 &&
    newServer.value.trim().length > 0 &&
    (newServer.transport === "stdio" || newHeadersValidation.errors.length === 0);

  const canTest =
    newServer.value.trim().length > 0 &&
    (newServer.transport === "stdio" || newHeadersValidation.errors.length === 0);

  const editHeadersValidation =
    editing && editing.transport !== "stdio"
      ? mcpHeaderRowsToRecord(editing.headersRows, {
          knownSecretKeys: new Set(projectSecretKeys),
        }).validation
      : { errors: [], warnings: [] };

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
                        <Switch
                          checked={isEnabled}
                          onCheckedChange={(checked) => void handleToggleEnabled(name, checked)}
                          title={isEnabled ? "Disable server" : "Enable server"}
                          className="mt-0.5 shrink-0"
                        />
                        <div className={cn("min-w-0", !isEnabled && "opacity-50")}>
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
                                    secretKeys={projectSecretKeys}
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
                        {!isEditing && remoteEntry && (
                          <div
                            className={cn(
                              "col-start-2 col-span-2 min-w-0",
                              !isEnabled && "opacity-50"
                            )}
                          >
                            <RemoteMCPOAuthSection
                              projectPath={selectedProject}
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
                                projectPath={selectedProject}
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
                        headersRows: [],
                      }))
                    }
                  >
                    <SelectTrigger className="border-border-medium bg-modal-bg h-8 w-full text-sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {mcpAllowUserDefined?.stdio !== false && (
                        <SelectItem value="stdio">Stdio</SelectItem>
                      )}
                      {mcpAllowUserDefined?.remote !== false && (
                        <>
                          <SelectItem value="http">HTTP (Streamable)</SelectItem>
                          <SelectItem value="sse">SSE (Legacy)</SelectItem>
                          <SelectItem value="auto">Auto (HTTP → SSE)</SelectItem>
                        </>
                      )}
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
                    <label className="text-muted mb-1 block text-xs">HTTP headers (optional)</label>
                    <MCPHeadersEditor
                      rows={newServer.headersRows}
                      onChange={(rows) =>
                        setNewServer((prev) => ({
                          ...prev,
                          headersRows: rows,
                        }))
                      }
                      secretKeys={projectSecretKeys}
                      disabled={addingServer || testingNew}
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

                {newTestResult &&
                  !newTestResult.result.success &&
                  newTestResult.result.oauthChallenge && (
                    <div className="mt-2">
                      <MCPOAuthRequiredCallout
                        projectPath={selectedProject}
                        serverName={newServer.name.trim()}
                        pendingServer={(() => {
                          const pendingName = newServer.name.trim();
                          if (!pendingName) {
                            return undefined;
                          }

                          // If the server already exists in config, prefer that config for OAuth.
                          const existing = servers[pendingName];
                          if (existing) {
                            return undefined;
                          }

                          if (newServer.transport === "stdio") {
                            return undefined;
                          }

                          const url = newServer.value.trim();
                          if (!url) {
                            return undefined;
                          }

                          return { transport: newServer.transport, url };
                        })()}
                        disabledReason={(() => {
                          const pendingName = newServer.name.trim();
                          if (!pendingName) {
                            return "Enter a server name to enable OAuth login.";
                          }

                          const existing = servers[pendingName];

                          const transport = existing?.transport ?? newServer.transport;
                          if (transport === "stdio") {
                            return "OAuth login is only supported for remote (http/sse) MCP servers.";
                          }

                          return undefined;
                        })()}
                        onLoginSuccess={async () => {
                          setMcpOauthRefreshNonce((prev) => prev + 1);
                          await handleTestNewServer();
                        }}
                      />
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
          </>
        )}
      </div>
    </div>
  );
};
