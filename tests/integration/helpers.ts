import type { IpcRenderer } from "electron";
import type {
  ImagePart,
  SendMessageOptions,
  WorkspaceChatMessage,
  WorkspaceInitEvent,
} from "@/common/orpc/types";
import { isInitStart, isInitOutput, isInitEnd } from "@/common/orpc/types";

// Re-export StreamCollector utilities for backwards compatibility
export {
  StreamCollector,
  createStreamCollector,
  assertStreamSuccess,
  withStreamCollection,
  waitForStreamSuccess,
  extractTextFromEvents,
} from "./streamCollector";
import { createStreamCollector } from "./streamCollector";
import type { Result } from "../../src/common/types/result";
import type { SendMessageError } from "../../src/common/types/errors";
import type { FrontendWorkspaceMetadata } from "../../src/common/types/workspace";
import * as path from "path";
import * as os from "os";
import * as fs from "fs/promises";
import { exec } from "child_process";
import { promisify } from "util";
import { detectDefaultTrunkBranch } from "../../src/node/git";
import type { TestEnvironment } from "./setup";
import type { RuntimeConfig } from "../../src/common/types/runtime";
import type { OrpcTestClient } from "./orpcTestClient";
import { KNOWN_MODELS } from "../../src/common/constants/knownModels";
import type { ToolPolicy } from "../../src/common/utils/tools/toolPolicy";
import type { WorkspaceSendMessageOutput } from "@/common/orpc/schemas";
import { HistoryService } from "../../src/node/services/historyService";
import { createMuxMessage } from "../../src/common/types/message";

const execAsync = promisify(exec);
import { ORPCError } from "@orpc/client";
import { ValidationError } from "@orpc/server";

// Test constants - centralized for consistency across all tests
export const INIT_HOOK_WAIT_MS = 1500; // Wait for async init hook completion (local runtime)
export const SSH_INIT_WAIT_MS = 7000; // SSH init includes sync + checkout + hook, takes longer
export const HAIKU_MODEL = "anthropic:claude-haiku-4-5"; // Fast model for tests
export const GPT_5_MINI_MODEL = "openai:gpt-5-mini"; // Fastest model for performance-critical tests
export const TEST_TIMEOUT_LOCAL_MS = 25000; // Recommended timeout for local runtime tests
export const TEST_TIMEOUT_SSH_MS = 60000; // Recommended timeout for SSH runtime tests
export const STREAM_TIMEOUT_LOCAL_MS = 15000; // Stream timeout for local runtime

export type OrpcSource =
  | TestEnvironment
  | OrpcTestClient
  | (IpcRenderer & { __orpc?: OrpcTestClient });

export function resolveOrpcClient(source: OrpcSource): OrpcTestClient {
  if ("orpc" in source) {
    return source.orpc;
  }

  if ("workspace" in source) {
    return source;
  }

  if ("__orpc" in source && source.__orpc) {
    return source.__orpc;
  }

  throw new Error(
    "ORPC client unavailable. Pass TestEnvironment or OrpcTestClient to test helpers instead of mockIpcRenderer."
  );
}
export const STREAM_TIMEOUT_SSH_MS = 25000; // Stream timeout for SSH runtime

/**
 * Generate a unique branch name
 * Uses high-resolution time (nanosecond precision) to prevent collisions
 */
export function generateBranchName(prefix = "test"): string {
  const hrTime = process.hrtime.bigint();
  const random = Math.random().toString(36).substring(2, 10);
  return `${prefix}-${hrTime}-${random}`;
}

/**
 * Create a full model string from provider and model name
 */
export function modelString(provider: string, model: string): string {
  return `${provider}:${model}`;
}

/**
 * Send a message via IPC
 */
type SendMessageWithModelOptions = Omit<SendMessageOptions, "model"> & {
  imageParts?: Array<{ url: string; mediaType: string }>;
};

const DEFAULT_MODEL_ID = KNOWN_MODELS.SONNET.id;
const DEFAULT_PROVIDER = KNOWN_MODELS.SONNET.provider;

export async function sendMessage(
  source: OrpcSource,
  workspaceId: string,
  message: string,
  options?: SendMessageOptions & { imageParts?: ImagePart[] }
): Promise<Result<void, SendMessageError>> {
  const client = resolveOrpcClient(source);

  let result: WorkspaceSendMessageOutput;
  try {
    result = await client.workspace.sendMessage({ workspaceId, message, options });
  } catch (error) {
    // Normalize ORPC input validation or transport errors into Result shape expected by tests.
    let raw: string = "";

    if (
      error instanceof ORPCError &&
      error.code === "BAD_REQUEST" &&
      error.cause instanceof ValidationError
    ) {
      raw = error.cause.issues.map((iss) => iss.message).join();
    } else {
      raw =
        error instanceof Error
          ? error.message || error.toString()
          : typeof error === "string"
            ? error
            : JSON.stringify(error);
    }

    return { success: false, error: { type: "unknown", raw } };
  }

  // Normalize to Result<void> for callers - they just care about success/failure
  if (result.success) {
    return { success: true, data: undefined };
  }

  return { success: false, error: result.error };
}

/**
 * Send a message with an explicit model id (defaults to SONNET).
 */
export async function sendMessageWithModel(
  source: OrpcSource,
  workspaceId: string,
  message: string,
  modelId: string = DEFAULT_MODEL_ID,
  options?: SendMessageWithModelOptions
): Promise<Result<void, SendMessageError>> {
  const resolvedModel = modelId.includes(":") ? modelId : modelString(DEFAULT_PROVIDER, modelId);

  return sendMessage(source, workspaceId, message, {
    ...options,
    model: resolvedModel,
  });
}

/**
 * Create a workspace via IPC
 */
export async function createWorkspace(
  source: OrpcSource,
  projectPath: string,
  branchName: string,
  trunkBranch?: string,
  runtimeConfig?: RuntimeConfig
): Promise<
  { success: true; metadata: FrontendWorkspaceMetadata } | { success: false; error: string }
> {
  const resolvedTrunk =
    typeof trunkBranch === "string" && trunkBranch.trim().length > 0
      ? trunkBranch.trim()
      : await detectDefaultTrunkBranch(projectPath);

  const client = resolveOrpcClient(source);
  return client.workspace.create({
    projectPath,
    branchName,
    trunkBranch: resolvedTrunk,
    runtimeConfig,
  });
}

/**
 * Clear workspace history via IPC
 */
export async function clearHistory(
  source: OrpcSource,
  workspaceId: string,
  percentage?: number
): Promise<Result<void, string>> {
  const client = resolveOrpcClient(source);
  return (await client.workspace.truncateHistory({ workspaceId, percentage })) as Result<
    void,
    string
  >;
}

/**
 * Create workspace with optional init hook wait
 * Enhanced version that can wait for init hook completion (needed for runtime tests)
 */
export async function createWorkspaceWithInit(
  env: TestEnvironment,
  projectPath: string,
  branchName: string,
  runtimeConfig?: RuntimeConfig,
  waitForInit: boolean = false,
  isSSH: boolean = false
): Promise<{ workspaceId: string; workspacePath: string; cleanup: () => Promise<void> }> {
  const trunkBranch = await detectDefaultTrunkBranch(projectPath);

  const result = await env.orpc.workspace.create({
    projectPath,
    branchName,
    trunkBranch,
    runtimeConfig,
  });

  if (!result.success) {
    throw new Error(`Failed to create workspace: ${result.error}`);
  }

  const workspaceId = result.metadata.id;
  const workspacePath = result.metadata.namedWorkspacePath;

  // Wait for init hook to complete if requested
  if (waitForInit) {
    const initTimeout = isSSH ? SSH_INIT_WAIT_MS : INIT_HOOK_WAIT_MS;

    const collector = createStreamCollector(env.orpc, workspaceId);
    collector.start();
    try {
      await collector.waitForEvent("init-end", initTimeout);
    } catch (err) {
      // Init hook might not exist or might have already completed before we started waiting
      // This is not necessarily an error - just log it
      console.log(
        `Note: init-end event not detected within ${initTimeout}ms (may have completed early)`
      );
    } finally {
      collector.stop();
    }
  }

  const cleanup = async () => {
    await env.orpc.workspace.remove({ workspaceId });
  };

  return { workspaceId, workspacePath, cleanup };
}

/**
 * Send message and wait for stream completion
 * Convenience helper that combines message sending with event collection
 */
export async function sendMessageAndWait(
  env: TestEnvironment,
  workspaceId: string,
  message: string,
  model: string,
  toolPolicy?: ToolPolicy,
  timeoutMs: number = STREAM_TIMEOUT_LOCAL_MS
): Promise<WorkspaceChatMessage[]> {
  const collector = createStreamCollector(env.orpc, workspaceId);
  collector.start();

  try {
    // Wait for subscription to be established before sending message
    // This prevents race conditions where events are emitted before collector is ready
    // The subscription is ready once we receive the first event (history replay)
    await collector.waitForSubscription();

    // Additional small delay to ensure the generator loop is stable
    // This helps with concurrent test execution where system load causes timing issues
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Send message
    const result = await env.orpc.workspace.sendMessage({
      workspaceId,
      message,
      options: {
        model,
        toolPolicy,
        thinkingLevel: "off", // Disable reasoning for fast test execution
        mode: "exec", // Execute commands directly, don't propose plans
      },
    });

    if (!result.success) {
      throw new Error(`Failed to send message: ${JSON.stringify(result, null, 2)}`);
    }

    // Wait for stream completion
    await collector.waitForEvent("stream-end", timeoutMs);
    return collector.getEvents();
  } finally {
    collector.stop();
  }
}

// Re-export StreamCollector for use as EventCollector (API compatible)
export { StreamCollector as EventCollector } from "./streamCollector";

/**
 * Create an event collector for a workspace.
 *
 * MIGRATION NOTE: Tests should migrate to using StreamCollector directly:
 *   const collector = createStreamCollector(env.orpc, workspaceId);
 *   collector.start();
 *   ... test code ...
 *   collector.stop();
 *
 * This function exists for backwards compatibility during migration.
 * It detects whether the first argument is an ORPC client or sentEvents array.
 */
export function createEventCollector(
  firstArg: OrpcTestClient | Array<{ channel: string; data: unknown }>,
  workspaceId: string
) {
  const { createStreamCollector } = require("./streamCollector");

  // Check if firstArg is an OrpcTestClient (has workspace.onChat method)
  if (firstArg && typeof firstArg === "object" && "workspace" in firstArg) {
    return createStreamCollector(firstArg as OrpcTestClient, workspaceId);
  }

  // Legacy signature - throw helpful error directing to new pattern
  throw new Error(
    `createEventCollector(sentEvents, workspaceId) is deprecated.\n` +
      `Use the new pattern:\n` +
      `  const collector = createStreamCollector(env.orpc, workspaceId);\n` +
      `  collector.start();\n` +
      `  ... test code ...\n` +
      `  collector.stop();`
  );
}

/**
 * Assert that a result has a specific error type
 */
export function assertError(
  result: Result<void, SendMessageError>,
  expectedErrorType: string
): void {
  expect(result.success).toBe(false);
  if (!result.success) {
    expect(result.error.type).toBe(expectedErrorType);
  }
}

/**
 * Poll for a condition with exponential backoff
 * More robust than fixed sleeps for async operations
 */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
  pollIntervalMs = 50
): Promise<boolean> {
  const startTime = Date.now();
  let currentInterval = pollIntervalMs;

  while (Date.now() - startTime < timeoutMs) {
    if (await condition()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, currentInterval));
    // Exponential backoff with max 500ms
    currentInterval = Math.min(currentInterval * 1.5, 500);
  }

  return false;
}

/**
 * Wait for a file to exist with retry logic
 * Useful for checking file operations that may take time
 */
export async function waitForFileExists(filePath: string, timeoutMs = 5000): Promise<boolean> {
  return waitFor(async () => {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }, timeoutMs);
}

/**
 * Wait for init hook to complete by watching for init-end event.
 * Uses ORPC subscription via StreamCollector.
 */
/**
 * Wait for init to complete successfully (exitCode === 0).
 * Throws if init fails or times out.
 * Returns collected init events for inspection.
 */
export async function waitForInitComplete(
  env: import("./setup").TestEnvironment,
  workspaceId: string,
  timeoutMs = 5000
): Promise<WorkspaceInitEvent[]> {
  const collector = createStreamCollector(env.orpc, workspaceId);
  collector.start();

  try {
    const initEndEvent = await collector.waitForEvent("init-end", timeoutMs);
    if (!initEndEvent) {
      throw new Error(`Init did not complete within ${timeoutMs}ms - workspace may not be ready`);
    }

    const initEvents = collector
      .getEvents()
      .filter(
        (msg) => isInitStart(msg) || isInitOutput(msg) || isInitEnd(msg)
      ) as WorkspaceInitEvent[];

    // Check if init succeeded (exitCode === 0)
    const exitCode = (initEndEvent as { exitCode?: number }).exitCode;
    if (exitCode !== undefined && exitCode !== 0) {
      // Collect all init output for debugging
      const initOutputEvents = initEvents.filter((e) => isInitOutput(e));
      const output = initOutputEvents
        .map((e) => (e as { line?: string }).line)
        .filter(Boolean)
        .join("\n");
      throw new Error(`Init hook failed with exit code ${exitCode}:\n${output}`);
    }

    return initEvents;
  } finally {
    collector.stop();
  }
}

/**
 * Collect all init events for a workspace (alias for waitForInitComplete).
 * Uses ORPC subscription via StreamCollector.
 * Note: This starts a collector, waits for init-end, then returns init events.
 */
export async function collectInitEvents(
  env: import("./setup").TestEnvironment,
  workspaceId: string,
  timeoutMs = 5000
): Promise<WorkspaceInitEvent[]> {
  return waitForInitComplete(env, workspaceId, timeoutMs);
}

/**
 * Wait for init-end event without checking exit code.
 * Use this when you want to test failure cases or inspect the exit code yourself.
 * Returns collected init events for inspection.
 */
export async function waitForInitEnd(
  env: import("./setup").TestEnvironment,
  workspaceId: string,
  timeoutMs = 5000
): Promise<WorkspaceInitEvent[]> {
  const collector = createStreamCollector(env.orpc, workspaceId);
  collector.start();

  try {
    const event = await collector.waitForEvent("init-end", timeoutMs);
    if (!event) {
      throw new Error(`Init did not complete within ${timeoutMs}ms`);
    }
    return collector
      .getEvents()
      .filter(
        (msg) => isInitStart(msg) || isInitOutput(msg) || isInitEnd(msg)
      ) as WorkspaceInitEvent[];
  } finally {
    collector.stop();
  }
}

/**
 * Read and parse chat history from disk
 */
export async function readChatHistory(
  tempDir: string,
  workspaceId: string
): Promise<Array<{ role: string; parts: Array<{ type: string; [key: string]: unknown }> }>> {
  const historyPath = path.join(tempDir, "sessions", workspaceId, "chat.jsonl");
  const historyContent = await fs.readFile(historyPath, "utf-8");
  return historyContent
    .trim()
    .split("\n")
    .map((line: string) => JSON.parse(line));
}

/**
 * Test image fixtures (1x1 pixel PNGs)
 */
export const TEST_IMAGES: Record<string, ImagePart> = {
  RED_PIXEL: {
    url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
    mediaType: "image/png",
  },
  BLUE_PIXEL: {
    url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEBgIApD5fRAAAAABJRU5ErkJggg==",
    mediaType: "image/png",
  },
};

/**
 * Wait for a file to NOT exist with retry logic
 */
export async function waitForFileNotExists(filePath: string, timeoutMs = 5000): Promise<boolean> {
  return waitFor(async () => {
    try {
      await fs.access(filePath);
      return false;
    } catch {
      return true;
    }
  }, timeoutMs);
}

/**
 * Create a temporary git repository for testing
 */
export async function createTempGitRepo(): Promise<string> {
  // eslint-disable-next-line local/no-unsafe-child-process

  // Use mkdtemp to avoid race conditions and ensure unique directory
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-test-repo-"));

  // Use promisify(exec) for test setup - DisposableExec has issues in CI
  // TODO: Investigate why DisposableExec causes empty git output in CI
  await execAsync(`git init`, { cwd: tempDir });
  // Disable GPG signing for test commits - avoids issues with 1Password SSH agent
  await execAsync(
    `git config user.email "test@example.com" && git config user.name "Test User" && git config commit.gpgsign false`,
    { cwd: tempDir }
  );
  await execAsync(
    `echo "test" > README.md && git add . && git commit -m "Initial commit" && git branch test-branch`,
    { cwd: tempDir }
  );

  return tempDir;
}

/**
 * Add a git submodule to a repository
 * @param repoPath - Path to the repository to add the submodule to
 * @param submoduleUrl - URL of the submodule repository (defaults to leftpad)
 * @param submoduleName - Name/path for the submodule
 */
export async function addSubmodule(
  repoPath: string,
  submoduleUrl: string = "https://github.com/left-pad/left-pad.git",
  submoduleName: string = "vendor/left-pad"
): Promise<void> {
  await execAsync(`git submodule add "${submoduleUrl}" "${submoduleName}"`, { cwd: repoPath });
  // Use -c to ensure no GPG signing in case repo config doesn't have it set
  await execAsync(`git -c commit.gpgsign=false commit -m "Add submodule ${submoduleName}"`, {
    cwd: repoPath,
  });
}

/**
 * Cleanup temporary git repository with retry logic
 */
export async function cleanupTempGitRepo(repoPath: string): Promise<void> {
  const maxRetries = 3;
  let lastError: unknown;

  for (let i = 0; i < maxRetries; i++) {
    try {
      await fs.rm(repoPath, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      // Wait before retry (files might be locked temporarily)
      if (i < maxRetries - 1) {
        await new Promise((resolve) => setTimeout(resolve, 100 * (i + 1)));
      }
    }
  }
  console.warn(`Failed to cleanup temp git repo after ${maxRetries} attempts:`, lastError);
}

/**
 * Build large conversation history to test context limits
 *
 * This is a test-only utility that uses HistoryService directly to quickly
 * populate history without making API calls. Real application code should
 * NEVER bypass IPC like this.
 *
 * @param workspaceId - Workspace to populate
 * @param config - Config instance for HistoryService
 * @param options - Configuration for history size
 * @returns Promise that resolves when history is built
 */
export async function buildLargeHistory(
  workspaceId: string,
  config: { getSessionDir: (id: string) => string },
  options: {
    messageSize?: number;
    messageCount?: number;
    textPrefix?: string;
  } = {}
): Promise<void> {
  // HistoryService only needs getSessionDir, so we can cast the partial config
  const historyService = new HistoryService(config as any);

  const messageSize = options.messageSize ?? 50_000;
  const messageCount = options.messageCount ?? 80;
  const textPrefix = options.textPrefix ?? "";

  const largeText = textPrefix + "A".repeat(messageSize);

  // Build conversation history with alternating user/assistant messages
  for (let i = 0; i < messageCount; i++) {
    const isUser = i % 2 === 0;
    const role = isUser ? "user" : "assistant";
    const message = createMuxMessage(`history-msg-${i}`, role, largeText, {});

    const result = await historyService.appendToHistory(workspaceId, message);
    if (!result.success) {
      throw new Error(`Failed to append message ${i} to history: ${result.error}`);
    }
  }
}
