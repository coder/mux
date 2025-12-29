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
  configureTestRetries,
  HAIKU_MODEL,
} from "./helpers";
import type { WorkspaceChatMessage } from "../../src/common/orpc/types";
import type { ToolPolicy } from "../../src/common/utils/tools/toolPolicy";

// Tool policies: Keep each step pinned to a single tool to avoid the LLM
// "helpfully" calling task_await early and consuming background output.
const BASH_ONLY: ToolPolicy = [
  { regex_match: ".*", action: "disable" },
  { regex_match: "bash", action: "require" },
];

const TASK_LIST_ONLY: ToolPolicy = [
  { regex_match: ".*", action: "disable" },
  { regex_match: "task_list", action: "require" },
];

const TASK_TERMINATE_ONLY: ToolPolicy = [
  { regex_match: ".*", action: "disable" },
  { regex_match: "task_terminate", action: "require" },
];

const TASK_AWAIT_ONLY: ToolPolicy = [
  { regex_match: ".*", action: "disable" },
  { regex_match: "task_await", action: "require" },
];

// Extended timeout for tests making multiple AI calls
const BACKGROUND_TEST_TIMEOUT_MS = 75000;

/**
 * Extract a bash taskId (e.g. "bash:<processId>") from bash(run_in_background=true) results.
 */
function extractBashTaskId(events: WorkspaceChatMessage[]): string | null {
  for (const event of events) {
    if (!("type" in event) || event.type !== "tool-call-end") continue;
    if (!("toolName" in event) || event.toolName !== "bash") continue;

    const taskId = (event as { result?: { taskId?: string } }).result?.taskId;
    if (typeof taskId !== "string") continue;

    const trimmed = taskId.trim();
    if (trimmed.startsWith("bash:")) return trimmed;
  }
  return null;
}

/**
 * Extract taskIds from a task_list tool result.
 */
function extractTaskListTaskIds(events: WorkspaceChatMessage[]): string[] {
  for (const event of events) {
    if (!("type" in event) || event.type !== "tool-call-end") continue;
    if (!("toolName" in event) || event.toolName !== "task_list") continue;

    const tasks = (event as { result?: { tasks?: Array<{ taskId?: string }> } }).result?.tasks;
    if (!Array.isArray(tasks)) return [];

    return tasks
      .map((t) => t.taskId)
      .filter((taskId): taskId is string => typeof taskId === "string");
  }
  return [];
}

/**
 * Collect output strings from task_await tool results.
 */
function collectTaskAwaitOutputs(events: WorkspaceChatMessage[]): string {
  const outputs: string[] = [];

  for (const event of events) {
    if (!("type" in event) || event.type !== "tool-call-end") continue;
    if (!("toolName" in event) || event.toolName !== "task_await") continue;

    const results = (
      event as { result?: { results?: Array<{ output?: string; reportMarkdown?: string }> } }
    ).result?.results;

    if (!Array.isArray(results)) continue;

    for (const result of results) {
      if (typeof result.output === "string" && result.output.length > 0) {
        outputs.push(result.output);
        continue;
      }
      if (typeof result.reportMarkdown === "string" && result.reportMarkdown.length > 0) {
        outputs.push(result.reportMarkdown);
      }
    }
  }

  return outputs.join("\n");
}

/**
 * Extract terminated task ids from a task_terminate tool result.
 */
function extractTerminatedTaskIds(events: WorkspaceChatMessage[]): string[] {
  for (const event of events) {
    if (!("type" in event) || event.type !== "tool-call-end") continue;
    if (!("toolName" in event) || event.toolName !== "task_terminate") continue;

    const results = (
      event as {
        result?: {
          results?: Array<{ status?: string; terminatedTaskIds?: string[] }>;
        };
      }
    ).result?.results;
    if (!Array.isArray(results)) return [];

    const terminated: string[] = [];
    for (const result of results) {
      if (result.status !== "terminated") continue;
      if (!Array.isArray(result.terminatedTaskIds)) continue;
      terminated.push(...result.terminatedTaskIds);
    }
    return terminated;
  }
  return [];
}

// Skip all tests if TEST_INTEGRATION is not set
const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

// Validate API keys before running tests
if (shouldRunIntegrationTests()) {
  validateApiKeys(["ANTHROPIC_API_KEY"]);
}

// Retry flaky tests in CI (API latency / rate limiting)
configureTestRetries(3);

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
          // Start a background bash process via bash(run_in_background=true)
          const startEvents = await sendMessageAndWait(
            env,
            workspaceId,
            'Use the bash tool with args: { script: "true && sleep 30", timeout_secs: 60, run_in_background: true, display_name: "bg-basic" }. Do not spawn a sub-agent.',
            HAIKU_MODEL,
            BASH_ONLY,
            30000
          );

          const taskId = extractBashTaskId(startEvents);
          expect(taskId).not.toBeNull();
          expect(taskId!.startsWith("bash:")).toBe(true);

          // List tasks to verify it's tracked
          const listEvents = await sendMessageAndWait(
            env,
            workspaceId,
            "Use task_list to show running tasks.",
            HAIKU_MODEL,
            TASK_LIST_ONLY,
            20000
          );

          const listedTaskIds = extractTaskListTaskIds(listEvents);
          expect(listedTaskIds).toContain(taskId!);

          // Clean up: terminate the background process
          const terminateEvents = await sendMessageAndWait(
            env,
            workspaceId,
            `Use task_terminate with task_ids: ["${taskId}"] to terminate the task.`,
            HAIKU_MODEL,
            TASK_TERMINATE_ONLY,
            20000
          );
          const terminatedTaskIds = extractTerminatedTaskIds(terminateEvents);
          expect(terminatedTaskIds).toContain(taskId!);
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
          // Start a long-running background bash task
          const startEvents = await sendMessageAndWait(
            env,
            workspaceId,
            'Use the bash tool with args: { script: "true && sleep 300", timeout_secs: 600, run_in_background: true, display_name: "bg-terminate" }. Do not spawn a sub-agent.',
            HAIKU_MODEL,
            BASH_ONLY,
            30000
          );

          const taskId = extractBashTaskId(startEvents);
          expect(taskId).not.toBeNull();

          // Terminate the task
          const terminateEvents = await sendMessageAndWait(
            env,
            workspaceId,
            `Use task_terminate with task_ids: ["${taskId}"] to terminate the task.`,
            HAIKU_MODEL,
            TASK_TERMINATE_ONLY,
            20000
          );

          const terminatedTaskIds = extractTerminatedTaskIds(terminateEvents);
          expect(terminatedTaskIds).toContain(taskId!);

          // List to verify the task remains discoverable (including reported)
          const listEvents = await sendMessageAndWait(
            env,
            workspaceId,
            'Use task_list with statuses: ["queued", "running", "awaiting_report", "reported"].',
            HAIKU_MODEL,
            TASK_LIST_ONLY,
            20000
          );

          const listedTaskIds = extractTaskListTaskIds(listEvents);
          expect(listedTaskIds).toContain(taskId!);
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
            `Use the bash tool with args: { script: "echo \"${marker}\" && sleep 1", timeout_secs: 30, run_in_background: true, display_name: "bg-output" }. Do not spawn a sub-agent.`,
            HAIKU_MODEL,
            BASH_ONLY,
            30000
          );

          const taskId = extractBashTaskId(startEvents);
          expect(taskId).not.toBeNull();

          // Wait for the process to complete and retrieve its output
          const awaitEvents = await sendMessageAndWait(
            env,
            workspaceId,
            `Use task_await with task_ids: ["${taskId}"] and timeout_secs: 10 to retrieve output.`,
            HAIKU_MODEL,
            TASK_AWAIT_ONLY,
            20000
          );

          const output = collectTaskAwaitOutputs(awaitEvents);
          expect(output).toContain(marker);
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
