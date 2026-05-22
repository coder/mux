import React, { useCallback, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/browser/components/Button/Button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/browser/components/Tooltip/Tooltip";
import { useAPI } from "@/browser/contexts/API";
import { getErrorMessage } from "@/common/utils/errors";
import type { MCPOAuthPendingServerConfig } from "@/common/types/mcpOauth";

export type MCPOAuthLoginStatus = "idle" | "starting" | "waiting" | "success" | "error";

export interface MCPOAuthAuthStatus {
  serverUrl?: string;
  isLoggedIn: boolean;
  hasRefreshToken: boolean;
  scope?: string;
  updatedAtMs?: number;
}

export type MCPOAuthAPI = NonNullable<ReturnType<typeof useAPI>["api"]>["mcpOauth"];

export function isRecord(value: unknown): value is Record<string, unknown> {
  // In dev-server (browser) mode, the ORPC client can surface namespaces/procedures as Proxy
  // functions (callable objects). Treat functions as record-like so runtime guards don't
  // incorrectly report "OAuth is not available".
  if (value === null) return false;
  const type = typeof value;
  return type === "object" || type === "function";
}

/**
 * Defensive runtime guard: `mcpOauth` may not exist when running against older backends
 * or in non-desktop environments. Treat OAuth as unavailable instead of surfacing raw exceptions.
 */
export function getMCPOAuthAPI(api: ReturnType<typeof useAPI>["api"]): MCPOAuthAPI | null {
  if (!api) return null;

  // Avoid direct property access since `api.mcpOauth` may be missing at runtime.
  const maybeOauth: unknown = Reflect.get(api, "mcpOauth");
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

export type MCPOAuthLoginFlowMode = "desktop" | "server";

export function getMCPOAuthLoginFlowMode(input: {
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

export function useMCPOAuthLogin(input: {
  api: ReturnType<typeof useAPI>["api"];
  isDesktop: boolean;
  serverName: string;
  pendingServer?: MCPOAuthPendingServerConfig;
  onSuccess?: () => void | Promise<void>;
}) {
  const { api, isDesktop, serverName, pendingServer, onSuccess } = input;
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
          ? await mcpOauthApi.startDesktopFlow({ serverName, pendingServer })
          : await mcpOauthApi.startServerFlow({ serverName, pendingServer });

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
      //
      // NOTE: In some browsers (especially when using `noopener`), `window.open()` may return null even when
      // the tab opens successfully. Do not treat a null return value as a failure signal; keep the OAuth flow
      // alive and show guidance to the user while we wait.
      try {
        window.open(authorizeUrl, "_blank", "noopener");
      } catch {
        // Popups can be blocked or restricted by the browser. The user can cancel and retry after allowing
        // popups; we intentionally do not auto-cancel the server flow here.
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

      const message = getErrorMessage(err);
      setLoginStatus("error");
      setLoginError(message);
    }
  }, [api, isDesktop, onSuccess, pendingServer, serverName]);

  return {
    loginStatus,
    loginError,
    loginInProgress,
    startLogin,
    cancelLogin,
  };
}

export const MCPOAuthRequiredCallout: React.FC<{
  serverName: string;
  pendingServer?: MCPOAuthPendingServerConfig;
  disabledReason?: string;
  onLoginSuccess?: () => void | Promise<void>;
}> = ({ serverName, pendingServer, disabledReason, onLoginSuccess }) => {
  const { api } = useAPI();
  const isDesktop = !!window.api;

  const { loginStatus, loginError, loginInProgress, startLogin, cancelLogin } = useMCPOAuthLogin({
    api,
    isDesktop,
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

  const loginButton = (
    <Button
      size="sm"
      onClick={() => {
        void startLogin();
      }}
      disabled={loginDisabled}
      aria-label="Login via OAuth"
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
  );

  return (
    <div className="bg-warning/10 border-warning/30 text-warning rounded-md border px-3 py-2 text-xs">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium">This server requires OAuth.</p>
          {disabledReason && <p className="text-muted mt-0.5">{disabledReason}</p>}

          {loginStatus === "waiting" && (
            <>
              <p className="text-muted mt-0.5">
                Finish the login flow in your browser, then return here.
              </p>
              {!isDesktop && (
                <p className="text-muted mt-0.5">
                  If a new tab didn&apos;t open, your browser may have blocked the popup. Allow
                  popups and try again.
                </p>
              )}
            </>
          )}

          {loginStatus === "success" && <p className="text-muted mt-0.5">Logged in.</p>}

          {loginStatus === "error" && loginError && (
            <p className="text-destructive mt-0.5">OAuth error: {loginError}</p>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {disabledTitle ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex">{loginButton}</span>
              </TooltipTrigger>
              <TooltipContent side="top">{disabledTitle}</TooltipContent>
            </Tooltip>
          ) : (
            loginButton
          )}

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
