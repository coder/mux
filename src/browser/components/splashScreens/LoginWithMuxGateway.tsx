import React, { useEffect, useMemo, useRef, useState } from "react";
import { SplashScreen } from "./SplashScreen";
import { useAPI } from "@/browser/contexts/API";
import { getStoredAuthToken } from "@/browser/components/AuthTokenModal";
import { isProviderSupported } from "@/browser/hooks/useGatewayModels";
import { getSuggestedModels } from "@/browser/hooks/useModelsFromSettings";
import { useProvidersConfig } from "@/browser/hooks/useProvidersConfig";
import { readPersistedState, updatePersistedState } from "@/browser/hooks/usePersistedState";
import { useSettings } from "@/browser/contexts/SettingsContext";

interface OAuthMessage {
  type?: unknown;
  state?: unknown;
  ok?: unknown;
  error?: unknown;
}

function getServerAuthToken(): string | null {
  const urlToken = new URLSearchParams(window.location.search).get("token")?.trim();
  return urlToken?.length ? urlToken : getStoredAuthToken();
}
function getBackendBaseUrl(): string {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment, @typescript-eslint/prefer-ts-expect-error
  // @ts-ignore - import.meta is available in Vite
  return import.meta.env.VITE_BACKEND_URL ?? window.location.origin;
}

const GATEWAY_MODELS_KEY = "gateway-models";
const GATEWAY_CONFIGURED_KEY = "gateway-available";
type LoginStatus = "idle" | "starting" | "waiting" | "success" | "error";

export function LoginWithMuxGatewaySplash(props: { onDismiss: () => void }) {
  const { config } = useProvidersConfig();

  const eligibleGatewayModels = useMemo(
    () => getSuggestedModels(config).filter(isProviderSupported),
    [config]
  );

  const applyDefaultModelsOnSuccessRef = useRef(false);
  const { api } = useAPI();
  const { open: openSettings } = useSettings();

  const backendBaseUrl = getBackendBaseUrl();
  const backendOrigin = (() => {
    try {
      return new URL(backendBaseUrl).origin;
    } catch {
      return window.location.origin;
    }
  })();
  const isDesktop = !!window.api;

  const [status, setStatus] = useState<LoginStatus>("idle");
  const [error, setError] = useState<string | null>(null);

  const loginAttemptRef = useRef(0);
  const [desktopFlowId, setDesktopFlowId] = useState<string | null>(null);
  const [serverState, setServerState] = useState<string | null>(null);

  const handleDismiss = () => {
    applyDefaultModelsOnSuccessRef.current = false;
    loginAttemptRef.current++;

    if (isDesktop && api && desktopFlowId) {
      void api.muxGatewayOauth.cancelDesktopFlow({ flowId: desktopFlowId });
    }
    props.onDismiss();
  };

  const startLogin = async () => {
    const attempt = ++loginAttemptRef.current;

    // Enable Mux Gateway for all eligible models after the *first* successful login.
    // (If config isn't loaded yet, fall back to the persisted gateway-available state.)
    const isLoggedIn =
      config?.["mux-gateway"]?.couponCodeSet ??
      readPersistedState<boolean>(GATEWAY_CONFIGURED_KEY, false);
    applyDefaultModelsOnSuccessRef.current = !isLoggedIn;

    try {
      setError(null);

      if (isDesktop) {
        if (!api) {
          setStatus("error");
          setError("Mux API not connected.");
          return;
        }

        setStatus("starting");
        const startResult = await api.muxGatewayOauth.startDesktopFlow();

        if (attempt !== loginAttemptRef.current) {
          if (startResult.success) {
            void api.muxGatewayOauth.cancelDesktopFlow({ flowId: startResult.data.flowId });
          }
          return;
        }

        if (!startResult.success) {
          setStatus("error");
          setError(startResult.error);
          return;
        }

        const { flowId, authorizeUrl } = startResult.data;
        setDesktopFlowId(flowId);
        setStatus("waiting");

        // Desktop main process intercepts external window.open() calls and routes them via shell.openExternal.
        if (attempt !== loginAttemptRef.current) {
          return;
        }

        window.open(authorizeUrl, "_blank", "noopener");

        const waitResult = await api.muxGatewayOauth.waitForDesktopFlow({ flowId });

        if (attempt !== loginAttemptRef.current) {
          return;
        }

        if (waitResult.success) {
          if (applyDefaultModelsOnSuccessRef.current) {
            let latestConfig = config;
            try {
              latestConfig = await api.providers.getConfig();
            } catch {
              // Ignore errors fetching config; fall back to the current snapshot.
            }

            updatePersistedState(
              GATEWAY_MODELS_KEY,
              getSuggestedModels(latestConfig).filter(isProviderSupported)
            );
            applyDefaultModelsOnSuccessRef.current = false;
          }

          setStatus("success");
          return;
        }

        setStatus("error");
        setError(waitResult.error);
        return;
      }

      // Browser/server mode: use unauthenticated bootstrap route.
      // Open popup synchronously to preserve user gesture context (avoids popup blockers).
      const popup = window.open("about:blank", "_blank");
      if (!popup) {
        throw new Error("Popup blocked - please allow popups and try again.");
      }

      setStatus("starting");

      const startUrl = new URL("/auth/mux-gateway/start", backendBaseUrl);
      const authToken = getServerAuthToken();

      let json: { authorizeUrl?: unknown; state?: unknown; error?: unknown };
      try {
        const res = await fetch(startUrl, {
          headers: authToken ? { Authorization: `Bearer ${authToken}` } : undefined,
        });

        const contentType = res.headers.get("content-type") ?? "";
        if (!contentType.includes("application/json")) {
          const body = await res.text();
          const prefix = body.trim().slice(0, 80);
          throw new Error(
            `Unexpected response from ${startUrl.toString()} (expected JSON, got ${
              contentType || "unknown"
            }): ${prefix}`
          );
        }

        json = (await res.json()) as typeof json;

        if (!res.ok) {
          const message = typeof json.error === "string" ? json.error : `HTTP ${res.status}`;
          throw new Error(message);
        }
      } catch (err) {
        popup.close();
        throw err;
      }

      if (attempt !== loginAttemptRef.current) {
        popup.close();
        return;
      }

      if (typeof json.authorizeUrl !== "string" || typeof json.state !== "string") {
        popup.close();
        throw new Error(`Invalid response from ${startUrl.pathname}`);
      }

      setServerState(json.state);
      popup.location.href = json.authorizeUrl;
      setStatus("waiting");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setStatus("error");
      setError(message);
    }
  };

  useEffect(() => {
    if (isDesktop || status !== "waiting" || !serverState) {
      return;
    }

    const handleMessage = (event: MessageEvent<OAuthMessage>) => {
      if (event.origin !== backendOrigin) return;

      const data = event.data;
      if (!data || typeof data !== "object") return;
      if (data.type !== "mux-gateway-oauth") return;
      if (data.state !== serverState) return;

      if (data.ok === true) {
        if (applyDefaultModelsOnSuccessRef.current) {
          updatePersistedState(GATEWAY_MODELS_KEY, eligibleGatewayModels);
          applyDefaultModelsOnSuccessRef.current = false;
        }

        setStatus("success");
        return;
      }

      const msg = typeof data.error === "string" ? data.error : "Login failed";
      setStatus("error");
      setError(msg);
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [isDesktop, status, serverState, backendOrigin, eligibleGatewayModels]);

  const isSuccess = status === "success";

  const primaryLabel =
    status === "error"
      ? "Try again"
      : status === "waiting" || status === "starting"
        ? "Waiting for login..."
        : "Login with Mux Gateway";

  const primaryDisabled = status === "waiting" || status === "starting";

  const dismissLabel = isSuccess
    ? null
    : status === "waiting" || status === "starting"
      ? "Cancel"
      : "Not now";

  return (
    <SplashScreen
      title="Login with Mux Gateway"
      onDismiss={handleDismiss}
      primaryAction={
        isSuccess
          ? { label: "Close", onClick: () => undefined }
          : {
              label: primaryLabel,
              onClick: () => {
                void startLogin();
              },
              disabled: primaryDisabled,
            }
      }
      dismissOnPrimaryAction={isSuccess ? undefined : false}
      dismissLabel={dismissLabel}
    >
      {isSuccess ? (
        <div
          className="text-muted"
          style={{ display: "flex", flexDirection: "column", gap: "12px" }}
        >
          <p>Login successful.</p>
        </div>
      ) : (
        <div
          className="text-muted"
          style={{ display: "flex", flexDirection: "column", gap: "12px" }}
        >
          <p>
            Mux Gateway enables you to use free AI tokens from{" "}
            <a
              href="https://coder.com"
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent hover:underline"
            >
              Coder
            </a>
            .
          </p>

          <p>You can receive those credits through:</p>

          <ul className="ml-4 list-disc space-y-1">
            <li>
              early adopters can request some credits tied to their GH logins on our{" "}
              <a
                href="https://discord.gg/VfZXvtnR"
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent hover:underline"
              >
                Discord
              </a>
            </li>
            <li>
              vouchers which you can{" "}
              <a
                href="https://gateway.mux.coder.com"
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent hover:underline"
              >
                claim here
              </a>
            </li>
          </ul>

          <p>
            You will be able to login through{" "}
            <button
              type="button"
              className="text-accent hover:underline"
              onClick={() => openSettings("providers")}
            >
              Settings
            </button>{" "}
            at any point.
          </p>

          {status === "waiting" && <p>Finish the login flow in your browser, then return here.</p>}

          {status === "error" && error && (
            <p>
              <strong className="text-destructive">Login failed:</strong> {error}
            </p>
          )}
        </div>
      )}
    </SplashScreen>
  );
}
