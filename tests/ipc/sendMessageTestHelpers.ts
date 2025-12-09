/**
 * Shared test helpers for sendMessage integration tests.
 *
 * Provides workspace setup and teardown utilities that are shared across
 * multiple sendMessage test files to avoid duplication and ensure consistency.
 */

import {
  createTestEnvironment,
  cleanupTestEnvironment,
  setupProviders,
  preloadTestModules,
  type TestEnvironment,
} from "./setup";
import {
  createTempGitRepo,
  cleanupTempGitRepo,
  generateBranchName,
  createStreamCollector,
  INIT_HOOK_WAIT_MS,
} from "./helpers";
import { detectDefaultTrunkBranch } from "../../src/node/git";
import { getApiKey } from "../testUtils";

// Shared test environment and git repo
let sharedEnv: TestEnvironment | null = null;
let sharedRepoPath: string | null = null;

/**
 * Create shared test environment and git repo.
 * Call in beforeAll() to share resources across tests.
 */
export async function createSharedRepo(): Promise<void> {
  await preloadTestModules();
  sharedEnv = await createTestEnvironment();
  sharedRepoPath = await createTempGitRepo();
}

/**
 * Cleanup shared test environment.
 * Call in afterAll() to clean up resources.
 */
export async function cleanupSharedRepo(): Promise<void> {
  if (sharedRepoPath) {
    await cleanupTempGitRepo(sharedRepoPath);
    sharedRepoPath = null;
  }
  if (sharedEnv) {
    await cleanupTestEnvironment(sharedEnv);
    sharedEnv = null;
  }
}

/**
 * Get the shared test environment.
 * Throws if createSharedRepo() hasn't been called.
 */
export function getSharedEnv(): TestEnvironment {
  if (!sharedEnv) {
    throw new Error("Shared environment not initialized. Call createSharedRepo() in beforeAll().");
  }
  return sharedEnv;
}

/**
 * Get the shared git repo path.
 * Throws if createSharedRepo() hasn't been called.
 */
export function getSharedRepoPath(): string {
  if (!sharedRepoPath) {
    throw new Error("Shared repo not initialized. Call createSharedRepo() in beforeAll().");
  }
  return sharedRepoPath;
}

interface SharedWorkspaceContext {
  env: TestEnvironment;
  workspaceId: string;
  collector: ReturnType<typeof createStreamCollector>;
}

/**
 * Run a test with a shared workspace for a specific provider.
 * Handles workspace creation, provider setup, and cleanup.
 *
 * @param provider - Provider name (e.g., "openai", "anthropic")
 * @param testFn - Test function to run with the workspace context
 */
export async function withSharedWorkspace(
  provider: string,
  testFn: (context: SharedWorkspaceContext) => Promise<void>
): Promise<void> {
  const env = getSharedEnv();
  const projectPath = getSharedRepoPath();

  // Generate unique branch name for this test
  const branchName = generateBranchName(`test-${provider}`);
  const trunkBranch = await detectDefaultTrunkBranch(projectPath);

  // Create workspace
  const result = await env.orpc.workspace.create({
    projectPath,
    branchName,
    trunkBranch,
  });

  if (!result.success) {
    throw new Error(`Failed to create workspace: ${result.error}`);
  }

  const workspaceId = result.metadata.id;

  // Setup provider with API key
  const apiKey = getApiKey(provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY");
  await setupProviders(env, {
    [provider]: { apiKey },
  });

  // Create stream collector
  const collector = createStreamCollector(env.orpc, workspaceId);
  collector.start();

  // Wait for subscription to be ready
  await collector.waitForSubscription();

  // Wait for init to complete (if there's an init hook)
  try {
    await collector.waitForEvent("init-end", INIT_HOOK_WAIT_MS);
  } catch {
    // Init hook might not exist - that's OK
  }

  try {
    await testFn({ env, workspaceId, collector });
  } finally {
    collector.stop();
    // Cleanup workspace
    await env.orpc.workspace.remove({ workspaceId });
  }
}

/**
 * Run a test with a workspace that has no provider configured.
 * Useful for testing API key errors.
 *
 * @param testFn - Test function to run with the workspace context
 */
export async function withSharedWorkspaceNoProvider(
  testFn: (context: SharedWorkspaceContext) => Promise<void>
): Promise<void> {
  const env = getSharedEnv();
  const projectPath = getSharedRepoPath();

  // Generate unique branch name
  const branchName = generateBranchName("test-no-provider");
  const trunkBranch = await detectDefaultTrunkBranch(projectPath);

  // Create workspace WITHOUT setting up any providers
  const result = await env.orpc.workspace.create({
    projectPath,
    branchName,
    trunkBranch,
  });

  if (!result.success) {
    throw new Error(`Failed to create workspace: ${result.error}`);
  }

  const workspaceId = result.metadata.id;

  // Set up event collector
  const collector = createStreamCollector(env.orpc, workspaceId);
  collector.start();

  // Wait for subscription to be ready
  await collector.waitForSubscription();

  try {
    await testFn({ env, workspaceId, collector });
  } finally {
    collector.stop();
    // Cleanup workspace
    await env.orpc.workspace.remove({ workspaceId });
  }
}

/**
 * Configure test retries for flaky integration tests.
 * Call in describe block to set retry count.
 */
export function configureTestRetries(count: number): void {
  jest.retryTimes(count, { logErrorsBeforeRetry: true });
}
