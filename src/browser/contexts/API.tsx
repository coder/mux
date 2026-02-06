import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createClient } from "@/common/orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { RPCLink as MessagePortLink } from "@orpc/client/message-port";
import {
  getStoredAuthToken,
  setStoredAuthToken,
  clearStoredAuthToken,
} from "@/browser/components/AuthTokenModal";
import { getBrowserBackendBaseUrl } from "@/browser/utils/backendBaseUrl";

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

// Liveness check constants
const LIVENESS_INTERVAL_MS = 5000; // Check every 5 seconds
const LIVENESS_TIMEOUT_MS = 3000; // Ping must respond within 3 seconds
const CONSECUTIVE_FAILURES_FOR_RECONNECT = 3; // Force reconnect after N consecutive failures

const APIContext = createContext<UseAPIResult | null>(null);

interface APIProviderProps {
  children: React.ReactNode;
  /** Optional pre-created client. If provided, skips internal connection setup. */
  client?: APIClient;
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
} {
  const apiBaseUrl = getBrowserBackendBaseUrl();

  const link = new RPCLink({
    url: `${apiBaseUrl}/orpc`,
    headers: authToken ? { Authorization: `Bearer ${authToken}` } : {},
  });

  return {
    client: createClient(link),
    // HTTP/fetch transport has no persistent connection to close.
    cleanup: () => {},
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

      if (window.api) {
        const { client, cleanup } = createElectronClient();
        window.__ORPC_CLIENT__ = client;
        cleanupRef.current = cleanup;
        setState({ status: "connected", client, cleanup });
        return;
      }

      // HTTP/fetch transport — verify reachability via auth-check ping.
      setState({ status: "connecting" });
      const { client, cleanup } = createBrowserClient(token);

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
            // Network error or backend not ready — retry with backoff.
            scheduleReconnectRef.current?.();
          }
        });
    },
    [props.client]
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

  // Liveness check: periodic ping to detect backend unavailability.
  // Only runs for browser HTTP connections (not Electron or test clients).
  useEffect(() => {
    if (state.status !== "connected") return;
    // Skip for Electron (MessagePort) and test clients (externally provided)
    if (props.client || window.api) return;

    const client = state.client;

    const checkLiveness = async () => {
      try {
        const pingPromise = client.general.ping("liveness");
        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Ping timeout")), LIVENESS_TIMEOUT_MS)
        );

        await Promise.race([pingPromise, timeoutPromise]);
        consecutivePingFailuresRef.current = 0;
      } catch {
        consecutivePingFailuresRef.current++;

        if (consecutivePingFailuresRef.current >= CONSECUTIVE_FAILURES_FOR_RECONNECT) {
          console.warn(
            `[APIProvider] Liveness ping failed ${consecutivePingFailuresRef.current} times; reconnecting...`
          );
          connect(authToken);
          return;
        }
      }
    };

    const intervalId = setInterval(() => {
      void checkLiveness();
    }, LIVENESS_INTERVAL_MS);
    return () => clearInterval(intervalId);
  }, [state, props.client, connect, authToken]);

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
