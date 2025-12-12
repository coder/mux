/**
 * Browser integration test setup.
 *
 * Creates a real backend environment (ServiceContainer + oRPC) for testing
 * React components with full app state. Reuses patterns from tests/ipc/setup.ts.
 */

import * as os from "os";
import * as path from "path";
import * as fs from "fs/promises";
import { exec } from "child_process";
import { promisify } from "util";
import type { BrowserWindow, WebContents } from "electron";
import { Config } from "@/node/config";
import { ServiceContainer } from "@/node/services/serviceContainer";
import type { ORPCContext } from "@/node/orpc/context";
import { createOrpcTestClient, type OrpcTestClient } from "../../ipc/orpcTestClient";
import type { APIClient } from "@/browser/contexts/API";

const execAsync = promisify(exec);

export interface BrowserTestEnv {
  /** Real oRPC client (cast to APIClient for React components) */
  api: APIClient;
  /** Direct oRPC client for backend assertions */
  orpc: OrpcTestClient;
  /** Temp config directory */
  tempDir: string;
  /** ServiceContainer for direct access if needed */
  services: ServiceContainer;
  /** Cleanup function - call in afterEach */
  cleanup: () => Promise<void>;
}

/**
 * Create a mock BrowserWindow for tests.
 * Events are consumed via ORPC subscriptions, not windowService.send().
 */
function createMockBrowserWindow(): BrowserWindow {
  return {
    webContents: {
      send: jest.fn(),
      openDevTools: jest.fn(),
    } as unknown as WebContents,
    isDestroyed: jest.fn(() => false),
    isMinimized: jest.fn(() => false),
    restore: jest.fn(),
    focus: jest.fn(),
    loadURL: jest.fn(),
    on: jest.fn(),
    setTitle: jest.fn(),
  } as unknown as BrowserWindow;
}

/**
 * Create a browser test environment with real backend.
 *
 * Usage:
 * ```ts
 * let env: BrowserTestEnv;
 * beforeEach(async () => { env = await createBrowserTestEnv(); });
 * afterEach(async () => { await env.cleanup(); });
 * ```
 */
export async function createBrowserTestEnv(): Promise<BrowserTestEnv> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-browser-test-"));
  // Prevent browser UI tests from making real network calls for AI.
  // This keeps tests hermetic even if the environment has provider credentials.
  const previousMockAI = process.env.MUX_MOCK_AI;
  process.env.MUX_MOCK_AI = "1";

  const config = new Config(tempDir);
  const mockWindow = createMockBrowserWindow();

  const services = new ServiceContainer(config);
  await services.initialize();
  services.windowService.setMainWindow(mockWindow);

  const orpcContext: ORPCContext = {
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
    mcpServerManager: services.mcpServerManager,
    menuEventService: services.menuEventService,
    voiceService: services.voiceService,
    telemetryService: services.telemetryService,
  };

  const orpc = createOrpcTestClient(orpcContext);

  // Cast OrpcTestClient to APIClient - they have compatible interfaces
  // since OrpcTestClient is RouterClient<AppRouter> and APIClient is the same
  const api = orpc as unknown as APIClient;

  const cleanup = async () => {
    try {
      await services.shutdown();
    } finally {
      await services.dispose();
    }

    const maxRetries = 3;

    // Restore process env to avoid leaking mock mode across unrelated tests.
    if (previousMockAI === undefined) {
      delete process.env.MUX_MOCK_AI;
    } else {
      process.env.MUX_MOCK_AI = previousMockAI;
    }
    for (let i = 0; i < maxRetries; i++) {
      try {
        await fs.rm(tempDir, { recursive: true, force: true });
        return;
      } catch {
        if (i < maxRetries - 1) {
          await new Promise((r) => setTimeout(r, 100 * (i + 1)));
        }
      }
    }
  };

  return { api, orpc, tempDir, services, cleanup };
}

/**
 * Create a temporary git repository for testing.
 * Returns the path to the repo.
 */
export async function createTempGitRepo(): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-test-repo-"));

  // Initialize with main as the default branch name for consistency
  await execAsync("git init -b main", { cwd: tempDir });
  await execAsync(
    'git config user.email "test@example.com" && git config user.name "Test User" && git config commit.gpgsign false',
    { cwd: tempDir }
  );
  await execAsync(
    'echo "test" > README.md && git add . && git commit -m "Initial commit" && git branch test-branch',
    { cwd: tempDir }
  );

  return tempDir;
}

/**
 * Cleanup a temporary git repository.
 */
export async function cleanupTempGitRepo(repoPath: string): Promise<void> {
  const maxRetries = 3;
  for (let i = 0; i < maxRetries; i++) {
    try {
      await fs.rm(repoPath, { recursive: true, force: true });
      return;
    } catch {
      if (i < maxRetries - 1) {
        await new Promise((r) => setTimeout(r, 100 * (i + 1)));
      }
    }
  }
}
