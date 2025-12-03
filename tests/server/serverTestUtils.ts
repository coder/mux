/**
 * Test utilities for mux-server integration tests
 * These tests verify the HTTP/WebSocket server functionality
 */
import { spawn, type ChildProcess } from "child_process";
import fs from "fs";
import path from "path";
import WebSocket from "ws";

export interface ServerTestContext {
  serverProcess: ChildProcess;
  port: number;
  host: string;
  muxRoot: string;
  authToken?: string;
  baseUrl: string;
}

export interface StartServerOptions {
  port?: number;
  host?: string;
  authToken?: string;
  addProject?: string;
  muxRoot: string;
}

const APP_ROOT = path.resolve(__dirname, "..", "..");
const DEFAULT_PORT = 13000; // Use high port to avoid conflicts
const DEFAULT_HOST = "127.0.0.1";
const SERVER_STARTUP_TIMEOUT_MS = 15_000;

/**
 * Prepare a test MUX_ROOT directory with minimal config
 */
export function prepareTestMuxRoot(testId: string): string {
  const testRoot = path.join(APP_ROOT, "tests", "server", "tmp", testId);
  fs.rmSync(testRoot, { recursive: true, force: true });
  fs.mkdirSync(path.join(testRoot, "sessions"), { recursive: true });
  fs.mkdirSync(path.join(testRoot, "src"), { recursive: true });

  // Write minimal config
  fs.writeFileSync(path.join(testRoot, "config.json"), JSON.stringify({ projects: [] }, null, 2));

  return testRoot;
}

/**
 * Prepare a test MUX_ROOT with a git project for project-dependent tests
 */
export async function prepareTestMuxRootWithProject(testId: string): Promise<{
  muxRoot: string;
  projectPath: string;
  workspacePath: string;
}> {
  const testRoot = prepareTestMuxRoot(testId);
  const projectPath = path.join(testRoot, "fixtures", "test-repo");
  const workspacePath = path.join(testRoot, "src", "test-repo", "main");

  // Create project directory as a git repo
  fs.mkdirSync(projectPath, { recursive: true });
  fs.mkdirSync(workspacePath, { recursive: true });

  // Initialize git repo
  const { execSync } = await import("child_process");
  execSync("git init", { cwd: projectPath, stdio: "ignore" });
  execSync("git config user.email test@test.com", { cwd: projectPath, stdio: "ignore" });
  execSync("git config user.name Test", { cwd: projectPath, stdio: "ignore" });
  fs.writeFileSync(path.join(projectPath, "README.md"), "# Test Repo\n");
  execSync("git add .", { cwd: projectPath, stdio: "ignore" });
  execSync('git commit -m "initial"', { cwd: projectPath, stdio: "ignore" });

  // Update config to include project
  const config = {
    projects: [[projectPath, { workspaces: [{ path: workspacePath }] }]],
  };
  fs.writeFileSync(path.join(testRoot, "config.json"), JSON.stringify(config, null, 2));

  return { muxRoot: testRoot, projectPath, workspacePath };
}

/**
 * Clean up test directory
 */
export function cleanupTestMuxRoot(muxRoot: string): void {
  fs.rmSync(muxRoot, { recursive: true, force: true });
}

/**
 * Start the mux-server process
 * Uses the built server from dist/cli/server.js (requires `make build-main` first)
 */
export async function startServer(options: StartServerOptions): Promise<ServerTestContext> {
  const port = options.port ?? DEFAULT_PORT + Math.floor(Math.random() * 1000);
  const host = options.host ?? DEFAULT_HOST;

  // Use built server - must run `make build-main` before tests
  const serverPath = path.join(APP_ROOT, "dist", "cli", "server.js");
  if (!fs.existsSync(serverPath)) {
    throw new Error(`Server not built. Run 'make build-main' first. Expected: ${serverPath}`);
  }

  const args = [serverPath, "--host", host, "--port", String(port)];

  if (options.authToken) {
    args.push("--auth-token", options.authToken);
  }

  if (options.addProject) {
    args.push("--add-project", options.addProject);
  }

  const serverProcess = spawn("node", args, {
    cwd: APP_ROOT,
    env: {
      ...process.env,
      MUX_ROOT: options.muxRoot,
      NODE_ENV: "test",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const baseUrl = `http://${host}:${port}`;

  // Collect stderr for debugging
  let stderr = "";
  serverProcess.stderr?.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  // Wait for server to be ready
  const startTime = Date.now();
  while (Date.now() - startTime < SERVER_STARTUP_TIMEOUT_MS) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) {
        return {
          serverProcess,
          port,
          host,
          muxRoot: options.muxRoot,
          authToken: options.authToken,
          baseUrl,
        };
      }
    } catch {
      // Server not ready yet
    }
    await sleep(100);
  }

  // Server failed to start
  serverProcess.kill();
  throw new Error(
    `Server failed to start within ${SERVER_STARTUP_TIMEOUT_MS}ms. Stderr: ${stderr}`
  );
}

/**
 * Stop the server process
 */
export async function stopServer(ctx: ServerTestContext): Promise<void> {
  if (ctx.serverProcess.exitCode === null) {
    ctx.serverProcess.kill("SIGTERM");
    // Give it time to shut down gracefully
    await sleep(500);
    if (ctx.serverProcess.exitCode === null) {
      ctx.serverProcess.kill("SIGKILL");
    }
  }
}

/**
 * Make an IPC request to the server
 */
export async function ipcRequest(
  ctx: ServerTestContext,
  channel: string,
  args: unknown[] = []
): Promise<{ success: boolean; data?: unknown; error?: string }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (ctx.authToken) {
    headers["Authorization"] = `Bearer ${ctx.authToken}`;
  }

  const response = await fetch(`${ctx.baseUrl}/ipc/${encodeURIComponent(channel)}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ args }),
  });

  return response.json();
}

/**
 * Create a WebSocket connection to the server
 * Uses query param authentication (most reliable for ws library)
 */
export function createWebSocket(ctx: ServerTestContext): WebSocket {
  let wsUrl = ctx.baseUrl.replace("http://", "ws://") + "/ws";

  // Use query param auth - more reliable than headers with ws library
  if (ctx.authToken) {
    wsUrl += `?token=${encodeURIComponent(ctx.authToken)}`;
  }

  return new WebSocket(wsUrl);
}

/**
 * Wait for WebSocket to open
 */
export function waitForWsOpen(ws: WebSocket, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`WebSocket connection timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    ws.once("open", () => {
      clearTimeout(timeout);
      resolve();
    });

    ws.once("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

/**
 * Wait for a WebSocket message matching a predicate
 */
export function waitForWsMessage<T>(
  ws: WebSocket,
  predicate: (data: unknown) => data is T,
  timeoutMs = 5000
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timeout waiting for WebSocket message after ${timeoutMs}ms`));
    }, timeoutMs);

    const onMessage = (data: WebSocket.RawData) => {
      try {
        const parsed = JSON.parse(data.toString());
        if (predicate(parsed)) {
          cleanup();
          resolve(parsed);
        }
      } catch {
        // Ignore parse errors
      }
    };

    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };

    const onClose = () => {
      cleanup();
      reject(new Error("WebSocket closed while waiting for message"));
    };

    const cleanup = () => {
      clearTimeout(timeout);
      ws.off("message", onMessage);
      ws.off("error", onError);
      ws.off("close", onClose);
    };

    ws.on("message", onMessage);
    ws.once("error", onError);
    ws.once("close", onClose);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
