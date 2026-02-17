import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import { createORPCClient, type ClientContext } from "@orpc/client";
import { RPCLink as WebSocketRPCLink } from "@orpc/client/websocket";
import WebSocket from "ws";
import { getMuxHome } from "../../common/constants/paths";
import { Config } from "../config";
import { type AppRouter } from "../orpc/router";
import { createOrpcServer } from "../orpc/server";
import { ServiceContainer } from "../services/serviceContainer";
import { ServerLockfile } from "../services/serverLockfile";

interface ConnectViaWebSocketResult {
  client: ORPCClient;
  websocket: WebSocket;
  baseUrl: string;
}

type InProcessOrpcServer = Awaited<ReturnType<typeof createOrpcServer>>;

function createTypedClient(link: WebSocketRPCLink<ClientContext>) {
  return createORPCClient<AppRouter>(link);
}

export type ORPCClient = ReturnType<typeof createTypedClient>;

export interface ServerConnection {
  client: ORPCClient;
  inProcessServer?: InProcessOrpcServer;
  baseUrl: string;
  close(): Promise<void>;
}

export async function connectToServer(options: {
  serverUrl?: string;
  authToken?: string;
}): Promise<ServerConnection> {
  assert(options, "[connectToServer] options are required");

  const explicitServerUrl = normalizeServerUrl(options.serverUrl);
  const explicitAuthToken = normalizeToken(options.authToken);

  if (explicitServerUrl) {
    return connectToExistingServer({
      baseUrl: explicitServerUrl,
      authToken: explicitAuthToken,
    });
  }

  const lockfile = new ServerLockfile(getMuxHome());
  const lockData = await lockfile.read();

  if (lockData?.baseUrl) {
    return connectToExistingServer({
      baseUrl: lockData.baseUrl,
      authToken: explicitAuthToken ?? normalizeToken(lockData.token),
    });
  }

  return connectToInProcessServer(explicitAuthToken);
}

async function connectToExistingServer(options: {
  baseUrl: string;
  authToken?: string;
}): Promise<ServerConnection> {
  const connection = await connectViaWebSocket(options.baseUrl, options.authToken);

  return {
    client: connection.client,
    baseUrl: connection.baseUrl,
    close: async () => {
      await closeWebSocket(connection.websocket);
    },
  };
}

async function connectToInProcessServer(requestedAuthToken?: string): Promise<ServerConnection> {
  const authToken = requestedAuthToken ?? crypto.randomUUID();
  const config = new Config();
  const serviceContainer = new ServiceContainer(config);

  let initialized = false;
  let inProcessServer: InProcessOrpcServer | undefined;

  try {
    await serviceContainer.initialize();
    initialized = true;

    const context = serviceContainer.toORPCContext();
    inProcessServer = await createOrpcServer({
      host: "127.0.0.1",
      port: 0,
      authToken,
      context,
    });

    const connection = await connectViaWebSocket(inProcessServer.baseUrl, authToken);

    return {
      client: connection.client,
      inProcessServer,
      baseUrl: connection.baseUrl,
      close: async () => {
        let firstError: unknown;

        const captureError = (error: unknown) => {
          if (firstError === undefined) {
            firstError = error;
          }
        };

        await closeWebSocket(connection.websocket).catch(captureError);
        await inProcessServer.close().catch(captureError);
        await serviceContainer.dispose().catch(captureError);

        if (firstError !== undefined) {
          throw firstError;
        }
      },
    };
  } catch (error) {
    if (inProcessServer) {
      await inProcessServer.close().catch(() => undefined);
    }

    if (initialized) {
      await serviceContainer.dispose().catch(() => undefined);
    }

    throw error;
  }
}

async function connectViaWebSocket(
  baseUrl: string,
  authToken?: string
): Promise<ConnectViaWebSocketResult> {
  const normalizedBaseUrl = normalizeServerUrl(baseUrl);
  assert(normalizedBaseUrl, "[connectViaWebSocket] baseUrl must be a valid URL");

  const wsUrl = buildWsUrl(normalizedBaseUrl);
  const headers = buildAuthHeaders(authToken);
  const websocket = new WebSocket(wsUrl, headers ? { headers } : undefined);

  await waitForWebSocketOpen(websocket, wsUrl);

  // oRPC expects a browser-like WebSocket surface; ws is compatible at runtime.
  const link = new WebSocketRPCLink({
    websocket: websocket as unknown as globalThis.WebSocket,
  });
  const client = createTypedClient(link);

  return {
    client,
    websocket,
    baseUrl: normalizedBaseUrl,
  };
}

function normalizeServerUrl(serverUrl: string | undefined): string | undefined {
  const trimmed = serverUrl?.trim();
  if (!trimmed) {
    return undefined;
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch (error) {
    throw new Error(`[serverConnection] Invalid server URL "${trimmed}"`, {
      cause: error,
    });
  }

  assert(
    parsed.protocol === "http:" || parsed.protocol === "https:",
    `[serverConnection] server URL must use http(s), got ${parsed.protocol}`
  );

  return parsed.toString().replace(/\/$/, "");
}

function normalizeToken(token: string | undefined): string | undefined {
  const trimmed = token?.trim();
  return trimmed ? trimmed : undefined;
}

function buildWsUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";

  const basePath = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "");
  url.pathname = `${basePath}/orpc/ws`;
  url.search = "";
  url.hash = "";

  return url.toString();
}

function buildAuthHeaders(authToken: string | undefined): Record<string, string> | undefined {
  const normalizedToken = normalizeToken(authToken);
  if (!normalizedToken) {
    return undefined;
  }

  return {
    Authorization: `Bearer ${normalizedToken}`,
  };
}

async function waitForWebSocketOpen(websocket: WebSocket, wsUrl: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      websocket.off("open", onOpen);
      websocket.off("error", onError);
      websocket.off("close", onClose);
    };

    const onOpen = () => {
      cleanup();
      resolve();
    };

    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    const onClose = (code: number, reasonBuffer: Buffer) => {
      cleanup();

      const reason = reasonBuffer.toString("utf8").trim();
      const suffix = reason ? ` (${reason})` : "";
      reject(
        new Error(`[serverConnection] WebSocket closed before opening (${code})${suffix}: ${wsUrl}`)
      );
    };

    websocket.once("open", onOpen);
    websocket.once("error", onError);
    websocket.once("close", onClose);
  });
}

async function closeWebSocket(websocket: WebSocket): Promise<void> {
  if (websocket.readyState === WebSocket.CLOSED) {
    return;
  }

  await new Promise<void>((resolve) => {
    let finished = false;

    const finish = () => {
      if (finished) {
        return;
      }

      finished = true;
      clearTimeout(timeout);
      websocket.off("close", finish);
      websocket.off("error", finish);
      resolve();
    };

    const timeout = setTimeout(() => {
      try {
        websocket.terminate();
      } catch {
        // Best effort - socket may already be closing.
      }

      finish();
    }, 1000);

    websocket.once("close", finish);
    websocket.once("error", finish);

    try {
      websocket.close();
    } catch {
      finish();
    }
  });
}
