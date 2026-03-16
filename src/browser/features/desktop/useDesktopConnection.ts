import { useEffect, useRef, useState, type RefObject } from "react";
import type RFB from "@novnc/novnc/lib/rfb";
import { useAPI } from "@/browser/contexts/API";
import { getBrowserBackendBaseUrl } from "@/browser/utils/backendBaseUrl";
import { DESKTOP_DEFAULTS } from "@/common/constants/desktop";
import type { DesktopCapability } from "@/common/types/desktop";
import { getErrorMessage } from "@/common/utils/errors";

export type DesktopConnectionState =
  | "idle"
  | "checking"
  | "unavailable"
  | "connecting"
  | "connected"
  | "disconnected"
  | "error";

export interface UseDesktopConnectionResult {
  state: DesktopConnectionState;
  reason: string | null;
  rfbRef: RefObject<RFB>;
  containerRef: RefObject<HTMLDivElement>;
  connect: () => void;
  disconnect: () => void;
  width: number;
  height: number;
}

type DesktopUnavailableReason = Extract<DesktopCapability, { available: false }>["reason"];

const UNAVAILABLE_REASONS: Record<DesktopUnavailableReason, string> = {
  disabled: "Desktop sessions are disabled",
  unsupported_platform: "Desktop sessions are not supported on this platform",
  unsupported_runtime: "Desktop sessions are not supported in this runtime",
  startup_failed: "Desktop session failed to start",
  binary_not_found: "Desktop binary not found",
};

function assertDesktop(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function getDesktopBridgeBaseUrl(): URL {
  if (typeof window !== "undefined") {
    try {
      // User rationale: the desktop bridge reuses the backend bind host, so the renderer should
      // derive the bridge host from the same backend origin instead of assuming loopback.
      const backendBaseUrl = new URL(getBrowserBackendBaseUrl());
      if (backendBaseUrl.hostname.length > 0) {
        return backendBaseUrl;
      }
    } catch {
      // Fall through to window.location-derived fallbacks below.
    }

    if (window.location.hostname.length > 0) {
      return new URL(`http://${window.location.hostname}`);
    }

    if (window.location.protocol === "http:" || window.location.protocol === "https:") {
      return new URL(window.location.origin);
    }
  }

  return new URL("http://localhost");
}

function buildDesktopBridgeUrl(bridgePort: number, token: string): string {
  assertDesktop(
    Number.isInteger(bridgePort) && bridgePort > 0,
    "Desktop bootstrap response is missing a valid bridgePort."
  );
  assertDesktop(token.length > 0, "Desktop bootstrap response is missing a valid token.");

  const wsUrl = new URL(getDesktopBridgeBaseUrl().origin);
  // Derive ws/wss from page protocol — in HTTPS deployments, a reverse proxy handles TLS
  // termination for the bridge.
  wsUrl.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  wsUrl.port = String(bridgePort);
  wsUrl.pathname = "/";
  wsUrl.search = "";
  wsUrl.searchParams.set("token", token);
  return wsUrl.toString();
}

export function useDesktopConnection(workspaceId: string): UseDesktopConnectionResult {
  const { api } = useAPI();
  const [state, setState] = useState<DesktopConnectionState>("idle");
  const [reason, setReason] = useState<string | null>(null);
  const [width, setWidth] = useState<number>(DESKTOP_DEFAULTS.WIDTH);
  const [height, setHeight] = useState<number>(DESKTOP_DEFAULTS.HEIGHT);

  const rfbRef = useRef<RFB | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const hasEverConnectedRef = useRef(false);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attemptRef = useRef(0);
  const generationRef = useRef(0);
  const isDisposedRef = useRef(false);

  const connectImplRef = useRef<() => void>(() => undefined);
  const disconnectImplRef = useRef<() => void>(() => undefined);
  const connectHandleRef = useRef<() => void>(() => connectImplRef.current());
  const disconnectHandleRef = useRef<() => void>(() => disconnectImplRef.current());
  const scheduleReconnectRef = useRef<() => void>(() => undefined);

  const clearReconnectTimer = () => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  };

  const disconnectCurrentRfb = () => {
    const currentRfb = rfbRef.current;
    rfbRef.current = null;
    if (!currentRfb) {
      return;
    }

    try {
      currentRfb.disconnect();
    } catch {
      // noVNC disconnect can race with its own close handling; treat teardown as idempotent.
    }
  };

  scheduleReconnectRef.current = () => {
    if (isDisposedRef.current) {
      return;
    }

    clearReconnectTimer();
    const delay = Math.min(
      DESKTOP_DEFAULTS.RECONNECT_BASE_DELAY_MS * 2 ** attemptRef.current,
      DESKTOP_DEFAULTS.RECONNECT_MAX_DELAY_MS
    );
    attemptRef.current += 1;
    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null;
      if (isDisposedRef.current) {
        return;
      }
      connectHandleRef.current();
    }, delay);
  };

  disconnectImplRef.current = () => {
    isDisposedRef.current = true;
    generationRef.current += 1;
    clearReconnectTimer();
    disconnectCurrentRfb();
    setState("idle");
    setReason(null);
  };

  connectImplRef.current = () => {
    void (async () => {
      const generation = generationRef.current + 1;
      generationRef.current = generation;
      isDisposedRef.current = false;
      clearReconnectTimer();
      disconnectCurrentRfb();
      setReason(null);

      if (!api) {
        // User rationale: the Desktop tab can mount while the API client is still reconnecting,
        // so treat a missing API client as transient and retry instead of wedging the hook in error.
        setState("connecting");
        reconnectTimerRef.current = setTimeout(() => {
          reconnectTimerRef.current = null;
          if (isDisposedRef.current || generationRef.current !== generation) {
            return;
          }
          connectHandleRef.current();
        }, DESKTOP_DEFAULTS.RECONNECT_BASE_DELAY_MS);
        return;
      }

      setState("checking");

      try {
        const result = await api.desktop.getBootstrap({ workspaceId });
        if (generationRef.current !== generation || isDisposedRef.current) {
          return;
        }

        if (!result.capability.available) {
          if (hasEverConnectedRef.current) {
            // A prior successful session means bootstrap unavailability is part of the reconnect
            // loop, so keep retrying instead of wedging the panel in a permanent unavailable state.
            setState("disconnected");
            setReason(null);
            scheduleReconnectRef.current();
            return;
          }
          setState("unavailable");
          setReason(UNAVAILABLE_REASONS[result.capability.reason]);
          return;
        }

        const bridgePort = result.bridgePort;
        assertDesktop(
          bridgePort != null,
          "Desktop bootstrap response is missing a valid bridgePort."
        );
        const token = result.token;
        assertDesktop(
          typeof token === "string" && token.length > 0,
          "Desktop bootstrap response is missing a valid token."
        );
        const wsUrl = buildDesktopBridgeUrl(bridgePort, token);
        setWidth(result.capability.width);
        setHeight(result.capability.height);

        const container = containerRef.current;
        assertDesktop(container, "Desktop panel container is not mounted.");

        // noVNC's CommonJS entry reaches a transitive dependency with top-level await,
        // so Vite dev mode must load it lazily instead of pre-bundling a static import.
        const { default: RFB } = await import("@novnc/novnc/lib/rfb");
        // Guard against stale connection after async import
        if (isDisposedRef.current || generation !== generationRef.current) {
          return;
        }
        const rfb = new RFB(container, wsUrl);
        rfb.scaleViewport = true;
        rfb.resizeSession = false;

        const handleConnect = () => {
          if (generationRef.current !== generation || isDisposedRef.current) {
            return;
          }
          hasEverConnectedRef.current = true;
          attemptRef.current = 0;
          setState("connected");
          setReason(null);
        };

        const handleDisconnect = (event: CustomEvent<{ clean: boolean }>) => {
          if (generationRef.current !== generation || isDisposedRef.current) {
            return;
          }
          disconnectCurrentRfb();
          if (hasEverConnectedRef.current) {
            setState("disconnected");
            setReason(null);
            scheduleReconnectRef.current();
            return;
          }
          const cleanSuffix = event.detail.clean ? " cleanly" : " unexpectedly";
          setState("error");
          setReason(`Desktop session disconnected${cleanSuffix} before it finished connecting.`);
        };

        const handleSecurityFailure = (event: CustomEvent<{ status: number; reason: string }>) => {
          if (generationRef.current !== generation || isDisposedRef.current) {
            return;
          }
          disconnectCurrentRfb();
          setState("error");
          const securityReason = event.detail.reason.trim();
          setReason(
            securityReason.length > 0
              ? `Desktop connection failed security checks: ${securityReason}`
              : "Desktop connection failed security checks."
          );
        };

        rfb.addEventListener("connect", handleConnect);
        rfb.addEventListener("disconnect", handleDisconnect);
        rfb.addEventListener("securityfailure", handleSecurityFailure);
        rfbRef.current = rfb;
        setState("connecting");
      } catch (error) {
        if (generationRef.current !== generation || isDisposedRef.current) {
          return;
        }
        disconnectCurrentRfb();
        if (hasEverConnectedRef.current) {
          // A prior successful session means this is part of the reconnect loop, so keep the
          // exponential backoff running instead of wedging the panel in a permanent error state.
          setState("disconnected");
          setReason(null);
          scheduleReconnectRef.current();
          return;
        }
        setState("error");
        setReason(getErrorMessage(error));
      }
    })();
  };

  useEffect(() => {
    const disconnect = disconnectHandleRef.current;
    return () => {
      disconnect();
    };
  }, []);

  return {
    state,
    reason,
    rfbRef,
    containerRef,
    connect: connectHandleRef.current,
    disconnect: disconnectHandleRef.current,
    width,
    height,
  };
}
