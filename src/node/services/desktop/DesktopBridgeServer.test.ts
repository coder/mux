import * as net from "node:net";
import { describe, expect, mock, test } from "bun:test";
import { WebSocket, type RawData } from "ws";
import { DesktopBridgeServer } from "./DesktopBridgeServer";

interface TcpHarness {
  server: net.Server;
  port: number;
  connectionPromise: Promise<net.Socket>;
  close: () => Promise<void>;
}

async function listenTcpServer(): Promise<TcpHarness> {
  const sockets = new Set<net.Socket>();
  let resolveConnection: ((socket: net.Socket) => void) | null = null;
  const connectionPromise = new Promise<net.Socket>((resolve) => {
    resolveConnection = resolve;
  });

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => {
      sockets.delete(socket);
    });
    resolveConnection?.(socket);
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("error", onError);
      reject(error);
    };

    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected TCP test server to expose a numeric port");
  }

  return {
    server,
    port: address.port,
    connectionPromise,
    close: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await closeTcpServer(server);
    },
  };
}

async function closeTcpServer(server: net.Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

async function waitForWebSocketOpen(ws: WebSocket): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onOpen = () => {
      cleanup();
      resolve();
    };

    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    const onClose = () => {
      cleanup();
      reject(new Error("WebSocket closed before opening"));
    };

    const cleanup = () => {
      ws.off("open", onOpen);
      ws.off("error", onError);
      ws.off("close", onClose);
    };

    ws.once("open", onOpen);
    ws.once("error", onError);
    ws.once("close", onClose);
  });
}

async function waitForWebSocketClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return await new Promise<{ code: number; reason: string }>((resolve, reject) => {
    const onClose = (code: number, reason: Buffer) => {
      cleanup();
      resolve({ code, reason: reason.toString() });
    };

    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    const cleanup = () => {
      ws.off("close", onClose);
      ws.off("error", onError);
    };

    ws.once("close", onClose);
    ws.once("error", onError);
  });
}

async function closeWebSocket(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) {
    return;
  }

  await new Promise<void>((resolve) => {
    ws.once("close", () => resolve());
    ws.close();
  });
}

function normalizeBinaryMessage(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) {
    return data;
  }

  if (Array.isArray(data)) {
    return Buffer.concat(data);
  }

  return Buffer.from(data);
}

async function waitForWebSocketMessage(ws: WebSocket): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    const onMessage = (data: RawData, isBinary: boolean) => {
      cleanup();
      if (!isBinary) {
        reject(new Error("Expected a binary WebSocket message"));
        return;
      }
      resolve(normalizeBinaryMessage(data));
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

async function waitForTcpData(socket: net.Socket, timeoutMs = 2_000): Promise<Buffer | null> {
  return await new Promise<Buffer | null>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      resolve(null);
    }, timeoutMs);

    const onData = (chunk: Buffer) => {
      cleanup();
      resolve(chunk);
    };

    const onClose = () => {
      cleanup();
      reject(new Error("TCP socket closed before receiving data"));
    };

    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    const cleanup = () => {
      clearTimeout(timeout);
      socket.off("data", onData);
      socket.off("close", onClose);
      socket.off("error", onError);
    };

    socket.once("data", onData);
    socket.once("close", onClose);
    socket.once("error", onError);
  });
}

describe("DesktopBridgeServer", () => {
  test("start is idempotent across concurrent calls", async () => {
    const bridgeServer = new DesktopBridgeServer({
      desktopTokenManager: {
        validate: mock(() => null),
      },
      desktopSessionManager: {
        getLiveSessionConnection: mock(() => null),
      },
    });

    try {
      const [firstPort, secondPort, thirdPort] = await Promise.all([
        bridgeServer.start(),
        bridgeServer.start(),
        bridgeServer.start(),
      ]);

      expect(firstPort).toBeGreaterThan(0);
      expect(firstPort).toBe(secondPort);
      expect(firstPort).toBe(thirdPort);

      const probe = net.createConnection({ host: "127.0.0.1", port: firstPort });
      await new Promise<void>((resolve, reject) => {
        probe.once("connect", () => {
          probe.destroy();
          resolve();
        });
        probe.once("error", reject);
      });
    } finally {
      await bridgeServer.stop();
    }
  });

  test("bridges binary traffic in both directions for a valid token", async () => {
    const tcpHarness = await listenTcpServer();
    const bridgeServer = new DesktopBridgeServer({
      desktopTokenManager: {
        validate: mock((token: string) =>
          token === "valid-token"
            ? { workspaceId: "workspace-1", sessionId: "desktop:workspace-1" }
            : null
        ),
      },
      desktopSessionManager: {
        getLiveSessionConnection: mock((workspaceId: string) =>
          workspaceId === "workspace-1"
            ? { sessionId: "desktop:workspace-1", vncPort: tcpHarness.port }
            : null
        ),
      },
    });

    let ws: WebSocket | null = null;
    try {
      const port = await bridgeServer.start();
      ws = new WebSocket(`ws://127.0.0.1:${port}/?token=valid-token`);
      await waitForWebSocketOpen(ws);

      const tcpSocket = await tcpHarness.connectionPromise;
      ws.send(Buffer.from([0x01, 0x02, 0x03]));
      const forwarded = await waitForTcpData(tcpSocket);
      expect(forwarded).toEqual(Buffer.from([0x01, 0x02, 0x03]));

      tcpSocket.write(Buffer.from([0x0a, 0x0b, 0x0c]));
      expect(await waitForWebSocketMessage(ws)).toEqual(Buffer.from([0x0a, 0x0b, 0x0c]));
    } finally {
      if (ws) {
        await closeWebSocket(ws);
      }
      await bridgeServer.stop();
      await tcpHarness.close();
    }
  });

  test("closes with 4001 for invalid or missing tokens", async () => {
    const bridgeServer = new DesktopBridgeServer({
      desktopTokenManager: {
        validate: mock(() => null),
      },
      desktopSessionManager: {
        getLiveSessionConnection: mock(() => null),
      },
    });

    try {
      const port = await bridgeServer.start();

      for (const suffix of ["", "/?token=bad-token"]) {
        const ws = new WebSocket(`ws://127.0.0.1:${port}${suffix}`);
        const closeEvent = await waitForWebSocketClose(ws);
        expect(closeEvent.code).toBe(4001);
        expect(closeEvent.reason).toBe("invalid token");
      }
    } finally {
      await bridgeServer.stop();
    }
  });

  test("closes with 4002 when the live session is missing or mismatched", async () => {
    const scenarios = [
      { name: "missing session", liveSession: null },
      {
        name: "mismatched session",
        liveSession: { sessionId: "desktop:other-workspace", vncPort: 5900 },
      },
    ];

    for (const scenario of scenarios) {
      const bridgeServer = new DesktopBridgeServer({
        desktopTokenManager: {
          validate: mock(() => ({ workspaceId: "workspace-1", sessionId: "desktop:workspace-1" })),
        },
        desktopSessionManager: {
          getLiveSessionConnection: mock(() => scenario.liveSession),
        },
      });

      try {
        const port = await bridgeServer.start();
        const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=valid-token`);
        const closeEvent = await waitForWebSocketClose(ws);
        expect(closeEvent.code).toBe(4002);
        expect(closeEvent.reason).toBe("session unavailable");
      } finally {
        await bridgeServer.stop();
      }
    }
  });

  test("closes with 4003 when the VNC endpoint cannot be reached", async () => {
    const deadServer = await listenTcpServer();
    const deadPort = deadServer.port;
    await deadServer.close();

    const bridgeServer = new DesktopBridgeServer({
      desktopTokenManager: {
        validate: mock(() => ({ workspaceId: "workspace-1", sessionId: "desktop:workspace-1" })),
      },
      desktopSessionManager: {
        getLiveSessionConnection: mock(() => ({
          sessionId: "desktop:workspace-1",
          vncPort: deadPort,
        })),
      },
    });

    try {
      const port = await bridgeServer.start();
      const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=valid-token`);
      const closeEvent = await waitForWebSocketClose(ws);
      expect(closeEvent.code).toBe(4003);
      expect(closeEvent.reason).toBe("vnc connect failed");
    } finally {
      await bridgeServer.stop();
    }
  });

  test("stop closes active connections and is idempotent", async () => {
    const tcpHarness = await listenTcpServer();
    const bridgeServer = new DesktopBridgeServer({
      desktopTokenManager: {
        validate: mock(() => ({ workspaceId: "workspace-1", sessionId: "desktop:workspace-1" })),
      },
      desktopSessionManager: {
        getLiveSessionConnection: mock(() => ({
          sessionId: "desktop:workspace-1",
          vncPort: tcpHarness.port,
        })),
      },
    });

    let ws: WebSocket | null = null;
    try {
      const port = await bridgeServer.start();
      ws = new WebSocket(`ws://127.0.0.1:${port}/?token=valid-token`);
      await waitForWebSocketOpen(ws);
      await tcpHarness.connectionPromise;

      const closePromise = waitForWebSocketClose(ws);
      await bridgeServer.stop();
      const closeEvent = await closePromise;
      expect([1000, 1001]).toContain(closeEvent.code);

      await bridgeServer.stop();
    } finally {
      if (ws && ws.readyState !== WebSocket.CLOSED) {
        await closeWebSocket(ws);
      }
      await bridgeServer.stop();
      await tcpHarness.close();
    }
  });

  test("ignores text frames without breaking later binary traffic", async () => {
    const tcpHarness = await listenTcpServer();
    const bridgeServer = new DesktopBridgeServer({
      desktopTokenManager: {
        validate: mock(() => ({ workspaceId: "workspace-1", sessionId: "desktop:workspace-1" })),
      },
      desktopSessionManager: {
        getLiveSessionConnection: mock(() => ({
          sessionId: "desktop:workspace-1",
          vncPort: tcpHarness.port,
        })),
      },
    });

    let ws: WebSocket | null = null;
    try {
      const port = await bridgeServer.start();
      ws = new WebSocket(`ws://127.0.0.1:${port}/?token=valid-token`);
      await waitForWebSocketOpen(ws);

      const tcpSocket = await tcpHarness.connectionPromise;
      ws.send("ignored text frame");
      expect(await waitForTcpData(tcpSocket, 200)).toBeNull();

      ws.send(Buffer.from([0xde, 0xad]));
      expect(await waitForTcpData(tcpSocket)).toEqual(Buffer.from([0xde, 0xad]));
    } finally {
      if (ws) {
        await closeWebSocket(ws);
      }
      await bridgeServer.stop();
      await tcpHarness.close();
    }
  });
});
