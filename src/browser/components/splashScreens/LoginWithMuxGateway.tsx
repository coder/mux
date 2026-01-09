import React, { useEffect, useState } from "react";
import { SplashScreen } from "./SplashScreen";
import { useAPI } from "@/browser/contexts/API";
import { useSettings } from "@/browser/contexts/SettingsContext";

interface OAuthMessage {
  type?: unknown;
  state?: unknown;
  ok?: unknown;
  error?: unknown;
}

function getBackendBaseUrl(): string {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment, @typescript-eslint/prefer-ts-expect-error
  // @ts-ignore - import.meta is available in Vite
  return import.meta.env.VITE_BACKEND_URL ?? window.location.origin;
}
type LoginStatus = "idle" | "starting" | "waiting" | "success" | "error";

export function LoginWithMuxGatewaySplash(props: { onDismiss: () => void }) {
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
  const [desktopFlowId, setDesktopFlowId] = useState<string | null>(null);
  const [serverState, setServerState] = useState<string | null>(null);

  const handleDismiss = () => {
    if (isDesktop && api && desktopFlowId) {
      void api.muxGatewayOauth.cancelDesktopFlow({ flowId: desktopFlowId });
    }
    props.onDismiss();
  };

  const startLogin = async () => {
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
        if (!startResult.success) {
          setStatus("error");
          setError(startResult.error);
          return;
        }

        const { flowId, authorizeUrl } = startResult.data;
        setDesktopFlowId(flowId);
        setStatus("waiting");

        // Desktop main process intercepts external window.open() calls and routes them via shell.openExternal.
        window.open(authorizeUrl, "_blank", "noopener");

        const waitResult = await api.muxGatewayOauth.waitForDesktopFlow({ flowId });
        if (waitResult.success) {
          setStatus("success");
          return;
        }

        setStatus("error");
        setError(waitResult.error);
        return;
      }

      // Browser/server mode: use unauthenticated bootstrap route.
      setStatus("starting");

      const startUrl = new URL("/auth/mux-gateway/start", backendBaseUrl);
      const res = await fetch(startUrl);

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

      const json = (await res.json()) as {
        authorizeUrl?: unknown;
        state?: unknown;
        error?: unknown;
      };

      if (!res.ok) {
        const message = typeof json.error === "string" ? json.error : `HTTP ${res.status}`;
        throw new Error(message);
      }

      if (typeof json.authorizeUrl !== "string" || typeof json.state !== "string") {
        throw new Error(`Invalid response from ${startUrl.pathname}`);
      }

      setServerState(json.state);
      const popup = window.open(json.authorizeUrl, "_blank");
      if (!popup) {
        throw new Error("Popup blocked - please allow popups and try again.");
      }
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
        setStatus("success");
        return;
      }

      const msg = typeof data.error === "string" ? data.error : "Login failed";
      setStatus("error");
      setError(msg);
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [isDesktop, status, serverState, backendOrigin]);

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
            Log in to Mux Gateway to automatically configure your token under Settings → Providers →
            Mux Gateway.
          </p>

          <p>
            If you haven&apos;t redeemed your Mux voucher yet,{" "}
            <a
              href="https://gateway.mux.coder.com/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent hover:underline"
            >
              claim it here
            </a>
            .
          </p>

          {status === "waiting" && <p>Finish the login flow in your browser, then return here.</p>}

          {status === "error" && error && (
            <p>
              <strong className="text-destructive">Login failed:</strong> {error}
            </p>
          )}

          <p>
            Prefer manual setup?{" "}
            <button
              type="button"
              className="text-accent hover:underline"
              onClick={() => openSettings("providers")}
            >
              Open Settings
            </button>
            .
          </p>
        </div>
      )}
    </SplashScreen>
  );
}
