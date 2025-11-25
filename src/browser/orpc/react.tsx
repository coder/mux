import { createContext, useContext, useEffect, useState } from "react";
import { createClient } from "@/common/orpc/client";
import { RPCLink as WebSocketLink } from "@orpc/client/websocket";
import { RPCLink as MessagePortLink } from "@orpc/client/message-port";
import type { AppRouter } from "@/node/orpc/router";
import type { RouterClient } from "@orpc/server";

type ORPCClient = ReturnType<typeof createClient>;

export type { ORPCClient };

const ORPCContext = createContext<ORPCClient | null>(null);

interface ORPCProviderProps {
  children: React.ReactNode;
  /** Optional pre-created client. If provided, skips internal connection setup. */
  client?: ORPCClient;
}

export const ORPCProvider = (props: ORPCProviderProps) => {
  const [client, setClient] = useState<ORPCClient | null>(props.client ?? null);

  useEffect(() => {
    // If client provided externally, use it directly
    if (props.client) {
      setClient(() => props.client!);
      window.__ORPC_CLIENT__ = props.client;
      return;
    }

    let cleanup: () => void;
    let newClient: ORPCClient;

    // Detect Electron mode by checking if window.api exists (exposed by preload script)
    // window.api.platform contains the actual OS platform (darwin/win32/linux), not "electron"
    if (window.api) {
      // Electron Mode: Use MessageChannel
      const { port1: clientPort, port2: serverPort } = new MessageChannel();

      // Send port to preload/main
      window.postMessage("start-orpc-client", "*", [serverPort]);

      const link = new MessagePortLink({
        port: clientPort,
      });
      clientPort.start();

      newClient = createClient(link);
      cleanup = () => {
        clientPort.close();
      };
    } else {
      // Browser Mode: Use HTTP/WebSocket
      // Assume server is at same origin or configured via VITE_BACKEND_URL
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment, @typescript-eslint/prefer-ts-expect-error
      // @ts-ignore - import.meta is available in Vite
      const API_BASE = import.meta.env.VITE_BACKEND_URL ?? window.location.origin;
      const WS_BASE = API_BASE.replace("http://", "ws://").replace("https://", "wss://");

      const ws = new WebSocket(`${WS_BASE}/orpc/ws`);
      const link = new WebSocketLink({
        websocket: ws,
      });

      newClient = createClient(link);
      cleanup = () => {
        ws.close();
      };
    }

    // Pass a function to setClient to prevent React from treating the client (which is a callable Proxy)
    // as a functional state update. Without this, React calls client(prevState), triggering a request to root /.
    setClient(() => newClient);

    window.__ORPC_CLIENT__ = newClient;

    return () => {
      cleanup();
    };
  }, [props.client]);

  if (!client) {
    return null; // Or a loading spinner
  }

  return <ORPCContext.Provider value={client}>{props.children}</ORPCContext.Provider>;
};

export const useORPC = (): RouterClient<AppRouter> => {
  const context = useContext(ORPCContext);
  if (!context) {
    throw new Error("useORPC must be used within an ORPCProvider");
  }
  return context;
};
