/**
 * Integration tests for bash execution across Local and SSH runtimes
 *
 * Tests bash tool using real IPC handlers on both LocalRuntime and SSHRuntime.
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
import { IPC_CHANNELS } from "../../src/common/constants/ipc-constants";
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
} from "../runtime/ssh-fixture";
import type { RuntimeConfig } from "../../src/common/types/runtime";
import type { WorkspaceChatMessage } from "../../src/common/types/ipc";
import type { ToolPolicy } from "../../src/common/utils/tools/toolPolicy";

// Tool policy: Only allow bash tool
const BASH_ONLY: ToolPolicy = [
  { regex_match: "bash", action: "enable" },
  { regex_match: "file_.*", action: "disable" },
];

function collectToolOutputs(events: WorkspaceChatMessage[], toolName: string): string {
  return events
    .filter((event: any) => event.type === "tool-call-end" && event.toolName === toolName)
    .map((event: any) => {
      const output = event.result?.output;
      return typeof output === "string" ? output : "";
    })
    .join("\n");
}

// Helper to calculate tool execution duration from captured events
function getToolDuration(
  env: { sentEvents: Array<{ channel: string; data: unknown; timestamp: number }> },
  toolName: string
): number {
  const startEvent = env.sentEvents.find((e) => {
    const msg = e.data as any;
    return msg.type === "tool-call-start" && msg.toolName === toolName;
  });

  const endEvent = env.sentEvents.find((e) => {
    const msg = e.data as any;
    return msg.type === "tool-call-end" && msg.toolName === toolName;
  });

  if (startEvent && endEvent) {
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
            await setupProviders(env.mockIpcRenderer, {
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
                'Run the bash command "echo Hello World"',
                HAIKU_MODEL,
                BASH_ONLY
              );

              // Extract response text
              const responseText = extractTextFromEvents(events);

              // Verify the command output appears in the response
              expect(responseText.toLowerCase()).toContain("hello world");

              // Verify bash tool was called
              // Tool calls now emit tool-call-start and tool-call-end events (not tool-call-delta)
              const toolCallStarts = events.filter((e: any) => e.type === "tool-call-start");
              const bashCall = toolCallStarts.find((e: any) => e.toolName === "bash");
              expect(bashCall).toBeDefined();
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
            await setupProviders(env.mockIpcRenderer, {
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
                'Run bash command: export TEST_VAR="test123" && echo "Value: $TEST_VAR"',
                HAIKU_MODEL,
                BASH_ONLY
              );

              // Extract response text
              const responseText = extractTextFromEvents(events);

              // Verify the env var value appears
              expect(responseText).toContain("test123");

              // Verify bash tool was called
              // Tool calls now emit tool-call-start and tool-call-end events (not tool-call-delta)
              const toolCallStarts = events.filter((e: any) => e.type === "tool-call-start");
              const bashCall = toolCallStarts.find((e: any) => e.toolName === "bash");
              expect(bashCall).toBeDefined();
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
            await setupProviders(env.mockIpcRenderer, {
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
              // Using gpt-5-mini for speed (bash tool tests don't need reasoning power)
              await sendMessageAndWait(
                env,
                workspaceId,
                'Run bash: echo \'{"test": "data"}\' > /tmp/test.json',
                HAIKU_MODEL,
                BASH_ONLY
              );

              // Test command that pipes file through stdin-reading command (grep)
              // This would hang forever if stdin.close() was used instead of stdin.abort()
              // Regression test for: https://github.com/coder/mux/issues/503
              const events = await sendMessageAndWait(
                env,
                workspaceId,
                "Run bash: cat /tmp/test.json | grep test",
                HAIKU_MODEL,
                BASH_ONLY,
                30000 // Relaxed timeout for CI stability (was 10s)
              );

              // Calculate actual tool execution duration
              const toolDuration = getToolDuration(env, "bash");

              // Extract response text
              const responseText = extractTextFromEvents(events);

              // Verify command completed successfully (not timeout)
              // We primarily check bashOutput to ensure the tool executed and didn't hang
              const bashOutput = collectToolOutputs(events, "bash");
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

              // Verify bash tool was called
              const toolCallStarts = events.filter((e: any) => e.type === "tool-call-start");
              const bashCalls = toolCallStarts.filter((e: any) => e.toolName === "bash");
              expect(bashCalls.length).toBeGreaterThan(0);
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
            await setupProviders(env.mockIpcRenderer, {
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
                'Run bash: for i in {1..1000}; do echo "terminal bench line $i" >> testfile.txt; done',
                HAIKU_MODEL,
                BASH_ONLY
              );

              // Test grep | head pattern - this historically hangs over SSH
              // This is a regression test for the bash hang issue
              const events = await sendMessageAndWait(
                env,
                workspaceId,
                'Run bash: grep -n "terminal bench" testfile.txt | head -n 200',
                HAIKU_MODEL,
                BASH_ONLY,
                30000 // Relaxed timeout for CI stability (was 15s)
              );

              // Calculate actual tool execution duration
              const toolDuration = getToolDuration(env, "bash");

              // Extract response text
              const responseText = extractTextFromEvents(events);

              // Verify command completed successfully (not timeout)
              expect(responseText).toContain("terminal bench");

              // Verify command completed quickly (not hanging until timeout)
              // SSH runtime should complete in <10s even with high latency
              expect(toolDuration).toBeGreaterThan(0);
              const maxDuration = 15000;
              expect(toolDuration).toBeLessThan(maxDuration);

              // Verify bash tool was called
              const toolCallStarts = events.filter((e: any) => e.type === "tool-call-start");
              const bashCalls = toolCallStarts.filter((e: any) => e.toolName === "bash");
              expect(bashCalls.length).toBeGreaterThan(0);
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
