/**
 * Integration tests for bash execution across Local and SSH runtimes
 *
 * Tests bash tool using real ORPC handlers on both LocalRuntime and SSHRuntime.
 *
 * Reuses test infrastructure from runtimeFileEditing.test.ts
 */

import {
  createTestEnvironment,
  cleanupTestEnvironment,
  shouldRunIntegrationTests,
  validateApiKeys,
  getApiKey,
  setupProviders,
} from "./setup";
import {
  createTempGitRepo,
  cleanupTempGitRepo,
  generateBranchName,
  createWorkspaceWithInit,
  sendMessageAndWait,
  extractTextFromEvents,
  HAIKU_MODEL,
  TEST_TIMEOUT_LOCAL_MS,
  TEST_TIMEOUT_SSH_MS,
} from "./helpers";
import {
  isDockerAvailable,
  startSSHServer,
  stopSSHServer,
  type SSHServerConfig,
} from "../runtime/test-fixtures/ssh-fixture";
import type { RuntimeConfig } from "../../src/common/types/runtime";
import type { WorkspaceChatMessage } from "../../src/common/orpc/types";
import type { ToolPolicy } from "../../src/common/utils/tools/toolPolicy";

// Tool policy: Only allow the unified task tool (used as task(kind="bash")).
const TASK_BASH_ONLY: ToolPolicy = [{ regex_match: "task", action: "require" }];

/**
 * Collect tool outputs from stream events
 */
function collectToolOutputs(events: WorkspaceChatMessage[], toolName: string): string {
  return events
    .filter(
      (event) =>
        "type" in event &&
        event.type === "tool-call-end" &&
        "toolName" in event &&
        event.toolName === toolName
    )
    .map((event) => {
      const result = (event as { result?: { output?: string; reportMarkdown?: string } }).result;
      const text = toolName === "task" ? result?.reportMarkdown : result?.output;
      return typeof text === "string" ? text : "";
    })
    .join("\n");
}

/**
 * Calculate tool execution duration from captured events.
 * Returns duration in milliseconds, or -1 if events not found.
 */
function getToolDuration(events: WorkspaceChatMessage[], toolName: string): number {
  const startEvent = events.find(
    (e) => "type" in e && e.type === "tool-call-start" && "toolName" in e && e.toolName === toolName
  ) as { timestamp?: number } | undefined;

  const endEvent = events.find(
    (e) => "type" in e && e.type === "tool-call-end" && "toolName" in e && e.toolName === toolName
  ) as { timestamp?: number } | undefined;

  if (startEvent?.timestamp && endEvent?.timestamp) {
    return endEvent.timestamp - startEvent.timestamp;
  }
  return -1;
}

// Skip all tests if TEST_INTEGRATION is not set
const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

// Validate API keys before running tests
if (shouldRunIntegrationTests()) {
  validateApiKeys(["ANTHROPIC_API_KEY"]);
}

// SSH server config (shared across all SSH tests)
let sshConfig: SSHServerConfig | undefined;

describeIntegration("Runtime Bash Execution", () => {
  beforeAll(async () => {
    // Check if Docker is available (required for SSH tests)
    if (!(await isDockerAvailable())) {
      throw new Error(
        "Docker is required for SSH runtime tests. Please install Docker or skip tests by unsetting TEST_INTEGRATION."
      );
    }

    // Start SSH server (shared across all tests for speed)
    console.log("Starting SSH server container for bash tests...");
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
        "should execute simple bash command",
        async () => {
          const env = await createTestEnvironment();
          const tempGitRepo = await createTempGitRepo();

          try {
            // Setup provider
            await setupProviders(env, {
              anthropic: {
                apiKey: getApiKey("ANTHROPIC_API_KEY"),
              },
            });

            // Create workspace
            const branchName = generateBranchName("bash-simple");
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
              // Ask AI to run a simple command
              const events = await sendMessageAndWait(
                env,
                workspaceId,
                'Use task(kind="bash") to run: echo Hello World. Do not spawn a sub-agent.',
                HAIKU_MODEL,
                TASK_BASH_ONLY
              );

              // Extract response text
              const responseText = extractTextFromEvents(events);

              // Verify the command output appears in the task tool result.
              const taskOutput = collectToolOutputs(events, "task");
              expect(taskOutput.toLowerCase()).toContain("hello world");

              // responseText might be empty if the model doesn't comment on the output.
              if (responseText) {
                expect(responseText.toLowerCase()).toContain("hello world");
              }

              // Verify task(kind="bash") was called
              const toolCallStarts = events.filter(
                (e) => "type" in e && e.type === "tool-call-start"
              );
              const taskCall = toolCallStarts.find((e) => {
                if (!("toolName" in e) || e.toolName !== "task") return false;
                const args = (e as { args?: { kind?: string } }).args;
                return args?.kind === "bash";
              });
              expect(taskCall).toBeDefined();
            } finally {
              await cleanup();
            }
          } finally {
            await cleanupTempGitRepo(tempGitRepo);
            await cleanupTestEnvironment(env);
          }
        },
        type === "ssh" ? TEST_TIMEOUT_SSH_MS : TEST_TIMEOUT_LOCAL_MS
      );

      test.concurrent(
        "should handle bash command with environment variables",
        async () => {
          const env = await createTestEnvironment();
          const tempGitRepo = await createTempGitRepo();

          try {
            // Setup provider
            await setupProviders(env, {
              anthropic: {
                apiKey: getApiKey("ANTHROPIC_API_KEY"),
              },
            });

            // Create workspace
            const branchName = generateBranchName("bash-env");
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
              // Ask AI to run command that sets and uses env var
              const events = await sendMessageAndWait(
                env,
                workspaceId,
                'Use task(kind="bash") to run: export TEST_VAR="test123" && echo "Value: $TEST_VAR". Do not spawn a sub-agent.',
                HAIKU_MODEL,
                TASK_BASH_ONLY
              );

              // Extract response text
              const responseText = extractTextFromEvents(events);

              // Verify the env var value appears in the task tool output.
              const taskOutput = collectToolOutputs(events, "task");
              expect(taskOutput).toContain("test123");

              // responseText might be empty if the model doesn't comment on the output.
              if (responseText) {
                expect(responseText).toContain("test123");
              }

              // Verify task(kind="bash") was called
              const toolCallStarts = events.filter(
                (e) => "type" in e && e.type === "tool-call-start"
              );
              const taskCall = toolCallStarts.find((e) => {
                if (!("toolName" in e) || e.toolName !== "task") return false;
                const args = (e as { args?: { kind?: string } }).args;
                return args?.kind === "bash";
              });
              expect(taskCall).toBeDefined();
            } finally {
              await cleanup();
            }
          } finally {
            await cleanupTempGitRepo(tempGitRepo);
            await cleanupTestEnvironment(env);
          }
        },
        type === "ssh" ? TEST_TIMEOUT_SSH_MS : TEST_TIMEOUT_LOCAL_MS
      );

      test.concurrent(
        "should not hang on commands that read stdin without input",
        async () => {
          const env = await createTestEnvironment();
          const tempGitRepo = await createTempGitRepo();

          try {
            // Setup provider
            await setupProviders(env, {
              anthropic: {
                apiKey: getApiKey("ANTHROPIC_API_KEY"),
              },
            });

            // Create workspace
            const branchName = generateBranchName("bash-stdin");
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
              // Create a test file with JSON content
              await sendMessageAndWait(
                env,
                workspaceId,
                'Use task(kind="bash") to run: echo \'{"test": "data"}\' > /tmp/test.json. Do not spawn a sub-agent.',
                HAIKU_MODEL,
                TASK_BASH_ONLY
              );

              // Test command that pipes file through stdin-reading command (grep)
              // This would hang forever if stdin.close() was used instead of stdin.abort()
              // Regression test for: https://github.com/coder/mux/issues/503
              const events = await sendMessageAndWait(
                env,
                workspaceId,
                'Use task(kind="bash") to run: cat /tmp/test.json | grep test. Do not spawn a sub-agent.',
                HAIKU_MODEL,
                TASK_BASH_ONLY,
                30000 // Relaxed timeout for CI stability (was 10s)
              );

              // Calculate actual tool execution duration
              const toolDuration = getToolDuration(events, "task");

              // Extract response text
              const responseText = extractTextFromEvents(events);

              // Verify command completed successfully (not timeout)
              // We primarily check bashOutput to ensure the tool executed and didn't hang
              const bashOutput = collectToolOutputs(events, "task");
              expect(bashOutput).toContain('"test": "data"');

              // responseText might be empty if the model decides not to comment on the output
              // so we make this check optional or less strict if the tool output is correct
              if (responseText) {
                expect(responseText).toContain("test");
              }

              // Verify command completed quickly (not hanging until timeout)
              expect(toolDuration).toBeGreaterThan(0);
              const maxDuration = 10000;
              expect(toolDuration).toBeLessThan(maxDuration);

              // Verify task(kind="bash") was called
              const toolCallStarts = events.filter(
                (e) => "type" in e && e.type === "tool-call-start"
              );
              const taskCalls = toolCallStarts.filter((e) => {
                if (!("toolName" in e) || e.toolName !== "task") return false;
                const args = (e as { args?: { kind?: string } }).args;
                return args?.kind === "bash";
              });
              expect(taskCalls.length).toBeGreaterThan(0);
            } finally {
              await cleanup();
            }
          } finally {
            await cleanupTempGitRepo(tempGitRepo);
            await cleanupTestEnvironment(env);
          }
        },
        type === "ssh" ? TEST_TIMEOUT_SSH_MS : TEST_TIMEOUT_LOCAL_MS
      );

      test.concurrent(
        "should not hang on grep | head pattern over SSH",
        async () => {
          const env = await createTestEnvironment();
          const tempGitRepo = await createTempGitRepo();

          try {
            // Setup provider
            await setupProviders(env, {
              anthropic: {
                apiKey: getApiKey("ANTHROPIC_API_KEY"),
              },
            });

            // Create workspace
            const branchName = generateBranchName("bash-grep-head");
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
              // Create some test files to search through
              await sendMessageAndWait(
                env,
                workspaceId,
                'Use task(kind="bash") to run: for i in {1..1000}; do echo "terminal bench line $i" >> testfile.txt; done. Do not spawn a sub-agent.',
                HAIKU_MODEL,
                TASK_BASH_ONLY
              );

              // Test grep | head pattern - this historically hangs over SSH
              // This is a regression test for the bash hang issue
              const events = await sendMessageAndWait(
                env,
                workspaceId,
                'Use task(kind="bash") to run: grep -n "terminal bench" testfile.txt | head -n 200. Do not spawn a sub-agent.',
                HAIKU_MODEL,
                TASK_BASH_ONLY,
                30000 // Relaxed timeout for CI stability (was 15s)
              );

              // Calculate actual tool execution duration
              const toolDuration = getToolDuration(events, "task");

              // Verify command completed successfully (not timeout)
              // Check that task(kind="bash") completed (tool-call-end events exist)
              const toolCallEnds = events.filter((e) => {
                if (!("type" in e) || e.type !== "tool-call-end") return false;
                if (!("toolName" in e) || e.toolName !== "task") return false;
                const args = (e as { args?: { kind?: string } }).args;
                return args?.kind === "bash";
              });
              expect(toolCallEnds.length).toBeGreaterThan(0);

              // Verify command completed quickly (not hanging until timeout)
              // SSH runtime should complete in <10s even with high latency
              expect(toolDuration).toBeGreaterThan(0);
              const maxDuration = 15000;
              expect(toolDuration).toBeLessThan(maxDuration);

              // Verify task(kind="bash") was called
              const toolCallStarts = events.filter(
                (e) => "type" in e && e.type === "tool-call-start"
              );
              const taskCalls = toolCallStarts.filter((e) => {
                if (!("toolName" in e) || e.toolName !== "task") return false;
                const args = (e as { args?: { kind?: string } }).args;
                return args?.kind === "bash";
              });
              expect(taskCalls.length).toBeGreaterThan(0);
            } finally {
              await cleanup();
            }
          } finally {
            await cleanupTempGitRepo(tempGitRepo);
            await cleanupTestEnvironment(env);
          }
        },
        type === "ssh" ? TEST_TIMEOUT_SSH_MS : TEST_TIMEOUT_LOCAL_MS
      );
    }
  );
});
