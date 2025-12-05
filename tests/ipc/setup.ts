import * as os from "os";
import * as path from "path";
import * as fs from "fs/promises";
import type { BrowserWindow, WebContents } from "electron";
import { Config } from "../../src/node/config";
import { ServiceContainer } from "../../src/node/services/serviceContainer";
import {
  generateBranchName,
  createWorkspace,
  resolveOrpcClient,
  createTempGitRepo,
  cleanupTempGitRepo,
} from "./helpers";
import type { OrpcSource } from "./helpers";
import type { ORPCContext } from "../../src/node/orpc/context";
import { createOrpcTestClient, type OrpcTestClient } from "./orpcTestClient";
import { shouldRunIntegrationTests, validateApiKeys, getApiKey } from "../testUtils";

export interface TestEnvironment {
  config: Config;
  services: ServiceContainer;
  mockWindow: BrowserWindow;
  tempDir: string;
  orpc: OrpcTestClient;
}

/**
 * Create a mock BrowserWindow for tests.
 * Note: Events are now consumed via ORPC subscriptions (StreamCollector),
 * not via windowService.send(). This mock just satisfies the window service API.
 */
function createMockBrowserWindow(): BrowserWindow {
  const mockWindow = {
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

  return mockWindow;
}

/**
 * Create a test environment with temporary config and service container
 */
export async function createTestEnvironment(): Promise<TestEnvironment> {
  // Create temporary directory for test config
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-test-"));

  // Create config with temporary directory
  const config = new Config(tempDir);

  // Create mock BrowserWindow
  const mockWindow = createMockBrowserWindow();

  // Create ServiceContainer instance
  const services = new ServiceContainer(config);
  await services.initialize();

  // Wire services to the mock BrowserWindow
  // Note: Events are consumed via ORPC subscriptions (StreamCollector), not windowService.send()
  services.windowService.setMainWindow(mockWindow);

  const orpcContext: ORPCContext = {
    config: services.config,
    aiService: services.aiService,
    projectService: services.projectService,
    workspaceService: services.workspaceService,
    providerService: services.providerService,
    terminalService: services.terminalService,
    windowService: services.windowService,
    updateService: services.updateService,
    tokenizerService: services.tokenizerService,
    serverService: services.serverService,
    menuEventService: services.menuEventService,
    voiceService: services.voiceService,
    telemetryService: services.telemetryService,
  };
  const orpc = createOrpcTestClient(orpcContext);

  return {
    config,
    services,
    mockWindow,
    tempDir,
    orpc,
  };
}

/**
 * Cleanup test environment (remove temporary directory) with retry logic
 */
export async function cleanupTestEnvironment(env: TestEnvironment): Promise<void> {
  const maxRetries = 3;
  let lastError: unknown;

  for (let i = 0; i < maxRetries; i++) {
    try {
      await fs.rm(env.tempDir, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      // Wait before retry (files might be locked temporarily)
      if (i < maxRetries - 1) {
        await new Promise((resolve) => setTimeout(resolve, 100 * (i + 1)));
      }
    }
  }
  console.warn(`Failed to cleanup test environment after ${maxRetries} attempts:`, lastError);
}

/**
 * Setup provider configuration via IPC
 */
export async function setupProviders(
  source: OrpcSource,
  providers: Record<string, { apiKey?: string; baseUrl?: string; [key: string]: unknown }>
): Promise<void> {
  const client = resolveOrpcClient(source);
  for (const [providerName, providerConfig] of Object.entries(providers)) {
    for (const [key, value] of Object.entries(providerConfig)) {
      const result = await client.providers.setProviderConfig({
        provider: providerName,
        keyPath: [key],
        value: String(value),
      });

      if (!result.success) {
        throw new Error(
          `Failed to set provider config for ${providerName}.${key}: ${result.error}`
        );
      }
    }
  }
}

// Re-export test utilities for backwards compatibility
export { shouldRunIntegrationTests, validateApiKeys, getApiKey };

/**
 * Preload modules that may be imported dynamically during concurrent tests.
 * Call this in beforeAll hooks to prevent Jest sandbox race conditions.
 */
export async function preloadTestModules(): Promise<void> {
  const [{ loadTokenizerModules }, { preloadAISDKProviders }] = await Promise.all([
    import("../../src/node/utils/main/tokenizer"),
    import("../../src/node/services/aiService"),
  ]);
  await Promise.all([loadTokenizerModules(), preloadAISDKProviders()]);
}

/**
 * Setup a complete workspace with provider
 * Encapsulates: env creation, provider setup, workspace creation, event clearing
 */
export async function setupWorkspace(
  provider: string,
  branchPrefix?: string
): Promise<{
  env: TestEnvironment;
  workspaceId: string;
  workspacePath: string;
  branchName: string;
  tempGitRepo: string;
  cleanup: () => Promise<void>;
}> {
  // Create dedicated temp git repo for this test
  const tempGitRepo = await createTempGitRepo();

  const env = await createTestEnvironment();

  // Ollama doesn't require API keys - it's a local service
  if (provider === "ollama") {
    await setupProviders(env, {
      [provider]: {
        baseUrl: process.env.OLLAMA_BASE_URL || "http://localhost:11434/api",
      },
    });
  } else {
    await setupProviders(env, {
      [provider]: {
        apiKey: getApiKey(`${provider.toUpperCase()}_API_KEY`),
      },
    });
  }

  const branchName = generateBranchName(branchPrefix || provider);
  const createResult = await createWorkspace(env, tempGitRepo, branchName);

  if (!createResult.success) {
    await cleanupTempGitRepo(tempGitRepo);
    throw new Error(`Workspace creation failed: ${createResult.error}`);
  }

  if (!createResult.metadata.id) {
    await cleanupTempGitRepo(tempGitRepo);
    throw new Error("Workspace ID not returned from creation");
  }

  if (!createResult.metadata.namedWorkspacePath) {
    await cleanupTempGitRepo(tempGitRepo);
    throw new Error("Workspace path not returned from creation");
  }

  const cleanup = async () => {
    await cleanupTestEnvironment(env);
    await cleanupTempGitRepo(tempGitRepo);
  };

  return {
    env,
    workspaceId: createResult.metadata.id,
    workspacePath: createResult.metadata.namedWorkspacePath,
    branchName,
    tempGitRepo,
    cleanup,
  };
}

/**
 * Setup workspace without provider (for API key error tests).
 * Also clears Anthropic env vars to ensure the error check works.
 */
export async function setupWorkspaceWithoutProvider(branchPrefix?: string): Promise<{
  env: TestEnvironment;
  workspaceId: string;
  workspacePath: string;
  branchName: string;
  tempGitRepo: string;
  cleanup: () => Promise<void>;
}> {
  // Clear Anthropic env vars to ensure api_key_not_found error is triggered.
  // Save original values for restoration in cleanup.
  const savedEnvVars = {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
    ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
  };
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  delete process.env.ANTHROPIC_BASE_URL;

  // Create dedicated temp git repo for this test
  const tempGitRepo = await createTempGitRepo();

  const env = await createTestEnvironment();

  const branchName = generateBranchName(branchPrefix || "noapi");
  const createResult = await createWorkspace(env, tempGitRepo, branchName);

  if (!createResult.success) {
    // Restore env vars before throwing
    Object.assign(process.env, savedEnvVars);
    await cleanupTempGitRepo(tempGitRepo);
    throw new Error(`Workspace creation failed: ${createResult.error}`);
  }

  if (!createResult.metadata.id) {
    Object.assign(process.env, savedEnvVars);
    await cleanupTempGitRepo(tempGitRepo);
    throw new Error("Workspace ID not returned from creation");
  }

  if (!createResult.metadata.namedWorkspacePath) {
    Object.assign(process.env, savedEnvVars);
    await cleanupTempGitRepo(tempGitRepo);
    throw new Error("Workspace path not returned from creation");
  }

  const cleanup = async () => {
    // Restore env vars
    for (const [key, value] of Object.entries(savedEnvVars)) {
      if (value !== undefined) {
        process.env[key] = value;
      }
    }
    await cleanupTestEnvironment(env);
    await cleanupTempGitRepo(tempGitRepo);
  };

  return {
    env,
    workspaceId: createResult.metadata.id,
    workspacePath: createResult.metadata.namedWorkspacePath,
    branchName,
    tempGitRepo,
    cleanup,
  };
}
