import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  useRef,
  useMemo,
} from "react";
import { createClient } from "@/common/orpc/client";
import { RPCLink as WebSocketLink } from "@orpc/client/websocket";
import { RPCLink as MessagePortLink } from "@orpc/client/message-port";
import {
  getStoredAuthToken,
  setStoredAuthToken,
  clearStoredAuthToken,
} from "@/browser/components/AuthTokenModal";

type APIClient = ReturnType<typeof createClient>;

export type { APIClient };

// Discriminated union for type-safe state handling
export type APIState =
  | { status: "connecting"; api: null; error: null }
  | { status: "connected"; api: APIClient; error: null }
  | { status: "degraded"; api: APIClient; error: null } // Connected but pings failing
  | { status: "reconnecting"; api: null; error: null; attempt: number }
  | { status: "auth_required"; api: null; error: string | null }
  | { status: "error"; api: null; error: string };

interface APIStateMethods {
  authenticate: (token: string) => void;
  retry: () => void;
}

// Union distributes over intersection, preserving discriminated union behavior
export type UseAPIResult = APIState & APIStateMethods;

// Internal state for the provider (includes cleanup)
type ConnectionState =
  | { status: "connecting" }
  | { status: "connected"; client: APIClient; cleanup: () => void }
  | { status: "degraded"; client: APIClient; cleanup: () => void } // Pings failing
  | { status: "reconnecting"; attempt: number }
  | { status: "auth_required"; error?: string }
  | { status: "error"; error: string };

// Reconnection constants
const MAX_RECONNECT_ATTEMPTS = 10;
const BASE_DELAY_MS = 100;
const MAX_DELAY_MS = 10000;

// Liveness check constants
const LIVENESS_INTERVAL_MS = 5000; // Check every 5 seconds
const LIVENESS_TIMEOUT_MS = 3000; // Ping must respond within 3 seconds
const CONSECUTIVE_FAILURES_FOR_DEGRADED = 2; // Mark degraded after N failures
const CONSECUTIVE_FAILURES_FOR_RECONNECT = 3; // Force reconnect after N failures (WS may be half-open)

const APIContext = createContext<UseAPIResult | null>(null);

interface APIProviderProps {
  children: React.ReactNode;
  /** Optional pre-created client. If provided, skips internal connection setup. */
  client?: APIClient;
  /** WebSocket factory for testing. Defaults to native WebSocket constructor. */
  createWebSocket?: (url: string) => WebSocket;
}

function getApiBase(): string {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment, @typescript-eslint/prefer-ts-expect-error
  // @ts-ignore - import.meta is available in Vite
  return import.meta.env.VITE_BACKEND_URL ?? window.location.origin;
}

function closeWebSocketSafely(ws: WebSocket) {
  try {
    // readyState: 0 = CONNECTING, 1 = OPEN, 2 = CLOSING, 3 = CLOSED
    if (ws.readyState === 2 || ws.readyState === 3) return;
    ws.close();
  } catch {
    // Some browsers throw if close() is called while already closing/closed.
    // Since our cleanup can be invoked from multiple code paths, treat close as idempotent.
  }
}

function createElectronClient(): { client: APIClient; cleanup: () => void } {
  const { port1: clientPort, port2: serverPort } = new MessageChannel();
  window.postMessage("start-orpc-client", "*", [serverPort]);

  const link = new MessagePortLink({ port: clientPort });
  clientPort.start();

  return {
    client: createClient(link),
    cleanup: () => clientPort.close(),
  };
}

function createBrowserClient(
  authToken: string | null,
  createWebSocket: (url: string) => WebSocket
): {
  client: APIClient;
  cleanup: () => void;
  ws: WebSocket;
} {
  const API_BASE = getApiBase();
  const WS_BASE = API_BASE.replace("http://", "ws://").replace("https://", "wss://");

  const wsUrl = authToken
    ? `${WS_BASE}/orpc/ws?token=${encodeURIComponent(authToken)}`
    : `${WS_BASE}/orpc/ws`;

  const ws = createWebSocket(wsUrl);
  const link = new WebSocketLink({ websocket: ws });

  return {
    client: createClient(link),
    cleanup: () => closeWebSocketSafely(ws),
    ws,
  };
}

export const APIProvider = (props: APIProviderProps) => {
  // If client is provided externally, start in connected state immediately
  const [state, setState] = useState<ConnectionState>(() => {
    if (props.client) {
      window.__ORPC_CLIENT__ = props.client;
      return { status: "connected", client: props.client, cleanup: () => undefined };
    }
    return { status: "connecting" };
  });
  const [authToken, setAuthToken] = useState<string | null>(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const urlToken = urlParams.get("token")?.trim();
    if (urlToken) {
      setStoredAuthToken(urlToken);
      return urlToken;
    }

    return getStoredAuthToken();
  });

  const cleanupRef = useRef<(() => void) | null>(null);
  const hasConnectedRef = useRef(false);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleReconnectRef = useRef<(() => void) | null>(null);
  const consecutivePingFailuresRef = useRef(0);
  const connectionIdRef = useRef(0);
  const forceReconnectInProgressRef = useRef(false);

  const wsFactory = useMemo(
    () => props.createWebSocket ?? ((url: string) => new WebSocket(url)),
    [props.createWebSocket]
  );

  const connect = useCallback(
    (token: string | null) => {
      const connectionId = ++connectionIdRef.current;

      // This connect() call supersedes any prior pending reconnect or active connection.
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }

      cleanupRef.current?.();
      cleanupRef.current = null;

      if (props.client) {
        window.__ORPC_CLIENT__ = props.client;
        cleanupRef.current = null;
        setState({ status: "connected", client: props.client, cleanup: () => undefined });
        return;
      }

      // Skip Electron detection if custom WebSocket factory provided (for testing)
      if (!props.createWebSocket && window.api) {
        const { client, cleanup } = createElectronClient();
        window.__ORPC_CLIENT__ = client;
        cleanupRef.current = cleanup;
        setState({ status: "connected", client, cleanup });
        return;
      }

      setState({ status: "connecting" });
      const { client, cleanup, ws } = createBrowserClient(token, wsFactory);

      ws.addEventListener("open", () => {
        // Ignore stale connections (can happen if we force reconnect while the old socket is mid-flight).
        if (connectionId !== connectionIdRef.current) {
          cleanup();
          return;
        }

        client.general
          .ping("auth-check")
          .then(() => {
            // Ignore stale connections (e.g., auth-check returned after a new connect()).
            if (connectionId !== connectionIdRef.current) {
              cleanup();
              return;
            }

            hasConnectedRef.current = true;
            reconnectAttemptRef.current = 0;
            consecutivePingFailuresRef.current = 0;
            forceReconnectInProgressRef.current = false;
            window.__ORPC_CLIENT__ = client;
            cleanupRef.current = cleanup;
            setState({ status: "connected", client, cleanup });
          })
          .catch((err: unknown) => {
            if (connectionId !== connectionIdRef.current) {
              cleanup();
              return;
            }

            cleanup();
            forceReconnectInProgressRef.current = false;
            const errMsg = err instanceof Error ? err.message : String(err);
            const errMsgLower = errMsg.toLowerCase();
            const isAuthError =
              errMsgLower.includes("unauthorized") ||
              errMsgLower.includes("401") ||
              errMsgLower.includes("auth token") ||
              errMsgLower.includes("authentication");
            if (isAuthError) {
              clearStoredAuthToken();
              setState({ status: "auth_required", error: token ? "Invalid token" : undefined });
            } else {
              setState({ status: "error", error: errMsg });
            }
          });
      });

      // Note: Browser fires 'error' before 'close', so we handle reconnection
      // only in 'close' to avoid double-scheduling. The 'error' event just
      // signals that something went wrong; 'close' provides the final state.
      ws.addEventListener("error", () => {
        // Error occurred - close event will follow and handle reconnection
        // We don't call cleanup() here since close handler will do it
      });

      ws.addEventListener("close", (event) => {
        cleanup();

        // Ignore stale connections (can happen if we force reconnect while the old socket is mid-flight).
        if (connectionId !== connectionIdRef.current) {
          return;
        }

        forceReconnectInProgressRef.current = false;

        // Auth-specific close codes
        if (event.code === 1008 || event.code === 4401) {
          clearStoredAuthToken();
          hasConnectedRef.current = false; // Reset - need fresh auth
          setState({ status: "auth_required", error: "Authentication required" });
          return;
        }

        // If we were previously connected, try to reconnect
        if (hasConnectedRef.current) {
          scheduleReconnectRef.current?.();
          return;
        }

        // First connection failed.
        // This can happen in dev-server mode if the UI boots before the backend is ready.
        // Prefer retry/backoff over forcing the auth modal (auth will be detected via ping/close codes).
        scheduleReconnectRef.current?.();
      });
    },
    [props.client, props.createWebSocket, wsFactory]
  );

  // Schedule reconnection with exponential backoff
  const scheduleReconnect = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
    }

    const attempt = reconnectAttemptRef.current;
    if (attempt >= MAX_RECONNECT_ATTEMPTS) {
      setState({ status: "error", error: "Connection lost. Please refresh the page." });
      return;
    }

    const delay = Math.min(BASE_DELAY_MS * Math.pow(2, attempt), MAX_DELAY_MS);
    reconnectAttemptRef.current = attempt + 1;
    setState({ status: "reconnecting", attempt: attempt + 1 });

    reconnectTimeoutRef.current = setTimeout(() => {
      connect(authToken);
    }, delay);
  }, [authToken, connect]);

  // Keep ref in sync with latest scheduleReconnect
  scheduleReconnectRef.current = scheduleReconnect;

  useEffect(() => {
    connect(authToken);
    return () => {
      cleanupRef.current?.();
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Liveness check: periodic ping to detect degraded connections
  // Only runs for browser WebSocket connections (not Electron or test clients)
  useEffect(() => {
    // Only check liveness for connected/degraded browser connections
    if (state.status !== "connected" && state.status !== "degraded") return;
    // Skip for Electron (MessagePort) and test clients (externally provided)
    if (props.client || (!props.createWebSocket && window.api)) return;

    const client = state.client;
    const cleanup = state.cleanup;

    const checkLiveness = async () => {
      try {
        // Race ping against timeout
        const pingPromise = client.general.ping("liveness");
        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Ping timeout")), LIVENESS_TIMEOUT_MS)
        );

        await Promise.race([pingPromise, timeoutPromise]);

        // Ping succeeded - reset failure count and restore connected state if degraded
        consecutivePingFailuresRef.current = 0;
        forceReconnectInProgressRef.current = false;
        if (state.status === "degraded") {
          setState({ status: "connected", client, cleanup });
        }
      } catch {
        // Ping failed
        consecutivePingFailuresRef.current++;

        if (
          consecutivePingFailuresRef.current >= CONSECUTIVE_FAILURES_FOR_RECONNECT &&
          !forceReconnectInProgressRef.current
        ) {
          forceReconnectInProgressRef.current = true;
          console.warn(
            `[APIProvider] Liveness ping failed ${consecutivePingFailuresRef.current} times; reconnecting...`
          );
          cleanup();
          connect(authToken);
          return;
        }

        if (
          consecutivePingFailuresRef.current >= CONSECUTIVE_FAILURES_FOR_DEGRADED &&
          state.status === "connected"
        ) {
          setState({ status: "degraded", client, cleanup });
        }
      }
    };

    const intervalId = setInterval(() => {
      void checkLiveness();
    }, LIVENESS_INTERVAL_MS);
    return () => clearInterval(intervalId);
  }, [state, props.client, props.createWebSocket, connect, authToken]);

  const authenticate = useCallback(
    (token: string) => {
      setStoredAuthToken(token);
      setAuthToken(token);
      connect(token);
    },
    [connect]
  );

  const retry = useCallback(() => {
    connect(authToken);
  }, [connect, authToken]);

  // Convert internal state to the discriminated union API
  const value = useMemo((): UseAPIResult => {
    const base = { authenticate, retry };
    switch (state.status) {
      case "connecting":
        return { status: "connecting", api: null, error: null, ...base };
      case "connected":
        return { status: "connected", api: state.client, error: null, ...base };
      case "degraded":
        return { status: "degraded", api: state.client, error: null, ...base };
      case "reconnecting":
        return { status: "reconnecting", api: null, error: null, attempt: state.attempt, ...base };
      case "auth_required":
        return { status: "auth_required", api: null, error: state.error ?? null, ...base };
      case "error":
        return { status: "error", api: null, error: state.error, ...base };
    }
  }, [state, authenticate, retry]);

  // Always render children - consumers handle their own loading/error states
  return <APIContext.Provider value={value}>{props.children}</APIContext.Provider>;
};

export const useAPI = (): UseAPIResult => {
  const context = useContext(APIContext);
  if (!context) {
    throw new Error("useAPI must be used within an APIProvider");
  }
  return context;
};
