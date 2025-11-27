import { createContext, useContext, useEffect, useState, useCallback } from "react";
import { createClient } from "@/common/orpc/client";
import { RPCLink as WebSocketLink } from "@orpc/client/websocket";
import { RPCLink as MessagePortLink } from "@orpc/client/message-port";
import type { AppRouter } from "@/node/orpc/router";
import type { RouterClient } from "@orpc/server";
import {
  AuthTokenModal,
  getStoredAuthToken,
  clearStoredAuthToken,
} from "@/browser/components/AuthTokenModal";

type ORPCClient = ReturnType<typeof createClient>;

export type { ORPCClient };

const ORPCContext = createContext<ORPCClient | null>(null);

interface ORPCProviderProps {
  children: React.ReactNode;
  /** Optional pre-created client. If provided, skips internal connection setup. */
  client?: ORPCClient;
}

type ConnectionState =
  | { status: "connecting" }
  | { status: "connected"; client: ORPCClient; cleanup: () => void }
  | { status: "auth_required"; error?: string }
  | { status: "error"; error: string };

function getApiBase(): string {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment, @typescript-eslint/prefer-ts-expect-error
  // @ts-ignore - import.meta is available in Vite
  return import.meta.env.VITE_BACKEND_URL ?? window.location.origin;
}

function createElectronClient(): { client: ORPCClient; cleanup: () => void } {
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
  client: ORPCClient;
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

export const ORPCProvider = (props: ORPCProviderProps) => {
  // If client is provided externally, start in connected state immediately
  // This avoids a flash of null content on first render
  const [state, setState] = useState<ConnectionState>(() => {
    if (props.client) {
      // Also set the global client reference immediately
      window.__ORPC_CLIENT__ = props.client;
      return { status: "connected", client: props.client, cleanup: () => undefined };
    }
    return { status: "connecting" };
  });
  const [authToken, setAuthToken] = useState<string | null>(() => {
    // Check URL param first, then localStorage
    const urlParams = new URLSearchParams(window.location.search);
    return urlParams.get("token") ?? getStoredAuthToken();
  });

  const connect = useCallback(
    (token: string | null) => {
      // If client provided externally, use it directly
      if (props.client) {
        window.__ORPC_CLIENT__ = props.client;
        setState({ status: "connected", client: props.client, cleanup: () => undefined });
        return;
      }

      // Electron mode - no auth needed
      if (window.api) {
        const { client, cleanup } = createElectronClient();
        window.__ORPC_CLIENT__ = client;
        setState({ status: "connected", client, cleanup });
        return;
      }

      // Browser mode - connect with optional auth token
      setState({ status: "connecting" });
      const { client, cleanup, ws } = createBrowserClient(token);

      ws.addEventListener("open", () => {
        // Connection successful - test with a ping to verify auth
        client.general
          .ping("auth-check")
          .then(() => {
            window.__ORPC_CLIENT__ = client;
            setState({ status: "connected", client, cleanup });
          })
          .catch((err: unknown) => {
            cleanup();
            const errMsg = err instanceof Error ? err.message : String(err);
            const errMsgLower = errMsg.toLowerCase();
            // Check for auth-related errors (case-insensitive)
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
        // WebSocket connection failed - might be auth issue or network
        cleanup();
        // If we had a token and failed, likely auth issue
        if (token) {
          clearStoredAuthToken();
          setState({ status: "auth_required", error: "Connection failed - invalid token?" });
        } else {
          // Try without token first, server might not require auth
          // If server requires auth, the ping will fail with UNAUTHORIZED
          setState({ status: "auth_required" });
        }
      });

      ws.addEventListener("close", (event) => {
        // 1008 = Policy Violation (often used for auth failures)
        // 4401 = Custom unauthorized code
        if (event.code === 1008 || event.code === 4401) {
          cleanup();
          clearStoredAuthToken();
          setState({ status: "auth_required", error: "Authentication required" });
        }
      });
    },
    [props.client]
  );

  // Initial connection attempt
  useEffect(() => {
    connect(authToken);

    return () => {
      if (state.status === "connected") {
        state.cleanup();
      }
    };
    // Only run on mount and when authToken changes via handleAuthSubmit
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleAuthSubmit = useCallback(
    (token: string) => {
      setAuthToken(token);
      connect(token);
    },
    [connect]
  );

  // Show auth modal if auth is required
  if (state.status === "auth_required") {
    return <AuthTokenModal isOpen={true} onSubmit={handleAuthSubmit} error={state.error ?? null} />;
  }

  // Show error state
  if (state.status === "error") {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          height: "100vh",
          color: "var(--color-error, #ff6b6b)",
          flexDirection: "column",
          gap: 16,
        }}
      >
        <div>Failed to connect to server</div>
        <div style={{ fontSize: 13, color: "var(--color-text-secondary)" }}>{state.error}</div>
        <button
          onClick={() => connect(authToken)}
          style={{
            padding: "8px 16px",
            borderRadius: 4,
            border: "1px solid var(--color-border)",
            background: "var(--color-button-background)",
            color: "var(--color-text)",
            cursor: "pointer",
          }}
        >
          Retry
        </button>
      </div>
    );
  }

  // Show loading while connecting
  if (state.status === "connecting") {
    return null; // Or a loading spinner
  }

  return <ORPCContext.Provider value={state.client}>{props.children}</ORPCContext.Provider>;
};

export const useORPC = (): RouterClient<AppRouter> => {
  const context = useContext(ORPCContext);
  if (!context) {
    throw new Error("useORPC must be used within an ORPCProvider");
  }
  return context;
};
