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
import { getStoredAuthToken, clearStoredAuthToken } from "@/browser/components/AuthTokenModal";

type APIClient = ReturnType<typeof createClient>;

export type { APIClient };

// Discriminated union for type-safe state handling
export type APIState =
  | { status: "connecting"; api: null; error: null }
  | { status: "connected"; api: APIClient; error: null }
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
  | { status: "reconnecting"; attempt: number }
  | { status: "auth_required"; error?: string }
  | { status: "error"; error: string };

// Reconnection constants
const MAX_RECONNECT_ATTEMPTS = 10;
const BASE_DELAY_MS = 100;
const MAX_DELAY_MS = 10000;

const APIContext = createContext<UseAPIResult | null>(null);

interface APIProviderProps {
  children: React.ReactNode;
  /** Optional pre-created client. If provided, skips internal connection setup. */
  client?: APIClient;
}

function getApiBase(): string {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment, @typescript-eslint/prefer-ts-expect-error
  // @ts-ignore - import.meta is available in Vite
  return import.meta.env.VITE_BACKEND_URL ?? window.location.origin;
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

function createBrowserClient(authToken: string | null): {
  client: APIClient;
  cleanup: () => void;
  ws: WebSocket;
} {
  const API_BASE = getApiBase();
  const WS_BASE = API_BASE.replace("http://", "ws://").replace("https://", "wss://");

  const wsUrl = authToken
    ? `${WS_BASE}/orpc/ws?token=${encodeURIComponent(authToken)}`
    : `${WS_BASE}/orpc/ws`;

  const ws = new WebSocket(wsUrl);
  const link = new WebSocketLink({ websocket: ws });

  return {
    client: createClient(link),
    cleanup: () => ws.close(),
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
    return urlParams.get("token") ?? getStoredAuthToken();
  });

  const cleanupRef = useRef<(() => void) | null>(null);
  const hasConnectedRef = useRef(false);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleReconnectRef = useRef<(() => void) | null>(null);

  const connect = useCallback(
    (token: string | null) => {
      if (props.client) {
        window.__ORPC_CLIENT__ = props.client;
        cleanupRef.current = null;
        setState({ status: "connected", client: props.client, cleanup: () => undefined });
        return;
      }

      if (window.api) {
        const { client, cleanup } = createElectronClient();
        window.__ORPC_CLIENT__ = client;
        cleanupRef.current = cleanup;
        setState({ status: "connected", client, cleanup });
        return;
      }

      setState({ status: "connecting" });
      const { client, cleanup, ws } = createBrowserClient(token);

      ws.addEventListener("open", () => {
        client.general
          .ping("auth-check")
          .then(() => {
            hasConnectedRef.current = true;
            reconnectAttemptRef.current = 0;
            window.__ORPC_CLIENT__ = client;
            cleanupRef.current = cleanup;
            setState({ status: "connected", client, cleanup });
          })
          .catch((err: unknown) => {
            cleanup();
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

      ws.addEventListener("error", () => {
        cleanup();
        if (hasConnectedRef.current) {
          // Was connected before - try to reconnect
          scheduleReconnectRef.current?.();
        } else if (token) {
          // First connection failed with token - might be invalid
          clearStoredAuthToken();
          setState({ status: "auth_required", error: "Connection failed - invalid token?" });
        } else {
          // First connection failed without token - server might require auth
          setState({ status: "auth_required" });
        }
      });

      ws.addEventListener("close", (event) => {
        // Auth-specific close codes
        if (event.code === 1008 || event.code === 4401) {
          cleanup();
          clearStoredAuthToken();
          hasConnectedRef.current = false; // Reset - need fresh auth
          setState({ status: "auth_required", error: "Authentication required" });
          return;
        }

        // Normal disconnection (server restart, network issue)
        if (hasConnectedRef.current) {
          cleanup();
          scheduleReconnectRef.current?.();
        }
      });
    },
    [props.client]
  );

  // Schedule reconnection with exponential backoff
  const scheduleReconnect = useCallback(() => {
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

  const authenticate = useCallback(
    (token: string) => {
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
