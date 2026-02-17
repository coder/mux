import { createClient } from "@/common/orpc/client";
import assert from "@/common/utils/assert";
import { RPCLink as WebSocketLink } from "@orpc/client/websocket";
import { WebSocket } from "ws";

export interface OrpcClientOptions {
  baseUrl: string;
  authToken?: string;
}

export interface OrpcWsClient {
  client: ReturnType<typeof createClient>;
  ws: WebSocket;
  close: () => void;
}

export function createOrpcWsClient(options: OrpcClientOptions): OrpcWsClient {
  assert(options.baseUrl.trim().length > 0, "createOrpcWsClient requires a non-empty baseUrl");

  const normalizedBase = options.baseUrl.replace(/\/+$/, "");

  let wsUrl: URL;
  try {
    wsUrl = new URL(`${normalizedBase}/orpc/ws`);
  } catch (error) {
    throw new Error(`Invalid oRPC base URL: ${options.baseUrl}`, { cause: error });
  }

  wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";

  const authToken = options.authToken?.trim();
  if (authToken) {
    wsUrl.searchParams.set("token", authToken);
  }

  const ws = new WebSocket(wsUrl.toString());
  const link = new WebSocketLink({ websocket: ws as unknown as globalThis.WebSocket });
  const client = createClient(link);

  return {
    client,
    ws,
    close: () => {
      if (ws.readyState === WebSocket.CLOSING || ws.readyState === WebSocket.CLOSED) {
        return;
      }
      ws.close();
    },
  };
}
