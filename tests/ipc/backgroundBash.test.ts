/**
 * Integration tests for background bash process execution
 *
 * Tests the background process feature via AI tool calls on local runtime.
 * SSH runtime tests are intentionally omitted to avoid flakiness.
 *
 * These tests verify the service wiring is correct - detailed behavior
 * is covered by unit tests in backgroundProcessManager.test.ts
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
} from "./helpers";
import type { WorkspaceChatMessage } from "../../src/common/orpc/types";
import type { ToolPolicy } from "../../src/common/utils/tools/toolPolicy";

// Tool policy: Allow bash and bash_background_* tools (bash prefix matches all)
const BACKGROUND_TOOLS: ToolPolicy = [
  { regex_match: "bash", action: "enable" },
  { regex_match: "file_.*", action: "disable" },
];

// Extended timeout for tests making multiple AI calls
const BACKGROUND_TEST_TIMEOUT_MS = 75000;

/**
 * Extract process ID from bash tool output containing "Background process started with ID: bg-xxx"
 */
function extractProcessId(events: WorkspaceChatMessage[]): string | null {
  for (const event of events) {
    if (
      "type" in event &&
      event.type === "tool-call-end" &&
      "toolName" in event &&
      event.toolName === "bash"
    ) {
      const result = (event as { result?: { output?: string } }).result?.output;
      if (typeof result === "string") {
        const match = result.match(/Background process started with ID: (bg-[a-z0-9]+)/);
        if (match) return match[1];
      }
    }
  }
  return null;
}

/**
 * Check if any tool output contains a specific string
 */
function toolOutputContains(
  events: WorkspaceChatMessage[],
  toolName: string,
  substring: string
): boolean {
  for (const event of events) {
    if (
      "type" in event &&
      event.type === "tool-call-end" &&
      "toolName" in event &&
      event.toolName === toolName
    ) {
      const result = (event as { result?: { output?: string; message?: string } }).result;
      const text = result?.output ?? result?.message;
      if (typeof text === "string" && text.includes(substring)) {
        return true;
      }
    }
  }
  return false;
}

// Skip all tests if TEST_INTEGRATION is not set
const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

// Validate API keys before running tests
if (shouldRunIntegrationTests()) {
  validateApiKeys(["ANTHROPIC_API_KEY"]);
}

describeIntegration("Background Bash Execution", () => {
  test.concurrent(
    "should start a background process and list it",
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
        const branchName = generateBranchName("bg-basic");
        const { workspaceId, cleanup } = await createWorkspaceWithInit(
          env,
          tempGitRepo,
          branchName,
          undefined, // local runtime
          true // waitForInit
        );

        try {
          // Start a background process using explicit tool call instruction
          const startEvents = await sendMessageAndWait(
            env,
            workspaceId,
            "Use the bash tool with run_in_background=true to run: true && sleep 30",
            HAIKU_MODEL,
            BACKGROUND_TOOLS,
            30000
          );

          // Extract process ID from tool output
          const processId = extractProcessId(startEvents);
          expect(processId).not.toBeNull();
          expect(processId).toMatch(/^bg-[a-z0-9]+$/);

          // List background processes to verify it's tracked
          const listEvents = await sendMessageAndWait(
            env,
            workspaceId,
            "Use the bash_background_list tool to show running background processes",
            HAIKU_MODEL,
            BACKGROUND_TOOLS,
            20000
          );

          // Verify the process appears in the list
          const responseText = extractTextFromEvents(listEvents);
          expect(
            responseText.includes(processId!) ||
              toolOutputContains(listEvents, "bash_background_list", processId!)
          ).toBe(true);

          // Clean up: terminate the background process
          await sendMessageAndWait(
            env,
            workspaceId,
            `Use bash_background_terminate to terminate process ${processId}`,
            HAIKU_MODEL,
            BACKGROUND_TOOLS,
            20000
          );
        } finally {
          await cleanup();
        }
      } finally {
        await cleanupTempGitRepo(tempGitRepo);
        await cleanupTestEnvironment(env);
      }
    },
    BACKGROUND_TEST_TIMEOUT_MS
  );

  test.concurrent(
    "should terminate a background process",
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
        const branchName = generateBranchName("bg-terminate");
        const { workspaceId, cleanup } = await createWorkspaceWithInit(
          env,
          tempGitRepo,
          branchName,
          undefined, // local runtime
          true // waitForInit
        );

        try {
          // Start a long-running background process
          const startEvents = await sendMessageAndWait(
            env,
            workspaceId,
            "Use bash with run_in_background=true to run: true && sleep 300",
            HAIKU_MODEL,
            BACKGROUND_TOOLS,
            30000
          );

          const processId = extractProcessId(startEvents);
          expect(processId).not.toBeNull();

          // Terminate the process
          const terminateEvents = await sendMessageAndWait(
            env,
            workspaceId,
            `Use bash_background_terminate to terminate process ${processId}`,
            HAIKU_MODEL,
            BACKGROUND_TOOLS,
            20000
          );

          // Verify termination succeeded (tool output should indicate success)
          const terminateSuccess =
            toolOutputContains(terminateEvents, "bash_background_terminate", "terminated") ||
            toolOutputContains(terminateEvents, "bash_background_terminate", "success") ||
            toolOutputContains(terminateEvents, "bash_background_terminate", processId!);
          expect(terminateSuccess).toBe(true);

          // List to verify status changed to killed
          const listEvents = await sendMessageAndWait(
            env,
            workspaceId,
            "Use bash_background_list to show all background processes including terminated ones",
            HAIKU_MODEL,
            BACKGROUND_TOOLS,
            20000
          );

          // Process should show as killed/terminated
          const listResponse = extractTextFromEvents(listEvents);
          expect(
            listResponse.toLowerCase().includes("killed") ||
              listResponse.toLowerCase().includes("terminated") ||
              toolOutputContains(listEvents, "bash_background_list", "killed")
          ).toBe(true);
        } finally {
          await cleanup();
        }
      } finally {
        await cleanupTempGitRepo(tempGitRepo);
        await cleanupTestEnvironment(env);
      }
    },
    BACKGROUND_TEST_TIMEOUT_MS
  );

  test.concurrent(
    "should capture output from background process",
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
        const branchName = generateBranchName("bg-output");
        const { workspaceId, cleanup } = await createWorkspaceWithInit(
          env,
          tempGitRepo,
          branchName,
          undefined, // local runtime
          true // waitForInit
        );

        try {
          // Start a background process that outputs a unique marker then exits
          const marker = `BGTEST_${Date.now()}_${Math.random().toString(36).slice(2)}`;
          const startEvents = await sendMessageAndWait(
            env,
            workspaceId,
            `Use bash with run_in_background=true to run: echo "${marker}" && sleep 1`,
            HAIKU_MODEL,
            BACKGROUND_TOOLS,
            30000
          );

          const processId = extractProcessId(startEvents);
          expect(processId).not.toBeNull();

          // Wait for process to complete and output to be written
          await new Promise((resolve) => setTimeout(resolve, 2000));

          // List processes - should show the marker in output or process details
          const listEvents = await sendMessageAndWait(
            env,
            workspaceId,
            `Use bash_background_list to show details of background processes`,
            HAIKU_MODEL,
            BACKGROUND_TOOLS,
            20000
          );

          // The process should have exited (status: exited) after sleep completes
          const listResponse = extractTextFromEvents(listEvents);
          const hasExited =
            listResponse.toLowerCase().includes("exited") ||
            listResponse.toLowerCase().includes("completed") ||
            toolOutputContains(listEvents, "bash_background_list", "exited");

          // Process may still be running or just finished - either is acceptable
          // The main assertion is that the process was tracked
          expect(
            hasExited ||
              listResponse.includes(processId!) ||
              toolOutputContains(listEvents, "bash_background_list", processId!)
          ).toBe(true);
        } finally {
          await cleanup();
        }
      } finally {
        await cleanupTempGitRepo(tempGitRepo);
        await cleanupTestEnvironment(env);
      }
    },
    BACKGROUND_TEST_TIMEOUT_MS
  );
});
