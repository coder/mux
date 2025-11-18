import type { IpcRenderer } from "electron";
import { IPC_CHANNELS, getChatChannel } from "../../src/common/constants/ipc-constants";
import type {
  ImagePart,
  SendMessageOptions,
  WorkspaceChatMessage,
  WorkspaceInitEvent,
} from "../../src/common/types/ipc";
import { isInitStart, isInitOutput, isInitEnd } from "../../src/common/types/ipc";
import type { Result } from "../../src/common/types/result";
import type { SendMessageError } from "../../src/common/types/errors";
import type { FrontendWorkspaceMetadata } from "../../src/common/types/workspace";
import * as path from "path";
import * as os from "os";
import { detectDefaultTrunkBranch } from "../../src/node/git";
import type { TestEnvironment } from "./setup";
import type { RuntimeConfig } from "../../src/common/types/runtime";
import { KNOWN_MODELS } from "../../src/common/constants/knownModels";
import type { ToolPolicy } from "../../src/common/utils/tools/toolPolicy";

// Test constants - centralized for consistency across all tests
export const INIT_HOOK_WAIT_MS = 1500; // Wait for async init hook completion (local runtime)
export const SSH_INIT_WAIT_MS = 7000; // SSH init includes sync + checkout + hook, takes longer
export const HAIKU_MODEL = "anthropic:claude-haiku-4-5"; // Fast model for tests
export const GPT_5_MINI_MODEL = "openai:gpt-5-mini"; // Fastest model for performance-critical tests
export const TEST_TIMEOUT_LOCAL_MS = 25000; // Recommended timeout for local runtime tests
export const TEST_TIMEOUT_SSH_MS = 60000; // Recommended timeout for SSH runtime tests
export const STREAM_TIMEOUT_LOCAL_MS = 15000; // Stream timeout for local runtime
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
  mockIpcRenderer: IpcRenderer,
  workspaceId: string,
  message: string,
  options?: SendMessageOptions & { imageParts?: ImagePart[] }
): Promise<Result<void, SendMessageError>> {
  return (await mockIpcRenderer.invoke(
    IPC_CHANNELS.WORKSPACE_SEND_MESSAGE,
    workspaceId,
    message,
    options
  )) as Result<void, SendMessageError>;
}

/**
 * Send a message with an explicit model id (defaults to SONNET).
 */
export async function sendMessageWithModel(
  mockIpcRenderer: IpcRenderer,
  workspaceId: string,
  message: string,
  modelId: string = DEFAULT_MODEL_ID,
  options?: SendMessageWithModelOptions
): Promise<Result<void, SendMessageError>> {
  const resolvedModel = modelId.includes(":") ? modelId : modelString(DEFAULT_PROVIDER, modelId);

  return sendMessage(mockIpcRenderer, workspaceId, message, {
    ...options,
    model: resolvedModel,
  });
}

/**
 * Create a workspace via IPC
 */
export async function createWorkspace(
  mockIpcRenderer: IpcRenderer,
  projectPath: string,
  branchName: string,
  trunkBranch?: string,
  runtimeConfig?: import("../../src/common/types/runtime").RuntimeConfig
): Promise<
  { success: true; metadata: FrontendWorkspaceMetadata } | { success: false; error: string }
> {
  const resolvedTrunk =
    typeof trunkBranch === "string" && trunkBranch.trim().length > 0
      ? trunkBranch.trim()
      : await detectDefaultTrunkBranch(projectPath);

  return (await mockIpcRenderer.invoke(
    IPC_CHANNELS.WORKSPACE_CREATE,
    projectPath,
    branchName,
    resolvedTrunk,
    runtimeConfig
  )) as { success: true; metadata: FrontendWorkspaceMetadata } | { success: false; error: string };
}

/**
 * Clear workspace history via IPC
 */
export async function clearHistory(
  mockIpcRenderer: IpcRenderer,
  workspaceId: string
): Promise<Result<void, string>> {
  return (await mockIpcRenderer.invoke(
    IPC_CHANNELS.WORKSPACE_TRUNCATE_HISTORY,
    workspaceId
  )) as Result<void, string>;
}

/**
 * Extract text content from stream events
 * Filters for stream-delta events and concatenates the delta text
 */
export function extractTextFromEvents(events: WorkspaceChatMessage[]): string {
  return events
    .filter((e: any) => e.type === "stream-delta" && "delta" in e)
    .map((e: any) => e.delta || "")
    .join("");
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

  const result: any = await env.mockIpcRenderer.invoke(
    IPC_CHANNELS.WORKSPACE_CREATE,
    projectPath,
    branchName,
    trunkBranch,
    runtimeConfig
  );

  if (!result.success) {
    throw new Error(`Failed to create workspace: ${result.error}`);
  }

  const workspaceId = result.metadata.id;
  const workspacePath = result.metadata.namedWorkspacePath;

  // Wait for init hook to complete if requested
  if (waitForInit) {
    const initTimeout = isSSH ? SSH_INIT_WAIT_MS : INIT_HOOK_WAIT_MS;
    const collector = createEventCollector(env.sentEvents, workspaceId);
    try {
      await collector.waitForEvent("init-end", initTimeout);
    } catch (err) {
      // Init hook might not exist or might have already completed before we started waiting
      // This is not necessarily an error - just log it
      console.log(
        `Note: init-end event not detected within ${initTimeout}ms (may have completed early)`
      );
    }
  }

  const cleanup = async () => {
    await env.mockIpcRenderer.invoke(IPC_CHANNELS.WORKSPACE_REMOVE, workspaceId);
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
  // Clear previous events
  env.sentEvents.length = 0;

  // Send message
  const result = await env.mockIpcRenderer.invoke(
    IPC_CHANNELS.WORKSPACE_SEND_MESSAGE,
    workspaceId,
    message,
    {
      model,
      toolPolicy,
      thinkingLevel: "off", // Disable reasoning for fast test execution
      mode: "exec", // Execute commands directly, don't propose plans
    }
  );

  if (!result.success) {
    throw new Error(`Failed to send message: ${JSON.stringify(result, null, 2)}`);
  }

  // Wait for stream completion
  const collector = createEventCollector(env.sentEvents, workspaceId);
  await collector.waitForEvent("stream-end", timeoutMs);
  return collector.getEvents();
}

/**
 * Event collector for capturing stream events
 */
export class EventCollector {
  private events: WorkspaceChatMessage[] = [];
  private sentEvents: Array<{ channel: string; data: unknown }>;
  private workspaceId: string;
  private chatChannel: string;

  constructor(sentEvents: Array<{ channel: string; data: unknown }>, workspaceId: string) {
    this.sentEvents = sentEvents;
    this.workspaceId = workspaceId;
    this.chatChannel = getChatChannel(workspaceId);
  }

  /**
   * Collect all events for this workspace from the sent events array
   */
  collect(): WorkspaceChatMessage[] {
    this.events = this.sentEvents
      .filter((e) => e.channel === this.chatChannel)
      .map((e) => e.data as WorkspaceChatMessage);
    return this.events;
  }

  /**
   * Get the collected events
   */
  getEvents(): WorkspaceChatMessage[] {
    return this.events;
  }

  /**
   * Wait for a specific event type with exponential backoff
   */
  async waitForEvent(eventType: string, timeoutMs = 30000): Promise<WorkspaceChatMessage | null> {
    const startTime = Date.now();
    let pollInterval = 50; // Start with 50ms for faster detection

    while (Date.now() - startTime < timeoutMs) {
      this.collect();
      const event = this.events.find((e) => "type" in e && e.type === eventType);
      if (event) {
        return event;
      }
      // Exponential backoff with max 500ms
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
      pollInterval = Math.min(pollInterval * 1.5, 500);
    }

    // Timeout - log detailed diagnostic info
    this.logEventDiagnostics(`waitForEvent timeout: Expected "${eventType}"`);

    return null;
  }

  /**
   * Log detailed event diagnostics for debugging
   * Includes timestamps, event types, tool calls, and error details
   */
  logEventDiagnostics(context: string): void {
    console.error(`\n${"=".repeat(80)}`);
    console.error(`EVENT DIAGNOSTICS: ${context}`);
    console.error(`${"=".repeat(80)}`);
    console.error(`Workspace: ${this.workspaceId}`);
    console.error(`Total events: ${this.events.length}`);
    console.error(`\nEvent sequence:`);

    // Log all events with details
    this.events.forEach((event, idx) => {
      const timestamp =
        "timestamp" in event ? new Date(event.timestamp as number).toISOString() : "no-ts";
      const type = "type" in event ? (event as { type: string }).type : "no-type";

      console.error(`  [${idx}] ${timestamp} - ${type}`);

      // Log tool call details
      if (type === "tool-call-start" && "toolName" in event) {
        console.error(`      Tool: ${event.toolName}`);
        if ("args" in event) {
          console.error(`      Args: ${JSON.stringify(event.args)}`);
        }
      }

      if (type === "tool-call-end" && "toolName" in event) {
        console.error(`      Tool: ${event.toolName}`);
        if ("result" in event) {
          const result =
            typeof event.result === "string"
              ? event.result.length > 100
                ? `${event.result.substring(0, 100)}... (${event.result.length} chars)`
                : event.result
              : JSON.stringify(event.result);
          console.error(`      Result: ${result}`);
        }
      }

      // Log error details
      if (type === "stream-error") {
        if ("error" in event) {
          console.error(`      Error: ${event.error}`);
        }
        if ("errorType" in event) {
          console.error(`      Error Type: ${event.errorType}`);
        }
      }

      // Log delta content (first 100 chars)
      if (type === "stream-delta" && "delta" in event) {
        const delta =
          typeof event.delta === "string"
            ? event.delta.length > 100
              ? `${event.delta.substring(0, 100)}...`
              : event.delta
            : JSON.stringify(event.delta);
        console.error(`      Delta: ${delta}`);
      }

      // Log final content (first 200 chars)
      if (type === "stream-end" && "content" in event) {
        const content =
          typeof event.content === "string"
            ? event.content.length > 200
              ? `${event.content.substring(0, 200)}... (${event.content.length} chars)`
              : event.content
            : JSON.stringify(event.content);
        console.error(`      Content: ${content}`);
      }
    });

    // Summary
    const eventTypeCounts = this.events.reduce(
      (acc, e) => {
        const type = "type" in e ? (e as { type: string }).type : "unknown";
        acc[type] = (acc[type] || 0) + 1;
        return acc;
      },
      {} as Record<string, number>
    );

    console.error(`\nEvent type counts:`);
    Object.entries(eventTypeCounts).forEach(([type, count]) => {
      console.error(`  ${type}: ${count}`);
    });

    console.error(`${"=".repeat(80)}\n`);
  }

  /**
   * Check if stream completed successfully
   */
  hasStreamEnd(): boolean {
    return this.events.some((e) => "type" in e && e.type === "stream-end");
  }

  /**
   * Check if stream had an error
   */
  hasError(): boolean {
    return this.events.some((e) => "type" in e && e.type === "stream-error");
  }

  /**
   * Get all stream-delta events
   */
  getDeltas(): WorkspaceChatMessage[] {
    return this.events.filter((e) => "type" in e && e.type === "stream-delta");
  }

  /**
   * Get the final assistant message (from stream-end)
   */
  getFinalMessage(): WorkspaceChatMessage | undefined {
    return this.events.find((e) => "type" in e && e.type === "stream-end");
  }
}

/**
 * Create an event collector for a workspace
 */
export function createEventCollector(
  sentEvents: Array<{ channel: string; data: unknown }>,
  workspaceId: string
): EventCollector {
  return new EventCollector(sentEvents, workspaceId);
}

/**
 * Assert that a stream completed successfully
 * Provides helpful error messages when assertions fail
 */
export function assertStreamSuccess(collector: EventCollector): void {
  const allEvents = collector.getEvents();

  // Check for stream-end
  if (!collector.hasStreamEnd()) {
    const errorEvent = allEvents.find((e) => "type" in e && e.type === "stream-error");
    if (errorEvent && "error" in errorEvent) {
      collector.logEventDiagnostics(
        `Stream did not complete successfully. Got stream-error: ${errorEvent.error}`
      );
      throw new Error(
        `Stream did not complete successfully. Got stream-error: ${errorEvent.error}\n` +
          `See detailed event diagnostics above.`
      );
    }
    collector.logEventDiagnostics("Stream did not emit stream-end event");
    throw new Error(
      `Stream did not emit stream-end event.\n` + `See detailed event diagnostics above.`
    );
  }

  // Check for errors
  if (collector.hasError()) {
    const errorEvent = allEvents.find((e) => "type" in e && e.type === "stream-error");
    const errorMsg = errorEvent && "error" in errorEvent ? errorEvent.error : "unknown";
    collector.logEventDiagnostics(`Stream completed but also has error event: ${errorMsg}`);
    throw new Error(
      `Stream completed but also has error event: ${errorMsg}\n` +
        `See detailed event diagnostics above.`
    );
  }

  // Check for final message
  const finalMessage = collector.getFinalMessage();
  if (!finalMessage) {
    collector.logEventDiagnostics("Stream completed but final message is missing");
    throw new Error(
      `Stream completed but final message is missing.\n` + `See detailed event diagnostics above.`
    );
  }
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
  const fs = await import("fs/promises");
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
 * Wait for init hook to complete by watching for init-end event
 * More reliable than static sleeps
 * Based on workspaceInitHook.test.ts pattern
 */
export async function waitForInitComplete(
  env: import("./setup").TestEnvironment,
  workspaceId: string,
  timeoutMs = 5000
): Promise<void> {
  const startTime = Date.now();
  let pollInterval = 50;

  while (Date.now() - startTime < timeoutMs) {
    // Check for init-end event in sentEvents
    const initEndEvent = env.sentEvents.find(
      (e) =>
        e.channel === getChatChannel(workspaceId) &&
        typeof e.data === "object" &&
        e.data !== null &&
        "type" in e.data &&
        e.data.type === "init-end"
    );

    if (initEndEvent) {
      // Check if init succeeded (exitCode === 0)
      const exitCode = (initEndEvent.data as any).exitCode;
      if (exitCode !== 0) {
        // Collect all init output for debugging
        const initOutputEvents = env.sentEvents.filter(
          (e) =>
            e.channel === getChatChannel(workspaceId) &&
            typeof e.data === "object" &&
            e.data !== null &&
            "type" in e.data &&
            (e.data as any).type === "init-output"
        );
        const output = initOutputEvents
          .map((e) => (e.data as any).line)
          .filter(Boolean)
          .join("\n");
        throw new Error(`Init hook failed with exit code ${exitCode}:\n${output}`);
      }
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, pollInterval));
    pollInterval = Math.min(pollInterval * 1.5, 500);
  }

  // Throw error on timeout - workspace creation must complete for tests to be valid
  throw new Error(`Init did not complete within ${timeoutMs}ms - workspace may not be ready`);
}

/**
 * Collect all init events for a workspace.
 * Filters sentEvents for init-start, init-output, and init-end events.
 * Returns the events in chronological order.
 */
export function collectInitEvents(
  env: import("./setup").TestEnvironment,
  workspaceId: string
): WorkspaceInitEvent[] {
  return env.sentEvents
    .filter((e) => e.channel === getChatChannel(workspaceId))
    .map((e) => e.data as WorkspaceChatMessage)
    .filter(
      (msg) => isInitStart(msg) || isInitOutput(msg) || isInitEnd(msg)
    ) as WorkspaceInitEvent[];
}

/**
 * Wait for init-end event without checking exit code.
 * Use this when you want to test failure cases or inspect the exit code yourself.
 * For success-only tests, use waitForInitComplete() which throws on failure.
 */
export async function waitForInitEnd(
  env: import("./setup").TestEnvironment,
  workspaceId: string,
  timeoutMs = 5000
): Promise<void> {
  const startTime = Date.now();
  let pollInterval = 50;

  while (Date.now() - startTime < timeoutMs) {
    // Check for init-end event in sentEvents
    const initEndEvent = env.sentEvents.find(
      (e) =>
        e.channel === getChatChannel(workspaceId) &&
        typeof e.data === "object" &&
        e.data !== null &&
        "type" in e.data &&
        e.data.type === "init-end"
    );

    if (initEndEvent) {
      return; // Found end event, regardless of exit code
    }

    await new Promise((resolve) => setTimeout(resolve, pollInterval));
    pollInterval = Math.min(pollInterval * 1.5, 500);
  }

  // Throw error on timeout
  throw new Error(`Init did not complete within ${timeoutMs}ms`);
}

/**
 * Wait for stream to complete successfully
 * Common pattern: create collector, wait for end, assert success
 */
export async function waitForStreamSuccess(
  sentEvents: Array<{ channel: string; data: unknown }>,
  workspaceId: string,
  timeoutMs = 30000
): Promise<EventCollector> {
  const collector = createEventCollector(sentEvents, workspaceId);
  await collector.waitForEvent("stream-end", timeoutMs);
  assertStreamSuccess(collector);
  return collector;
}

/**
 * Read and parse chat history from disk
 */
export async function readChatHistory(
  tempDir: string,
  workspaceId: string
): Promise<Array<{ role: string; parts: Array<{ type: string; [key: string]: unknown }> }>> {
  const fsPromises = await import("fs/promises");
  const historyPath = path.join(tempDir, "sessions", workspaceId, "chat.jsonl");
  const historyContent = await fsPromises.readFile(historyPath, "utf-8");
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
  const fs = await import("fs/promises");
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
  const fs = await import("fs/promises");
  const { exec } = await import("child_process");
  const { promisify } = await import("util");
  // eslint-disable-next-line local/no-unsafe-child-process
  const execAsync = promisify(exec);

  // Use mkdtemp to avoid race conditions and ensure unique directory
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-test-repo-"));

  // Use promisify(exec) for test setup - DisposableExec has issues in CI
  // TODO: Investigate why DisposableExec causes empty git output in CI
  await execAsync(`git init`, { cwd: tempDir });
  await execAsync(`git config user.email "test@example.com" && git config user.name "Test User"`, {
    cwd: tempDir,
  });
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
  const { exec } = await import("child_process");
  const { promisify } = await import("util");
  const execAsync = promisify(exec);

  await execAsync(`git submodule add "${submoduleUrl}" "${submoduleName}"`, { cwd: repoPath });
  await execAsync(`git commit -m "Add submodule ${submoduleName}"`, { cwd: repoPath });
}

/**
 * Cleanup temporary git repository with retry logic
 */
export async function cleanupTempGitRepo(repoPath: string): Promise<void> {
  const fs = await import("fs/promises");
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
  const { HistoryService } = await import("../../src/node/services/historyService");
  const { createMuxMessage } = await import("../../src/common/types/message");

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
