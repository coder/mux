/**
 * Integration tests for mux-server HTTP/WebSocket functionality
 *
 * These tests spin up actual server instances and verify:
 * - Health check endpoint
 * - Authentication (when configured)
 * - IPC channel routing
 * - WebSocket connections and subscriptions
 * - Project listing/management
 *
 * Run with: TEST_INTEGRATION=1 bun x jest tests/server/server.test.ts
 * Requires: make build-main (tests use built server from dist/cli/server.js)
 */
import { IPC_CHANNELS } from "../../src/common/constants/ipc-constants";
import { shouldRunIntegrationTests } from "../testUtils";
import {
  type ServerTestContext,
  startServer,
  stopServer,
  prepareTestMuxRoot,
  prepareTestMuxRootWithProject,
  cleanupTestMuxRoot,
  ipcRequest,
  createWebSocket,
  waitForWsOpen,
} from "./serverTestUtils";

// Skip all tests if TEST_INTEGRATION is not set
const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

// Each test gets a unique ID to avoid directory conflicts
let testCounter = 0;
function getTestId(): string {
  return `server-test-${Date.now()}-${++testCounter}`;
}

describeIntegration("mux-server", () => {
  describe("health endpoint", () => {
    let ctx: ServerTestContext;
    let muxRoot: string;

    beforeAll(async () => {
      muxRoot = prepareTestMuxRoot(getTestId());
      ctx = await startServer({ muxRoot });
    });

    afterAll(async () => {
      await stopServer(ctx);
      cleanupTestMuxRoot(muxRoot);
    });

    test("returns 200 OK", async () => {
      const response = await fetch(`${ctx.baseUrl}/health`);
      expect(response.ok).toBe(true);
    });

    test("returns status ok", async () => {
      const response = await fetch(`${ctx.baseUrl}/health`);
      const data = await response.json();
      expect(data).toEqual({ status: "ok" });
    });
  });

  describe("version endpoint", () => {
    let ctx: ServerTestContext;
    let muxRoot: string;

    beforeAll(async () => {
      muxRoot = prepareTestMuxRoot(getTestId());
      ctx = await startServer({ muxRoot });
    });

    afterAll(async () => {
      await stopServer(ctx);
      cleanupTestMuxRoot(muxRoot);
    });

    test("returns version info", async () => {
      const response = await fetch(`${ctx.baseUrl}/version`);
      expect(response.ok).toBe(true);
      const data = await response.json();
      // Version info has git_describe, git_commit, buildTime, mode
      expect(data).toHaveProperty("git_describe");
      expect(data).toHaveProperty("mode", "server");
    });
  });

  describe("authentication", () => {
    const AUTH_TOKEN = "test-secret-token-12345";
    let ctx: ServerTestContext;
    let muxRoot: string;

    beforeAll(async () => {
      muxRoot = prepareTestMuxRoot(getTestId());
      ctx = await startServer({ muxRoot, authToken: AUTH_TOKEN });
    });

    afterAll(async () => {
      await stopServer(ctx);
      cleanupTestMuxRoot(muxRoot);
    });

    test("health endpoint is public (no auth required)", async () => {
      const response = await fetch(`${ctx.baseUrl}/health`);
      expect(response.ok).toBe(true);
    });

    test("IPC endpoint rejects requests without auth", async () => {
      const channel = encodeURIComponent(IPC_CHANNELS.PROJECT_LIST);
      const response = await fetch(`${ctx.baseUrl}/ipc/${channel}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ args: [] }),
      });
      expect(response.status).toBe(401);
    });

    test("IPC endpoint rejects requests with wrong auth", async () => {
      const channel = encodeURIComponent(IPC_CHANNELS.PROJECT_LIST);
      const response = await fetch(`${ctx.baseUrl}/ipc/${channel}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer wrong-token",
        },
        body: JSON.stringify({ args: [] }),
      });
      expect(response.status).toBe(401);
    });

    test("IPC endpoint accepts requests with correct auth", async () => {
      const channel = encodeURIComponent(IPC_CHANNELS.PROJECT_LIST);
      const response = await fetch(`${ctx.baseUrl}/ipc/${channel}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${AUTH_TOKEN}`,
        },
        body: JSON.stringify({ args: [] }),
      });
      expect(response.ok).toBe(true);
    });

    test("WebSocket rejects connection without auth", async () => {
      const ws = createWebSocket({ ...ctx, authToken: undefined });
      // Server accepts the connection but immediately closes with 1008 (Policy Violation)
      await waitForWsOpen(ws);
      const closePromise = new Promise<number>((resolve) => {
        ws.on("close", (code) => resolve(code));
      });
      const closeCode = await closePromise;
      expect(closeCode).toBe(1008); // Policy Violation = Unauthorized
    });

    test("WebSocket accepts connection with correct auth", async () => {
      const ws = createWebSocket(ctx);
      await waitForWsOpen(ws);
      expect(ws.readyState).toBe(ws.OPEN);
      ws.close();
    });
  });

  describe("IPC channels", () => {
    let ctx: ServerTestContext;
    let muxRoot: string;

    beforeAll(async () => {
      muxRoot = prepareTestMuxRoot(getTestId());
      ctx = await startServer({ muxRoot });
    });

    afterAll(async () => {
      await stopServer(ctx);
      cleanupTestMuxRoot(muxRoot);
    });

    test("project:list returns empty array for fresh config", async () => {
      const result = await ipcRequest(ctx, IPC_CHANNELS.PROJECT_LIST);
      expect(result.success).toBe(true);
      expect(Array.isArray(result.data)).toBe(true);
      expect(result.data).toHaveLength(0);
    });

    test("providers:getConfig returns provider configuration", async () => {
      const result = await ipcRequest(ctx, IPC_CHANNELS.PROVIDERS_GET_CONFIG);
      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
    });

    test("providers:list returns available providers", async () => {
      const result = await ipcRequest(ctx, IPC_CHANNELS.PROVIDERS_LIST);
      expect(result.success).toBe(true);
      expect(Array.isArray(result.data)).toBe(true);
      // Should have at least anthropic provider
      const providers = result.data as string[];
      expect(providers).toContain("anthropic");
    });

    test("unknown IPC channel returns 404", async () => {
      const response = await fetch(`${ctx.baseUrl}/ipc/unknown:channel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ args: [] }),
      });
      expect(response.status).toBe(404);
    });
  });

  describe("project operations with git repo", () => {
    let ctx: ServerTestContext;
    let muxRoot: string;
    let projectPath: string;

    beforeAll(async () => {
      const setup = await prepareTestMuxRootWithProject(getTestId());
      muxRoot = setup.muxRoot;
      projectPath = setup.projectPath;
      ctx = await startServer({ muxRoot });
    });

    afterAll(async () => {
      await stopServer(ctx);
      cleanupTestMuxRoot(muxRoot);
    });

    test("project:list returns configured project", async () => {
      const result = await ipcRequest(ctx, IPC_CHANNELS.PROJECT_LIST);
      expect(result.success).toBe(true);
      const projects = result.data as Array<[string, unknown]>;
      expect(projects.length).toBe(1);
      expect(projects[0][0]).toBe(projectPath);
    });

    test("project:listBranches returns branches for project", async () => {
      const result = await ipcRequest(ctx, IPC_CHANNELS.PROJECT_LIST_BRANCHES, [projectPath]);
      expect(result.success).toBe(true);
      // Returns { branches: string[], recommendedTrunk: string }
      const data = result.data as { branches: string[]; recommendedTrunk: string };
      expect(Array.isArray(data.branches)).toBe(true);
      expect(data.branches.length).toBeGreaterThan(0);
      expect(typeof data.recommendedTrunk).toBe("string");
    });
  });

  describe("WebSocket subscriptions", () => {
    let ctx: ServerTestContext;
    let muxRoot: string;

    beforeAll(async () => {
      muxRoot = prepareTestMuxRoot(getTestId());
      ctx = await startServer({ muxRoot });
    });

    afterAll(async () => {
      await stopServer(ctx);
      cleanupTestMuxRoot(muxRoot);
    });

    test("can subscribe to workspace:metadata", async () => {
      const ws = createWebSocket(ctx);
      await waitForWsOpen(ws);

      // Send subscribe message
      ws.send(
        JSON.stringify({
          type: "subscribe",
          channel: "workspace:metadata",
        })
      );

      // Give server time to process subscription
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Connection should still be open (no errors)
      expect(ws.readyState).toBe(ws.OPEN);
      ws.close();
    });

    test("can subscribe to workspace:activity", async () => {
      const ws = createWebSocket(ctx);
      await waitForWsOpen(ws);

      ws.send(
        JSON.stringify({
          type: "subscribe",
          channel: "workspace:activity",
        })
      );

      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(ws.readyState).toBe(ws.OPEN);
      ws.close();
    });

    test("can unsubscribe from channels", async () => {
      const ws = createWebSocket(ctx);
      await waitForWsOpen(ws);

      // Subscribe
      ws.send(
        JSON.stringify({
          type: "subscribe",
          channel: "workspace:metadata",
        })
      );

      await new Promise((resolve) => setTimeout(resolve, 50));

      // Unsubscribe
      ws.send(
        JSON.stringify({
          type: "unsubscribe",
          channel: "workspace:metadata",
        })
      );

      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(ws.readyState).toBe(ws.OPEN);
      ws.close();
    });
  });

  describe("--add-project flag", () => {
    test("creates project from git repository path", async () => {
      const testId = getTestId();
      const setup = await prepareTestMuxRootWithProject(testId);

      // Start server with --add-project pointing to a new git repo
      // The setup already created one, but let's create another one for this test
      const { execSync } = await import("child_process");
      const fs = await import("fs");
      const path = await import("path");

      const newProjectPath = path.join(setup.muxRoot, "fixtures", "added-project");
      fs.mkdirSync(newProjectPath, { recursive: true });
      execSync("git init", { cwd: newProjectPath, stdio: "ignore" });
      execSync("git config user.email test@test.com", { cwd: newProjectPath, stdio: "ignore" });
      execSync("git config user.name Test", { cwd: newProjectPath, stdio: "ignore" });
      fs.writeFileSync(path.join(newProjectPath, "README.md"), "# Added Project\n");
      execSync("git add .", { cwd: newProjectPath, stdio: "ignore" });
      execSync('git commit -m "initial"', { cwd: newProjectPath, stdio: "ignore" });

      // Reset config to empty
      fs.writeFileSync(
        path.join(setup.muxRoot, "config.json"),
        JSON.stringify({ projects: [] }, null, 2)
      );

      const ctx = await startServer({
        muxRoot: setup.muxRoot,
        addProject: newProjectPath,
      });

      try {
        // Wait a bit for project creation to complete
        await new Promise((resolve) => setTimeout(resolve, 500));

        // Verify project was added
        const result = await ipcRequest(ctx, IPC_CHANNELS.PROJECT_LIST);
        expect(result.success).toBe(true);
        const projects = result.data as Array<[string, unknown]>;
        expect(projects.length).toBe(1);
        expect(projects[0][0]).toBe(newProjectPath);
      } finally {
        await stopServer(ctx);
        cleanupTestMuxRoot(setup.muxRoot);
      }
    });
  });
});
