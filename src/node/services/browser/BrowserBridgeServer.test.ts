import * as http from "node:http";
import type { IncomingMessage } from "node:http";
import { describe, expect, mock, test } from "bun:test";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { BrowserBridgeServer } from "./BrowserBridgeServer";

const VALID_TOKEN = "valid-token";
const VALID_WORKSPACE_ID = "workspace-1";
const VALID_SESSION_NAME = "session-a";
const VALID_STREAM_PORT = 9222;

interface UpgradeHarness {
  port: number;
  close: () => Promise<void>;
}

interface UpstreamHarness {
  port: number;
  connectionPromise: Promise<WebSocket>;
  close: () => Promise<void>;
}

function normalizeMessage(data: RawData): string {
  if (typeof data === "string") {
    return data;
  }

  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }

  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }

  return Buffer.from(data).toString("utf8");
}

function createAttachableConnection(sessionName: string, streamPort: number) {
  return {
    sessionName,
    pid: 101,
    cwd: "/tmp/project",
    status: "attachable" as const,
    streamPort,
  };
}

function createBridgeServer(
  options: {
    validate?: (
      token: string
    ) => { workspaceId: string; sessionName: string; streamPort: number } | null;
    getSessionConnection?: (
      workspaceId: string,
      sessionName: string
    ) => Promise<{
      sessionName: string;
      pid: number;
      cwd: string;
      status: "attachable";
      streamPort: number;
    } | null>;
  } = {}
): BrowserBridgeServer {
  return new BrowserBridgeServer({
    browserBridgeTokenManager: {
      validate:
        options.validate ??
        mock((token: string) =>
          token === VALID_TOKEN
            ? {
                workspaceId: VALID_WORKSPACE_ID,
                sessionName: VALID_SESSION_NAME,
                streamPort: VALID_STREAM_PORT,
              }
            : null
        ),
    },
    browserSessionDiscoveryService: {
      getSessionConnection:
        options.getSessionConnection ??
        mock((workspaceId: string, sessionName: string) =>
          Promise.resolve(
            workspaceId === VALID_WORKSPACE_ID && sessionName === VALID_SESSION_NAME
              ? createAttachableConnection(sessionName, VALID_STREAM_PORT)
              : null
          )
        ),
    },
  });
}

type MockClientSocket = Pick<WebSocket, "readyState" | "close" | "terminate"> & {
  close: ReturnType<typeof mock>;
  terminate: ReturnType<typeof mock>;
};

interface BrowserBridgeServerPrivate {
  handleUpgradedConnection(ws: WebSocket, request: IncomingMessage): Promise<void>;
}

function createMockClientSocket(): MockClientSocket {
  return {
    readyState: WebSocket.OPEN,
    close: mock(),
    terminate: mock(),
  };
}

async function listenUpstreamServer(): Promise<UpstreamHarness> {
  let resolveConnection: ((socket: WebSocket) => void) | null = null;
  const connectionPromise = new Promise<WebSocket>((resolve) => {
    resolveConnection = resolve;
  });
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  server.on("connection", (socket) => {
    resolveConnection?.(socket);
  });

  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected upstream server to expose a numeric port");
  }

  return {
    port: address.port,
    connectionPromise,
    close: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

async function listenUpgradeServer(bridgeServer: BrowserBridgeServer): Promise<UpgradeHarness> {
  const server = http.createServer();
  server.on("upgrade", (request, socket, head) => {
    bridgeServer.handleUpgrade(request, socket, head);
  });
  server.on("clientError", (_error, socket) => {
    socket.destroy();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected upgrade server to expose a numeric port");
  }

  return {
    port: address.port,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function waitForWebSocketOpen(ws: WebSocket): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      reject(new Error("WebSocket closed before opening"));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      ws.off("open", onOpen);
      ws.off("close", onClose);
      ws.off("error", onError);
    };
    ws.once("open", onOpen);
    ws.once("close", onClose);
    ws.once("error", onError);
  });
}

async function waitForMessage(ws: WebSocket): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const onMessage = (data: RawData) => {
      cleanup();
      resolve(normalizeMessage(data));
    };
    const onClose = () => {
      cleanup();
      reject(new Error("WebSocket closed before receiving a message"));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      ws.off("message", onMessage);
      ws.off("close", onClose);
      ws.off("error", onError);
    };
    ws.once("message", onMessage);
    ws.once("close", onClose);
    ws.once("error", onError);
  });
}

describe("BrowserBridgeServer", () => {
  test("bridges raw WebSocket messages in both directions for a valid token", async () => {
    const upstreamHarness = await listenUpstreamServer();
    const bridgeServer = createBridgeServer({
      getSessionConnection: mock((workspaceId: string, sessionName: string) =>
        Promise.resolve(
          workspaceId === VALID_WORKSPACE_ID && sessionName === VALID_SESSION_NAME
            ? createAttachableConnection(sessionName, upstreamHarness.port)
            : null
        )
      ),
      validate: mock((token: string) =>
        token === VALID_TOKEN
          ? {
              workspaceId: VALID_WORKSPACE_ID,
              sessionName: VALID_SESSION_NAME,
              streamPort: upstreamHarness.port,
            }
          : null
      ),
    });
    const upgradeHarness = await listenUpgradeServer(bridgeServer);

    const ws = new WebSocket(`ws://127.0.0.1:${upgradeHarness.port}/?token=${VALID_TOKEN}`);
    try {
      await waitForWebSocketOpen(ws);
      const upstreamSocket = await upstreamHarness.connectionPromise;

      ws.send('{"type":"input_keyboard","eventType":"keyDown","key":"a"}');
      expect(await waitForMessage(upstreamSocket)).toBe(
        '{"type":"input_keyboard","eventType":"keyDown","key":"a"}'
      );

      upstreamSocket.send('{"type":"frame","data":"abc"}');
      expect(await waitForMessage(ws)).toBe('{"type":"frame","data":"abc"}');
    } finally {
      ws.terminate();
      await upgradeHarness.close();
      await bridgeServer.stop();
      await upstreamHarness.close();
    }
  });

  test("closes with 4001 for invalid or missing tokens", async () => {
    const bridgeServer = createBridgeServer({
      validate: mock(() => null),
      getSessionConnection: mock(() => Promise.resolve(null)),
    });

    try {
      for (const url of ["/", "/?token=bad-token"]) {
        const ws = createMockClientSocket();
        const bridgeServerPrivate = bridgeServer as unknown as BrowserBridgeServerPrivate;
        await bridgeServerPrivate.handleUpgradedConnection(
          ws as unknown as WebSocket,
          { url } as IncomingMessage
        );
        expect(ws.close).toHaveBeenCalledWith(4001, "invalid token");
      }
    } finally {
      await bridgeServer.stop();
    }
  });

  test("closes with 4002 when the live session is missing or mismatched", async () => {
    for (const liveSession of [null, createAttachableConnection(VALID_SESSION_NAME, 9999)]) {
      const bridgeServer = createBridgeServer({
        validate: mock(() => ({
          workspaceId: VALID_WORKSPACE_ID,
          sessionName: VALID_SESSION_NAME,
          streamPort: VALID_STREAM_PORT,
        })),
        getSessionConnection: mock(() => Promise.resolve(liveSession)),
      });

      try {
        const ws = createMockClientSocket();
        const bridgeServerPrivate = bridgeServer as unknown as BrowserBridgeServerPrivate;
        await bridgeServerPrivate.handleUpgradedConnection(
          ws as unknown as WebSocket,
          { url: `/?token=${VALID_TOKEN}` } as IncomingMessage
        );
        expect(ws.close).toHaveBeenCalledWith(4002, "session unavailable");
      } finally {
        await bridgeServer.stop();
      }
    }
  });

  test("closes the client socket when bridge setup rejects", async () => {
    const bridgeServer = createBridgeServer({
      getSessionConnection: mock(() => Promise.reject(new Error("boom"))),
    });
    const ws = createMockClientSocket();
    const internalBridgeServer = bridgeServer as unknown as {
      wss: {
        handleUpgrade: (
          request: IncomingMessage,
          socket: unknown,
          head: Buffer,
          callback: (ws: WebSocket) => void
        ) => void;
      };
    };
    internalBridgeServer.wss.handleUpgrade = (_request, _socket, _head, callback) => {
      callback(ws as unknown as WebSocket);
    };

    try {
      bridgeServer.handleUpgrade(
        { url: `/?token=${VALID_TOKEN}` } as IncomingMessage,
        {} as never,
        Buffer.alloc(0)
      );
      await Promise.resolve();
      await Promise.resolve();
      expect(ws.close).toHaveBeenCalledWith(4002, "session unavailable");
    } finally {
      await bridgeServer.stop();
    }
  });

  test("closes with 4003 when the upstream stream cannot be reached", async () => {
    const bridgeServer = createBridgeServer();

    try {
      const ws = createMockClientSocket();
      const bridgeServerPrivate = bridgeServer as unknown as BrowserBridgeServerPrivate;
      await bridgeServerPrivate.handleUpgradedConnection(
        ws as unknown as WebSocket,
        { url: `/?token=${VALID_TOKEN}` } as IncomingMessage
      );
      expect(ws.close).toHaveBeenCalledWith(4003, "stream connect failed");
    } finally {
      await bridgeServer.stop();
    }
  });
});
