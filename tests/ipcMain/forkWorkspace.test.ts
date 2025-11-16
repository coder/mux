/**
 * Integration tests for WORKSPACE_FORK IPC handler
 *
 * Tests both LocalRuntime and SSHRuntime without mocking to verify:
 * - Fork mechanics (directory copy, branch creation)
 * - Preserving uncommitted changes and git state
 * - Init hook execution
 * - Parity between runtime implementations
 *
 * Uses real IPC handlers, real git operations, and Docker SSH server.
 */

import * as fs from "fs/promises";
import * as path from "path";
import { exec } from "child_process";
import { promisify } from "util";
import {
  shouldRunIntegrationTests,
  createTestEnvironment,
  cleanupTestEnvironment,
  setupWorkspace,
  validateApiKeys,
} from "./setup";
import type { TestEnvironment } from "./setup";
import {
  IPC_CHANNELS,
  EVENT_TYPE_PREFIX_INIT,
  EVENT_TYPE_INIT_OUTPUT,
  EVENT_TYPE_INIT_END,
} from "../../src/common/constants/ipc-constants";
import {
  createTempGitRepo,
  cleanupTempGitRepo,
  sendMessage,
  createEventCollector,
  assertStreamSuccess,
  generateBranchName,
  DEFAULT_TEST_MODEL,
} from "./helpers";
import { detectDefaultTrunkBranch } from "../../src/node/git";
import { HistoryService } from "../../src/node/services/historyService";
import { createMuxMessage } from "../../src/common/types/message";
import {
  isDockerAvailable,
  startSSHServer,
  stopSSHServer,
  type SSHServerConfig,
} from "../runtime/ssh-fixture";
import type { RuntimeConfig } from "../../src/common/types/runtime";
import { createRuntime } from "../../src/node/runtime/runtimeFactory";
import { streamToString } from "../../src/node/runtime/SSHRuntime";
import { CMUX_DIR, INIT_HOOK_FILENAME } from "../../src/node/runtime/initHook";

const execAsync = promisify(exec);

// Test constants
const TEST_TIMEOUT_MS = 90000;
const INIT_HOOK_WAIT_MS = 1500; // Wait for async init hook completion (local runtime)
const SSH_INIT_WAIT_MS = 7000; // SSH init takes longer

// Skip all tests if TEST_INTEGRATION is not set
const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

// SSH server config (shared across all SSH tests)
let sshConfig: SSHServerConfig | undefined;

// Validate API keys for tests that need them
if (shouldRunIntegrationTests()) {
  validateApiKeys(["ANTHROPIC_API_KEY"]);
}

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Type guard to check if an event is an init event with a type field
 */
function isInitEvent(data: unknown): data is { type: string } {
  return (
    data !== null &&
    typeof data === "object" &&
    "type" in data &&
    typeof (data as { type: unknown }).type === "string" &&
    (data as { type: string }).type.startsWith(EVENT_TYPE_PREFIX_INIT)
  );
}

/**
 * Filter events by type
 */
function filterEventsByType(
  events: Array<{ channel: string; data: unknown }>,
  eventType: string
): Array<{ channel: string; data: { type: string } }> {
  return events.filter((e) => isInitEvent(e.data) && e.data.type === eventType) as Array<{
    channel: string;
    data: { type: string };
  }>;
}

/**
 * Set up event capture for init events on workspace chat channel
 * Returns array that will be populated with captured events
 */
function setupInitEventCapture(env: TestEnvironment): Array<{ channel: string; data: unknown }> {
  const capturedEvents: Array<{ channel: string; data: unknown }> = [];
  const originalSend = env.mockWindow.webContents.send;

  env.mockWindow.webContents.send = ((channel: string, data: unknown) => {
    if (channel.startsWith(IPC_CHANNELS.WORKSPACE_CHAT_PREFIX) && isInitEvent(data)) {
      capturedEvents.push({ channel, data });
    }
    originalSend.call(env.mockWindow.webContents, channel, data);
  }) as typeof originalSend;

  return capturedEvents;
}

/**
 * Create init hook file in git repo
 */
async function createInitHook(repoPath: string, hookContent: string): Promise<void> {
  const cmuxDir = path.join(repoPath, CMUX_DIR);
  await fs.mkdir(cmuxDir, { recursive: true });
  const initHookPath = path.join(cmuxDir, INIT_HOOK_FILENAME);
  await fs.writeFile(initHookPath, hookContent, { mode: 0o755 });
}

/**
 * Commit changes in git repo
 */
async function commitChanges(repoPath: string, message: string): Promise<void> {
  await execAsync(`git add -A && git commit -m "${message}"`, {
    cwd: repoPath,
  });
}

/**
 * Set up test environment and git repo with automatic cleanup
 */
async function setupForkTest() {
  const env = await createTestEnvironment();
  const tempGitRepo = await createTempGitRepo();

  const cleanup = async () => {
    await cleanupTestEnvironment(env);
    await cleanupTempGitRepo(tempGitRepo);
  };

  return { env, tempGitRepo, cleanup };
}

/**
 * Wrapper that handles setup/cleanup for fork tests
 */
async function withForkTest(
  fn: (ctx: { env: TestEnvironment; tempGitRepo: string }) => Promise<void>
): Promise<void> {
  const { env, tempGitRepo, cleanup } = await setupForkTest();
  try {
    await fn({ env, tempGitRepo });
  } finally {
    await cleanup();
  }
}

describeIntegration("WORKSPACE_FORK with both runtimes", () => {
  // Enable retries in CI for flaky API tests
  if (process.env.CI && typeof jest !== "undefined" && jest.retryTimes) {
    jest.retryTimes(3, { logErrorsBeforeRetry: true });
  }

  beforeAll(async () => {
    // Check if Docker is available (required for SSH tests)
    if (!(await isDockerAvailable())) {
      throw new Error(
        "Docker is required for SSH runtime tests. Please install Docker or skip tests by unsetting TEST_INTEGRATION."
      );
    }

    // Start SSH server (shared across all tests for speed)
    console.log("Starting SSH server container for forkWorkspace tests...");
    sshConfig = await startSSHServer();
    console.log(`SSH server ready on port ${sshConfig.port}`);
  }, 60000); // 60s timeout for Docker operations

  afterAll(async () => {
    if (sshConfig) {
      console.log("Stopping SSH server container...");
      await stopSSHServer(sshConfig);
    }
  }, 30000);

  // Test matrix: Run tests for both local and SSH runtimes
  describe.each<{ type: "local" | "ssh" }>([{ type: "local" }, { type: "ssh" }])(
    "Runtime: $type",
    ({ type }) => {
      // Helper to build runtime config
      const getRuntimeConfig = (): RuntimeConfig | undefined => {
        if (type === "ssh" && sshConfig) {
          return {
            type: "ssh",
            host: `testuser@localhost`,
            srcBaseDir: sshConfig.workdir,
            identityFile: sshConfig.privateKeyPath,
            port: sshConfig.port,
          };
        }
        return undefined; // undefined = defaults to local
      };

      // Get runtime-specific init wait time (SSH needs more time)
      const getInitWaitTime = () => (type === "ssh" ? SSH_INIT_WAIT_MS : INIT_HOOK_WAIT_MS);

      describe("Fork operations", () => {
        test.concurrent(
          "validates workspace name",
          () =>
            withForkTest(async ({ env, tempGitRepo }) => {
              // Create source workspace
              const trunkBranch = await detectDefaultTrunkBranch(tempGitRepo);
              const sourceBranchName = generateBranchName();
              const runtimeConfig = getRuntimeConfig();
              const createResult = await env.mockIpcRenderer.invoke(
                IPC_CHANNELS.WORKSPACE_CREATE,
                tempGitRepo,
                sourceBranchName,
                trunkBranch,
                runtimeConfig
              );
              expect(createResult.success).toBe(true);
              const sourceWorkspaceId = createResult.metadata.id;

              // Wait for init to complete
              await new Promise((resolve) => setTimeout(resolve, getInitWaitTime()));

              // Test various invalid names
              const invalidNames = [
                { name: "", expectedError: "empty" },
                { name: "Invalid-Name", expectedError: "lowercase" },
                { name: "name with spaces", expectedError: "lowercase" },
                { name: "name@special", expectedError: "lowercase" },
                { name: "a".repeat(65), expectedError: "64 characters" },
              ];

              for (const { name, expectedError } of invalidNames) {
                const forkResult = await env.mockIpcRenderer.invoke(
                  IPC_CHANNELS.WORKSPACE_FORK,
                  sourceWorkspaceId,
                  name
                );
                expect(forkResult.success).toBe(false);
                expect(forkResult.error.toLowerCase()).toContain(expectedError.toLowerCase());
              }

              // Cleanup
              await env.mockIpcRenderer.invoke(IPC_CHANNELS.WORKSPACE_REMOVE, sourceWorkspaceId);
            }),
          TEST_TIMEOUT_MS
        );

        test.concurrent(
          "preserves runtime config and creates usable workspace",
          () =>
            withForkTest(async ({ env, tempGitRepo }) => {
              const trunkBranch = await detectDefaultTrunkBranch(tempGitRepo);
              const sourceBranchName = generateBranchName();
              const runtimeConfig = getRuntimeConfig();

              // Create source workspace
              const createResult = await env.mockIpcRenderer.invoke(
                IPC_CHANNELS.WORKSPACE_CREATE,
                tempGitRepo,
                sourceBranchName,
                trunkBranch,
                runtimeConfig
              );
              expect(createResult.success).toBe(true);
              const sourceWorkspaceId = createResult.metadata.id;
              const sourceMetadata = createResult.metadata;

              // Wait for init to complete
              await new Promise((resolve) => setTimeout(resolve, getInitWaitTime()));

              // Fork the workspace
              const forkedName = generateBranchName();
              const forkResult = await env.mockIpcRenderer.invoke(
                IPC_CHANNELS.WORKSPACE_FORK,
                sourceWorkspaceId,
                forkedName
              );
              expect(forkResult.success).toBe(true);
              expect(forkResult.metadata).toBeDefined();
              expect(forkResult.metadata.id).toBeDefined();

              // CRITICAL: Check that runtime config is preserved from source
              // (Not from the original input, since WORKSPACE_CREATE may normalize it)
              expect(forkResult.metadata.runtimeConfig).toEqual(sourceMetadata.runtimeConfig);

              // Wait for init to complete
              await new Promise((resolve) => setTimeout(resolve, getInitWaitTime()));

              // Property test: Forked workspace should be immediately usable for tool execution
              // This will fail if runtime config is wrong or directory doesn't exist
              const forkedWorkspaceId = forkResult.metadata.id;
              env.sentEvents.length = 0;

              const sendResult = await sendMessage(
                env.mockIpcRenderer,
                forkedWorkspaceId,
                "Run this bash command: echo 'fork-test-success'",
                { model: DEFAULT_TEST_MODEL }
              );
              expect(sendResult.success).toBe(true);

              // Verify stream completes successfully (would fail if workspace broken)
              const collector = createEventCollector(env.sentEvents, forkedWorkspaceId);
              await collector.waitForEvent("stream-end", 30000);
              assertStreamSuccess(collector);

              // Cleanup
              await env.mockIpcRenderer.invoke(IPC_CHANNELS.WORKSPACE_REMOVE, sourceWorkspaceId);
              await env.mockIpcRenderer.invoke(IPC_CHANNELS.WORKSPACE_REMOVE, forkedWorkspaceId);
            }),
          TEST_TIMEOUT_MS
        );
      });

      test.concurrent(
        "preserves chat history",
        async () => {
          // Note: setupWorkspace doesn't support runtimeConfig, only testing local for API tests
          if (type === "ssh") {
            return; // Skip SSH for API tests
          }

          const {
            env,
            workspaceId: sourceWorkspaceId,
            cleanup,
          } = await setupWorkspace("anthropic");

          try {
            // Add history to source workspace
            const historyService = new HistoryService(env.config);
            const uniqueWord = `testword-${Date.now()}`;
            const historyMessages = [
              createMuxMessage("msg-1", "user", `Remember this word: ${uniqueWord}`, {}),
              createMuxMessage(
                "msg-2",
                "assistant",
                `I will remember the word "${uniqueWord}".`,
                {}
              ),
            ];

            for (const msg of historyMessages) {
              const result = await historyService.appendToHistory(sourceWorkspaceId, msg);
              expect(result.success).toBe(true);
            }

            // Fork the workspace
            const forkedName = generateBranchName();
            const forkResult = await env.mockIpcRenderer.invoke(
              IPC_CHANNELS.WORKSPACE_FORK,
              sourceWorkspaceId,
              forkedName
            );
            expect(forkResult.success).toBe(true);
            const forkedWorkspaceId = forkResult.metadata.id;

            // Wait for fork init to complete
            await new Promise((resolve) => setTimeout(resolve, getInitWaitTime()));

            // User expects: forked workspace has access to history
            // Send a message that requires the historical context
            env.sentEvents.length = 0;
            const sendResult = await sendMessage(
              env.mockIpcRenderer,
              forkedWorkspaceId,
              "What word did I ask you to remember? Reply with just the word.",
              { model: DEFAULT_TEST_MODEL }
            );
            expect(sendResult.success).toBe(true);

            // Verify stream completes successfully
            const collector = createEventCollector(env.sentEvents, forkedWorkspaceId);
            await collector.waitForEvent("stream-end", 30000);
            assertStreamSuccess(collector);

            const finalMessage = collector.getFinalMessage();
            expect(finalMessage).toBeDefined();

            // Verify the response contains the word from history
            if (finalMessage && "parts" in finalMessage && Array.isArray(finalMessage.parts)) {
              const content = finalMessage.parts
                .filter((part) => part.type === "text")
                .map((part) => (part as { text: string }).text)
                .join("");
              expect(content.toLowerCase()).toContain(uniqueWord.toLowerCase());
            }
          } finally {
            await cleanup();
          }
        },
        45000
      );

      test.concurrent(
        "preserves uncommitted changes (SSH only)",
        () => {
          // Note: Local runtime creates git worktrees which are clean checkouts
          // Uncommitted changes are only preserved in SSH runtime (uses cp -a)
          if (type === "local") {
            return Promise.resolve(); // Skip for local
          }

          return withForkTest(async ({ env, tempGitRepo }) => {
            const trunkBranch = await detectDefaultTrunkBranch(tempGitRepo);
            const sourceBranchName = generateBranchName();
            const runtimeConfig = getRuntimeConfig();

            // Create workspace
            const createResult = await env.mockIpcRenderer.invoke(
              IPC_CHANNELS.WORKSPACE_CREATE,
              tempGitRepo,
              sourceBranchName,
              trunkBranch,
              runtimeConfig
            );
            expect(createResult.success).toBe(true);
            const sourceWorkspaceId = createResult.metadata.id;

            // Wait for init to complete
            await new Promise((resolve) => setTimeout(resolve, getInitWaitTime()));

            // For SSH, construct path manually since namedWorkspacePath doesn't work for SSH
            const projectName = tempGitRepo.split("/").pop() ?? "unknown";
            const sourceWorkspacePath =
              type === "ssh" && sshConfig
                ? `${sshConfig.workdir}/${projectName}/${sourceBranchName}`
                : (await env.mockIpcRenderer.invoke(IPC_CHANNELS.WORKSPACE_LIST)).find(
                    (w: any) => w.id === sourceWorkspaceId
                  )?.namedWorkspacePath;

            expect(sourceWorkspacePath).toBeDefined();

            // Create runtime for file operations
            const runtime = createRuntime(
              runtimeConfig ?? { type: "local", srcBaseDir: "~/.mux/src" }
            );

            const testContent = `Test content - ${Date.now()}`;
            const testFilePath =
              type === "ssh"
                ? `${sourceWorkspacePath}/uncommitted-test.txt`
                : path.join(sourceWorkspacePath, "uncommitted-test.txt");

            // Write file using runtime
            if (type === "ssh") {
              const writeStream = await runtime.writeFile(testFilePath);
              const writer = writeStream.getWriter();
              const encoder = new TextEncoder();
              await writer.write(encoder.encode(testContent));
              await writer.close();
            } else {
              await fs.writeFile(testFilePath, testContent);
            }

            // Fork the workspace
            const forkedName = generateBranchName();
            const forkResult = await env.mockIpcRenderer.invoke(
              IPC_CHANNELS.WORKSPACE_FORK,
              sourceWorkspaceId,
              forkedName
            );
            expect(forkResult.success).toBe(true);
            const forkedWorkspaceId = forkResult.metadata.id;

            // Wait for fork init to complete
            await new Promise((resolve) => setTimeout(resolve, getInitWaitTime()));

            // Get forked workspace path from metadata (or construct for SSH)
            const forkedWorkspacePath =
              type === "ssh" && sshConfig
                ? `${sshConfig.workdir}/${projectName}/${forkedName}`
                : (await env.mockIpcRenderer.invoke(IPC_CHANNELS.WORKSPACE_LIST)).find(
                    (w: any) => w.id === forkedWorkspaceId
                  )?.namedWorkspacePath;

            expect(forkedWorkspacePath).toBeDefined();

            const forkedFilePath =
              type === "ssh"
                ? `${forkedWorkspacePath}/uncommitted-test.txt`
                : path.join(forkedWorkspacePath, "uncommitted-test.txt");

            if (type === "ssh") {
              const readStream = await runtime.readFile(forkedFilePath);
              const forkedContent = await streamToString(readStream);
              expect(forkedContent).toBe(testContent);
            } else {
              const forkedContent = await fs.readFile(forkedFilePath, "utf-8");
              expect(forkedContent).toBe(testContent);
            }

            // Cleanup
            await env.mockIpcRenderer.invoke(IPC_CHANNELS.WORKSPACE_REMOVE, sourceWorkspaceId);
            await env.mockIpcRenderer.invoke(IPC_CHANNELS.WORKSPACE_REMOVE, forkedWorkspaceId);
          });
        },
        TEST_TIMEOUT_MS
      );

      test.concurrent(
        "manages init state correctly",
        () =>
          withForkTest(async ({ env, tempGitRepo }) => {
            // Create init hook that takes time
            const initHookContent = `#!/bin/bash
echo "Init starting"
sleep 3
echo "Init complete"
`;
            await createInitHook(tempGitRepo, initHookContent);
            await commitChanges(tempGitRepo, "Add init hook");

            // Create source workspace
            const trunkBranch = await detectDefaultTrunkBranch(tempGitRepo);
            const sourceBranchName = generateBranchName();
            const runtimeConfig = getRuntimeConfig();
            const createResult = await env.mockIpcRenderer.invoke(
              IPC_CHANNELS.WORKSPACE_CREATE,
              tempGitRepo,
              sourceBranchName,
              trunkBranch,
              runtimeConfig
            );
            expect(createResult.success).toBe(true);
            const sourceWorkspaceId = createResult.metadata.id;

            // Wait for source workspace init to complete
            await new Promise((resolve) => setTimeout(resolve, getInitWaitTime()));

            // Test 1: Can't fork workspace that's currently initializing
            // Create another workspace that will be initializing
            const anotherBranchName = generateBranchName();
            const createResult2 = await env.mockIpcRenderer.invoke(
              IPC_CHANNELS.WORKSPACE_CREATE,
              tempGitRepo,
              anotherBranchName,
              trunkBranch,
              runtimeConfig
            );
            expect(createResult2.success).toBe(true);
            const initializingWorkspaceId = createResult2.metadata.id;

            // Immediately try to fork (while init is running)
            const tempForkName = generateBranchName();
            const tempForkResult = await env.mockIpcRenderer.invoke(
              IPC_CHANNELS.WORKSPACE_FORK,
              initializingWorkspaceId,
              tempForkName
            );
            expect(tempForkResult.success).toBe(false);
            expect(tempForkResult.error).toMatch(/initializing/i);

            // Wait for init to complete
            await new Promise((resolve) => setTimeout(resolve, getInitWaitTime()));

            // Test 2: Tools are blocked in forked workspace until init completes
            // Fork the first workspace (triggers init for new workspace)
            const forkedName = generateBranchName();
            const forkTime = Date.now();
            const forkResult = await env.mockIpcRenderer.invoke(
              IPC_CHANNELS.WORKSPACE_FORK,
              sourceWorkspaceId,
              forkedName
            );
            expect(forkResult.success).toBe(true);
            const forkedWorkspaceId = forkResult.metadata.id;

            // Clear events BEFORE sending message
            env.sentEvents.length = 0;

            // Send message that will use file_read tool
            // The tool should block until init completes
            await sendMessage(env.mockIpcRenderer, forkedWorkspaceId, "Read the README.md file", {
              model: DEFAULT_TEST_MODEL,
            });

            // Wait for stream to complete
            const collector = createEventCollector(env.sentEvents, forkedWorkspaceId);
            await collector.waitForEvent("stream-end", 30000);
            assertStreamSuccess(collector);

            // If we get here without errors, init blocking worked
            // (If init didn't complete, file_read would fail with "file not found")
            // The presence of both stream-end and successful tool execution proves it

            // Cleanup
            await env.mockIpcRenderer.invoke(IPC_CHANNELS.WORKSPACE_REMOVE, sourceWorkspaceId);
            await env.mockIpcRenderer.invoke(IPC_CHANNELS.WORKSPACE_REMOVE, forkedWorkspaceId);
          }),
        TEST_TIMEOUT_MS
      );
    }
  );
});
