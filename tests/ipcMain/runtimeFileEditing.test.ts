/**
 * Integration tests for file editing tools across Local and SSH runtimes
 *
 * Tests file_read, file_edit_replace_string, and file_edit_insert tools
 * using real IPC handlers on both LocalRuntime and SSHRuntime.
 *
 * Uses toolPolicy to restrict AI to only file tools (prevents bash circumvention).
 */

import * as fs from "fs/promises";
import * as path from "path";
import {
  createTestEnvironment,
  cleanupTestEnvironment,
  shouldRunIntegrationTests,
  validateApiKeys,
  getApiKey,
  setupProviders,
  type TestEnvironment,
} from "./setup";
import { IPC_CHANNELS } from "../../src/common/constants/ipc-constants";
import {
  createTempGitRepo,
  cleanupTempGitRepo,
  generateBranchName,
  createWorkspaceWithInit,
  sendMessageAndWait,
  extractTextFromEvents,
  writeFileViaBash,
  configureTestRetries,
  HAIKU_MODEL,
} from "./helpers";
import {
  isDockerAvailable,
  startSSHServer,
  stopSSHServer,
  type SSHServerConfig,
} from "../runtime/ssh-fixture";
import type { RuntimeConfig } from "../../src/common/types/runtime";
import type { ToolPolicy } from "../../src/common/utils/tools/toolPolicy";

// Tool policy: Only allow file tools (disable bash to isolate file tool issues)
const FILE_TOOLS_ONLY: ToolPolicy = [
  { regex_match: "file_.*", action: "enable" },
  { regex_match: "bash", action: "disable" },
];

// Skip all tests if TEST_INTEGRATION is not set
const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

// Validate API keys before running tests
if (shouldRunIntegrationTests()) {
  validateApiKeys(["ANTHROPIC_API_KEY"]);
}

// Increased timeouts for file editing tests - these tests require LLM tool calls
// which can be slow depending on API response times
const STREAM_TIMEOUT_MS = 30000; // Stream timeout (was 15s)
const SSH_STREAM_TIMEOUT_MS = 45000; // SSH stream timeout (was 25s)
const LOCAL_TEST_TIMEOUT_MS = 45000; // Test timeout (was 25s)
const SSH_TEST_TIMEOUT_MS = 90000; // SSH test timeout (was 60s)

// SSH server config (shared across all SSH tests)
let sshConfig: SSHServerConfig | undefined;

// ============================================================================
// Tests
// ============================================================================

describeIntegration("Runtime File Editing Tools", () => {
  // Enable retries in CI for flaky API tests
  configureTestRetries(3);

  beforeAll(async () => {
    // Check if Docker is available (required for SSH tests)
    if (!(await isDockerAvailable())) {
      throw new Error(
        "Docker is required for SSH runtime tests. Please install Docker or skip tests by unsetting TEST_INTEGRATION."
      );
    }

    // Start SSH server (shared across all tests for speed)
    console.log("Starting SSH server container for file editing tests...");
    sshConfig = await startSSHServer();
    console.log(`SSH server ready on port ${sshConfig.port}`);
  }, 60000);

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
      const getRuntimeConfig = (branchName: string): RuntimeConfig | undefined => {
        if (type === "ssh" && sshConfig) {
          return {
            type: "ssh",
            host: `testuser@localhost`,
            srcBaseDir: `${sshConfig.workdir}/${branchName}`,
            identityFile: sshConfig.privateKeyPath,
            port: sshConfig.port,
          };
        }
        return undefined; // undefined = defaults to local
      };

      test.concurrent(
        "should read file content with file_read tool",
        async () => {
          const env = await createTestEnvironment();
          const tempGitRepo = await createTempGitRepo();

          try {
            // Setup provider
            await setupProviders(env.mockIpcRenderer, {
              anthropic: {
                apiKey: getApiKey("ANTHROPIC_API_KEY"),
              },
            });

            // Create workspace
            const branchName = generateBranchName("read-test");
            const runtimeConfig = getRuntimeConfig(branchName);
            const { workspaceId, cleanup } = await createWorkspaceWithInit(
              env,
              tempGitRepo,
              branchName,
              runtimeConfig,
              true, // waitForInit
              type === "ssh"
            );

            try {
              // Create test file directly (faster than LLM call)
              const testFileName = "test_read.txt";
              const testContent = "Hello from mux file tools!";
              await writeFileViaBash(env, workspaceId, testFileName, testContent);

              // Ask AI to read the file (explicitly request file_read tool)
              const streamTimeout = type === "ssh" ? SSH_STREAM_TIMEOUT_MS : STREAM_TIMEOUT_MS;
              const readEvents = await sendMessageAndWait(
                env,
                workspaceId,
                `Use the file_read tool to read ${testFileName} and tell me what it contains.`,
                HAIKU_MODEL,
                FILE_TOOLS_ONLY,
                streamTimeout
              );

              // Verify stream completed successfully
              const streamEnd = readEvents.find((e) => "type" in e && e.type === "stream-end");
              expect(streamEnd).toBeDefined();
              expect((streamEnd as any).error).toBeUndefined();

              // Verify file_read tool was called
              const toolCalls = readEvents.filter(
                (e) => "type" in e && e.type === "tool-call-start"
              );
              const fileReadCall = toolCalls.find((e: any) => e.toolName === "file_read");
              expect(fileReadCall).toBeDefined();

              // Verify response mentions the content
              const responseText = extractTextFromEvents(readEvents);
              expect(responseText.toLowerCase()).toContain("hello");
            } finally {
              await cleanup();
            }
          } finally {
            await cleanupTestEnvironment(env);
            await cleanupTempGitRepo(tempGitRepo);
          }
        },
        type === "ssh" ? SSH_TEST_TIMEOUT_MS : LOCAL_TEST_TIMEOUT_MS
      );

      test.concurrent(
        "should replace text with file_edit_replace_string tool",
        async () => {
          const env = await createTestEnvironment();
          const tempGitRepo = await createTempGitRepo();

          try {
            // Setup provider
            await setupProviders(env.mockIpcRenderer, {
              anthropic: {
                apiKey: getApiKey("ANTHROPIC_API_KEY"),
              },
            });

            // Create workspace
            const branchName = generateBranchName("replace-test");
            const runtimeConfig = getRuntimeConfig(branchName);
            const { workspaceId, cleanup } = await createWorkspaceWithInit(
              env,
              tempGitRepo,
              branchName,
              runtimeConfig,
              true, // waitForInit
              type === "ssh"
            );

            try {
              // Create test file directly (faster than LLM call)
              const testFileName = "test_replace.txt";
              const testContent = "The quick brown fox jumps over the lazy dog.";
              await writeFileViaBash(env, workspaceId, testFileName, testContent);

              // Ask AI to replace text (explicitly request file_edit_replace_string tool)
              const streamTimeout = type === "ssh" ? SSH_STREAM_TIMEOUT_MS : STREAM_TIMEOUT_MS;
              const replaceEvents = await sendMessageAndWait(
                env,
                workspaceId,
                `Use the file_edit_replace_string tool to replace "brown fox" with "red panda" in ${testFileName}.`,
                HAIKU_MODEL,
                FILE_TOOLS_ONLY,
                streamTimeout
              );

              // Verify stream completed successfully
              const streamEnd = replaceEvents.find((e) => "type" in e && e.type === "stream-end");
              expect(streamEnd).toBeDefined();
              expect((streamEnd as any).error).toBeUndefined();

              // Verify file_edit_replace_string tool was called
              const toolCalls = replaceEvents.filter(
                (e) => "type" in e && e.type === "tool-call-start"
              );
              const replaceCall = toolCalls.find(
                (e: any) => e.toolName === "file_edit_replace_string"
              );
              expect(replaceCall).toBeDefined();

              // Verify the replacement was successful (check for diff or success message)
              const responseText = extractTextFromEvents(replaceEvents);
              expect(
                responseText.toLowerCase().includes("replace") ||
                  responseText.toLowerCase().includes("changed") ||
                  responseText.toLowerCase().includes("updated")
              ).toBe(true);
            } finally {
              await cleanup();
            }
          } finally {
            await cleanupTestEnvironment(env);
            await cleanupTempGitRepo(tempGitRepo);
          }
        },
        type === "ssh" ? SSH_TEST_TIMEOUT_MS : LOCAL_TEST_TIMEOUT_MS
      );

      test.concurrent(
        "should insert text with file_edit_insert tool",
        async () => {
          const env = await createTestEnvironment();
          const tempGitRepo = await createTempGitRepo();

          try {
            // Setup provider
            await setupProviders(env.mockIpcRenderer, {
              anthropic: {
                apiKey: getApiKey("ANTHROPIC_API_KEY"),
              },
            });

            // Create workspace
            const branchName = generateBranchName("insert-test");
            const runtimeConfig = getRuntimeConfig(branchName);
            const { workspaceId, cleanup } = await createWorkspaceWithInit(
              env,
              tempGitRepo,
              branchName,
              runtimeConfig,
              true, // waitForInit
              type === "ssh"
            );

            try {
              // Create test file directly (faster than LLM call)
              const testFileName = "test_insert.txt";
              const testContent = "Line 1\nLine 3";
              await writeFileViaBash(env, workspaceId, testFileName, testContent);

              // Ask AI to insert text (explicitly request file_edit tool usage)
              const streamTimeout = type === "ssh" ? SSH_STREAM_TIMEOUT_MS : STREAM_TIMEOUT_MS;
              const insertEvents = await sendMessageAndWait(
                env,
                workspaceId,
                `Use the file_edit_insert (preferred) or file_edit_replace_string tool to insert "Line 2" between Line 1 and Line 3 in ${testFileName}.`,
                HAIKU_MODEL,
                FILE_TOOLS_ONLY,
                streamTimeout
              );

              // Verify stream completed successfully
              const streamEnd = insertEvents.find((e) => "type" in e && e.type === "stream-end");
              expect(streamEnd).toBeDefined();
              expect((streamEnd as any).error).toBeUndefined();

              // Verify file_edit_insert (or fallback file_edit_replace_string) tool was called
              const toolCalls = insertEvents.filter(
                (e) => "type" in e && e.type === "tool-call-start"
              );
              const editCall = toolCalls.find(
                (e: any) =>
                  e.toolName === "file_edit_insert" || e.toolName === "file_edit_replace_string"
              );
              expect(editCall).toBeDefined();

              // Verify the insertion was successful
              const responseText = extractTextFromEvents(insertEvents);
              expect(
                responseText.toLowerCase().includes("insert") ||
                  responseText.toLowerCase().includes("add") ||
                  responseText.toLowerCase().includes("updated")
              ).toBe(true);
            } finally {
              await cleanup();
            }
          } finally {
            await cleanupTestEnvironment(env);
            await cleanupTempGitRepo(tempGitRepo);
          }
        },
        type === "ssh" ? SSH_TEST_TIMEOUT_MS : LOCAL_TEST_TIMEOUT_MS
      );

      test.concurrent(
        "should handle relative paths correctly when editing files",
        async () => {
          const env = await createTestEnvironment();
          const tempGitRepo = await createTempGitRepo();

          try {
            // Setup provider
            await setupProviders(env.mockIpcRenderer, {
              anthropic: {
                apiKey: getApiKey("ANTHROPIC_API_KEY"),
              },
            });

            // Create workspace
            const branchName = generateBranchName("relative-path-test");
            const runtimeConfig = getRuntimeConfig(branchName);
            const { workspaceId, cleanup } = await createWorkspaceWithInit(
              env,
              tempGitRepo,
              branchName,
              runtimeConfig,
              true,
              type === "ssh"
            );

            try {
              // Create test file directly in subdirectory (faster than LLM call)
              const relativeTestFile = "subdir/relative_test.txt";
              const testContent = "Original content";
              await writeFileViaBash(env, workspaceId, relativeTestFile, testContent);

              // Now edit the file using a relative path
              const streamTimeout = type === "ssh" ? SSH_STREAM_TIMEOUT_MS : STREAM_TIMEOUT_MS;
              const editEvents = await sendMessageAndWait(
                env,
                workspaceId,
                `Replace the text in ${relativeTestFile}: change "Original" to "Modified"`,
                HAIKU_MODEL,
                FILE_TOOLS_ONLY,
                streamTimeout
              );

              // Verify edit was successful
              const editStreamEnd = editEvents.find((e) => "type" in e && e.type === "stream-end");
              expect(editStreamEnd).toBeDefined();
              expect((editStreamEnd as any).error).toBeUndefined();

              // Verify file_edit_replace_string tool was called
              const toolCalls = editEvents.filter(
                (e) => "type" in e && e.type === "tool-call-start"
              );
              const editCall = toolCalls.find(
                (e: any) => e.toolName === "file_edit_replace_string"
              );
              expect(editCall).toBeDefined();

              // Verify tool result indicates success
              const toolResults = editEvents.filter(
                (e) => "type" in e && e.type === "tool-call-end"
              );
              const editResult = toolResults.find(
                (e: any) => e.toolName === "file_edit_replace_string"
              );
              expect(editResult).toBeDefined();
              // Tool result should contain a diff showing the change (indicates success)
              const result = (editResult as any)?.result;
              const resultStr = typeof result === "string" ? result : JSON.stringify(result);
              expect(resultStr).toContain("Modified content");

              // If this is SSH, the bug would cause the edit to fail because
              // path.resolve() would resolve relative to the LOCAL filesystem
              // instead of the REMOTE filesystem
            } finally {
              await cleanup();
            }
          } finally {
            await cleanupTestEnvironment(env);
            await cleanupTempGitRepo(tempGitRepo);
          }
        },
        type === "ssh" ? SSH_TEST_TIMEOUT_MS : LOCAL_TEST_TIMEOUT_MS
      );
    }
  );
});
