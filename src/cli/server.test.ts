/**
 * Integration tests for the oRPC server endpoints (HTTP and WebSocket).
 *
 * These tests verify that:
 * 1. HTTP endpoint (/orpc) handles RPC calls correctly
 * 2. WebSocket endpoint (/orpc/ws) handles RPC calls correctly
 * 3. Streaming (eventIterator) works over both transports
 *
 * Uses bun:test for proper module isolation.
 * Tests the actual createOrpcServer function from orpcServer.ts.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import * as os from "os";
import * as path from "path";
import * as fs from "fs/promises";
import { WebSocket } from "ws";
import { RPCLink as HTTPRPCLink } from "@orpc/client/fetch";
import { RPCLink as WebSocketRPCLink } from "@orpc/client/websocket";
import { createORPCClient } from "@orpc/client";
import type { BrowserWindow, WebContents } from "electron";

import { type AppRouter } from "@/node/orpc/router";
import type { ORPCContext } from "@/node/orpc/context";
import { Config } from "@/node/config";
import { ServiceContainer } from "@/node/services/serviceContainer";
import type { RouterClient } from "@orpc/server";
import { createOrpcServer, type OrpcServer } from "@/node/orpc/server";

// --- Test Server Factory ---

interface TestServerHandle {
  server: OrpcServer;
  tempDir: string;
  close: () => Promise<void>;
}

/**
 * Create a test server using the actual createOrpcServer function.
 * Sets up services and config in a temp directory.
 */
async function createTestServer(): Promise<TestServerHandle> {
  // Create temp dir for config
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-server-test-"));
  const config = new Config(tempDir);

  // Mock BrowserWindow
  const mockWindow: BrowserWindow = {
    isDestroyed: () => false,
    setTitle: () => undefined,
    webContents: {
      send: () => undefined,
      openDevTools: () => undefined,
    } as unknown as WebContents,
  } as unknown as BrowserWindow;

  // Initialize services
  const services = new ServiceContainer(config);
  await services.initialize();
  services.windowService.setMainWindow(mockWindow);

  // Build context
  const context: ORPCContext = {
    config: services.config,
    aiService: services.aiService,
    projectService: services.projectService,
    workspaceService: services.workspaceService,
    providerService: services.providerService,
    terminalService: services.terminalService,
    editorService: services.editorService,
    windowService: services.windowService,
    updateService: services.updateService,
    tokenizerService: services.tokenizerService,
    serverService: services.serverService,
    mcpConfigService: services.mcpConfigService,
    featureFlagService: services.featureFlagService,
    sessionTimingService: services.sessionTimingService,
    mcpServerManager: services.mcpServerManager,
    menuEventService: services.menuEventService,
    experimentsService: services.experimentsService,
    voiceService: services.voiceService,
    telemetryService: services.telemetryService,
    sessionUsageService: services.sessionUsageService,
  };

  // Use the actual createOrpcServer function
  const server = await createOrpcServer({
    context,
    // port 0 = random available port
    onOrpcError: () => undefined, // Silence errors in tests
  });

  return {
    server,
    tempDir,
    close: async () => {
      await server.close();
      // Cleanup temp directory
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

// --- HTTP Client Factory ---

function createHttpClient(baseUrl: string): RouterClient<AppRouter> {
  const link = new HTTPRPCLink({
    url: `${baseUrl}/orpc`,
  });
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- needed for tsgo typecheck
  return createORPCClient(link) as RouterClient<AppRouter>;
}

// --- WebSocket Client Factory ---

interface WebSocketClientHandle {
  client: RouterClient<AppRouter>;
  close: () => void;
}

async function createWebSocketClient(wsUrl: string): Promise<WebSocketClientHandle> {
  const ws = new WebSocket(wsUrl);

  // Wait for connection to open
  await new Promise<void>((resolve, reject) => {
    ws.on("open", () => resolve());
    ws.on("error", reject);
  });

  const link = new WebSocketRPCLink({ websocket: ws as unknown as globalThis.WebSocket });
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- needed for tsgo typecheck
  const client = createORPCClient(link) as RouterClient<AppRouter>;

  return {
    client,
    close: () => ws.close(),
  };
}

// --- Tests ---

describe("oRPC Server Endpoints", () => {
  let serverHandle: TestServerHandle;

  beforeAll(async () => {
    serverHandle = await createTestServer();
  });

  afterAll(async () => {
    await serverHandle.close();
  });

  describe("Health and Version endpoints", () => {
    test("GET /health returns ok status", async () => {
      const response = await fetch(`${serverHandle.server.baseUrl}/health`);
      expect(response.ok).toBe(true);
      const data = (await response.json()) as { status: string };
      expect(data).toEqual({ status: "ok" });
    });

    test("GET /version returns version info with server mode", async () => {
      const response = await fetch(`${serverHandle.server.baseUrl}/version`);
      expect(response.ok).toBe(true);
      const data = (await response.json()) as {
        mode: string;
        git_commit: string;
        git_describe: string;
      };
      expect(data.mode).toBe("server");
      // VERSION object should have these fields (from src/version.ts)
      expect(typeof data.git_commit).toBe("string");
      expect(typeof data.git_describe).toBe("string");
    });
  });

  describe("HTTP endpoint (/orpc)", () => {
    test("ping returns pong response", async () => {
      const client = createHttpClient(serverHandle.server.baseUrl);
      const result = await client.general.ping("hello");
      expect(result).toBe("Pong: hello");
    });

    test("ping with empty string", async () => {
      const client = createHttpClient(serverHandle.server.baseUrl);
      const result = await client.general.ping("");
      expect(result).toBe("Pong: ");
    });

    test("tick streaming emits correct number of events", async () => {
      const client = createHttpClient(serverHandle.server.baseUrl);
      const ticks: Array<{ tick: number; timestamp: number }> = [];

      const stream = await client.general.tick({ count: 3, intervalMs: 50 });
      for await (const tick of stream) {
        ticks.push(tick);
      }

      expect(ticks).toHaveLength(3);
      expect(ticks.map((t) => t.tick)).toEqual([1, 2, 3]);

      // Verify timestamps are increasing
      for (let i = 1; i < ticks.length; i++) {
        expect(ticks[i].timestamp).toBeGreaterThanOrEqual(ticks[i - 1].timestamp);
      }
    });

    test("tick streaming with single tick", async () => {
      const client = createHttpClient(serverHandle.server.baseUrl);
      const ticks: Array<{ tick: number; timestamp: number }> = [];

      const stream = await client.general.tick({ count: 1, intervalMs: 10 });
      for await (const tick of stream) {
        ticks.push(tick);
      }

      expect(ticks).toHaveLength(1);
      expect(ticks[0].tick).toBe(1);
    });
  });

  describe("WebSocket endpoint (/orpc/ws)", () => {
    test("ping returns pong response", async () => {
      const { client, close } = await createWebSocketClient(serverHandle.server.wsUrl);
      try {
        const result = await client.general.ping("websocket-test");
        expect(result).toBe("Pong: websocket-test");
      } finally {
        close();
      }
    });

    test("ping with special characters", async () => {
      const { client, close } = await createWebSocketClient(serverHandle.server.wsUrl);
      try {
        const result = await client.general.ping("hello 🎉 world!");
        expect(result).toBe("Pong: hello 🎉 world!");
      } finally {
        close();
      }
    });

    test("tick streaming emits correct number of events", async () => {
      const { client, close } = await createWebSocketClient(serverHandle.server.wsUrl);
      try {
        const ticks: Array<{ tick: number; timestamp: number }> = [];

        const stream = await client.general.tick({ count: 3, intervalMs: 50 });
        for await (const tick of stream) {
          ticks.push(tick);
        }

        expect(ticks).toHaveLength(3);
        expect(ticks.map((t) => t.tick)).toEqual([1, 2, 3]);

        // Verify timestamps are increasing
        for (let i = 1; i < ticks.length; i++) {
          expect(ticks[i].timestamp).toBeGreaterThanOrEqual(ticks[i - 1].timestamp);
        }
      } finally {
        close();
      }
    });

    test("tick streaming with longer interval", async () => {
      const { client, close } = await createWebSocketClient(serverHandle.server.wsUrl);
      try {
        const ticks: Array<{ tick: number; timestamp: number }> = [];
        const startTime = Date.now();

        const stream = await client.general.tick({ count: 2, intervalMs: 100 });
        for await (const tick of stream) {
          ticks.push(tick);
        }

        const elapsed = Date.now() - startTime;

        expect(ticks).toHaveLength(2);
        // Should take at least 100ms (1 interval between 2 ticks)
        expect(elapsed).toBeGreaterThanOrEqual(90); // Allow small margin
      } finally {
        close();
      }
    });

    test("multiple sequential requests on same connection", async () => {
      const { client, close } = await createWebSocketClient(serverHandle.server.wsUrl);
      try {
        const result1 = await client.general.ping("first");
        const result2 = await client.general.ping("second");
        const result3 = await client.general.ping("third");

        expect(result1).toBe("Pong: first");
        expect(result2).toBe("Pong: second");
        expect(result3).toBe("Pong: third");
      } finally {
        close();
      }
    });
  });

  describe("Cross-transport consistency", () => {
    test("HTTP and WebSocket return same ping result", async () => {
      const httpClient = createHttpClient(serverHandle.server.baseUrl);
      const { client: wsClient, close } = await createWebSocketClient(serverHandle.server.wsUrl);

      try {
        const testInput = "consistency-test";
        const httpResult = await httpClient.general.ping(testInput);
        const wsResult = await wsClient.general.ping(testInput);

        expect(httpResult).toBe(wsResult);
      } finally {
        close();
      }
    });

    test("HTTP and WebSocket streaming produce same tick sequence", async () => {
      const httpClient = createHttpClient(serverHandle.server.baseUrl);
      const { client: wsClient, close } = await createWebSocketClient(serverHandle.server.wsUrl);

      try {
        const httpTicks: number[] = [];
        const wsTicks: number[] = [];

        const httpStream = await httpClient.general.tick({ count: 3, intervalMs: 10 });
        for await (const tick of httpStream) {
          httpTicks.push(tick.tick);
        }

        const wsStream = await wsClient.general.tick({ count: 3, intervalMs: 10 });
        for await (const tick of wsStream) {
          wsTicks.push(tick.tick);
        }

        expect(httpTicks).toEqual(wsTicks);
        expect(httpTicks).toEqual([1, 2, 3]);
      } finally {
        close();
      }
    });
  });
});
