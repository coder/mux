/**
 * Storybook stories for task tool components (task, task_apply_git_patch, task_await, task_list, task_terminate).
 * Consolidated to capture all visual states in minimal stories.
 */

import { appMeta, AppWithMocks, type AppStory } from "./meta.js";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";
import {
  collapseRightSidebar,
  createOnChatAdapter,
  selectWorkspace,
  setupSimpleChatStory,
} from "./storyHelpers";
import { waitForScrollStabilization } from "./storyPlayHelpers";
import {
  STABLE_TIMESTAMP,
  createUserMessage,
  createAssistantMessage,
  createPendingTool,
  createStaticChatHandler,
  createTaskTool,
  createCompletedTaskTool,
  createFailedTaskTool,
  createTaskApplyGitPatchTool,
  createTaskAwaitTool,
  createTaskListTool,
  createTaskTerminateTool,
  createWorkspace,
  groupWorkspacesByProject,
} from "./mockFactory";
import { userEvent, waitFor, within } from "@storybook/test";

export default {
  ...appMeta,
  title: "App/Task Tools",
};

/**
 * Full task workflow: spawn parallel tasks, list them, await results.
 * Demonstrates retroactive report placement (reports render under the original `task` cards).
 */
export const TaskWorkflow: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          messages: [
            // User kicks off parallel analysis
            createUserMessage("u1", "Analyze the frontend and backend code", {
              historySequence: 1,
            }),
            createAssistantMessage("a1", "I'll spawn parallel tasks for analysis.", {
              historySequence: 2,
              toolCalls: [
                createTaskTool("tc1", {
                  subagent_type: "explore",
                  prompt: "Analyze the frontend React components in src/browser/",
                  title: "Frontend analysis",
                  run_in_background: true,
                  taskId: "task-fe-001",
                  status: "running",
                }),
                createTaskTool("tc2", {
                  subagent_type: "exec",
                  prompt: "Run linting on the backend code in src/node/",
                  title: "Backend linting",
                  run_in_background: true,
                  taskId: "task-be-002",
                  status: "queued",
                }),
              ],
            }),
            // User checks task status
            createUserMessage("u2", "What tasks are running?", { historySequence: 3 }),
            createAssistantMessage("a2", "Here are the active tasks:", {
              historySequence: 4,
              toolCalls: [
                createTaskListTool("tc3", {
                  statuses: ["running", "queued"],
                  tasks: [
                    {
                      taskId: "task-fe-001",
                      status: "running",
                      parentWorkspaceId: "ws-main",
                      agentType: "explore",
                      title: "Frontend analysis",
                      depth: 0,
                    },
                    {
                      taskId: "task-be-002",
                      status: "queued",
                      parentWorkspaceId: "ws-main",
                      agentType: "exec",
                      title: "Backend linting",
                      depth: 0,
                    },
                  ],
                }),
              ],
            }),
            // User waits for results
            createUserMessage("u3", "Wait for all tasks to complete", { historySequence: 5 }),
            createAssistantMessage("a3", "Both tasks have completed.", {
              historySequence: 6,
              toolCalls: [
                createTaskAwaitTool("tc4", {
                  task_ids: ["task-fe-001", "task-be-002"],
                  results: [
                    {
                      taskId: "task-fe-001",
                      status: "completed",
                      title: "Frontend Analysis",
                      reportMarkdown: `Found **23 React components** using hooks and TypeScript.

Key patterns:
- Context providers for state management
- Custom hooks for reusable logic`,
                      note: "NOTICE: This report was trimmed for display.\nOpen the task workspace for full context.",
                    },
                    {
                      taskId: "task-be-002",
                      status: "completed",
                      title: "Backend Linting",
                      reportMarkdown: `Linting passed with **0 errors** and 3 warnings.`,
                    },
                  ],
                }),
              ],
            }),
          ],
        })
      }
    />
  ),
  play: async ({ canvasElement }) => {
    await waitForScrollStabilization(canvasElement);

    const noticeButton = canvasElement.querySelector('button[aria-label="View notice"]');
    if (noticeButton instanceof HTMLElement) {
      await userEvent.hover(noticeButton);

      // Tooltip content is portaled to document.body.
      const doc = canvasElement.ownerDocument;
      await waitFor(() => {
        const tooltip = doc.querySelector('[role="tooltip"]');
        if (!tooltip) {
          throw new Error("Notice tooltip not shown");
        }
      });
    }
  },
};

/**
 * task_await executing state: show the awaited task IDs while waiting for completion.
 *
 * Chromatic note: this story expands the tool card so the awaited-task preview is visible.
 */
export const TaskAwaitExecuting: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        const workspaceId = "ws-main";
        const projectName = "my-app";

        const mainWorkspace = createWorkspace({
          id: workspaceId,
          name: "feature",
          projectName,
        });

        const taskFrontend = {
          ...createWorkspace({
            id: "task-fe-001",
            name: "task-fe-001",
            projectName,
          }),
          parentWorkspaceId: workspaceId,
          agentType: "explore",
          taskStatus: "running" as const,
          title: "Frontend analysis",
        };

        const taskBackend = {
          ...createWorkspace({
            id: "task-be-002",
            name: "task-be-002",
            projectName,
          }),
          parentWorkspaceId: workspaceId,
          agentType: "exec",
          taskStatus: "queued" as const,
          title: "Backend linting",
        };

        const workspaces = [mainWorkspace, taskFrontend, taskBackend];

        // Select the main chat workspace.
        selectWorkspace(mainWorkspace);
        collapseRightSidebar();

        const messages = [
          createUserMessage("u1", "Wait for all tasks to complete", { historySequence: 1 }),
          createAssistantMessage("a1", "Waiting for tasks…", {
            historySequence: 2,
            toolCalls: [
              createPendingTool("tc1", "task_await", {
                task_ids: ["task-fe-001", "bash:proc-123", "task-be-002"],
                timeout_secs: 30,
              }),
            ],
          }),
        ];

        const chatHandlers = new Map([[workspaceId, createStaticChatHandler(messages)]]);

        const backgroundProcesses = new Map([
          [
            workspaceId,
            [
              {
                id: "proc-123",
                pid: 123,
                script: "sleep 10",
                displayName: "Background bash",
                startTime: STABLE_TIMESTAMP - 5000,
                status: "running" as const,
              },
            ],
          ],
        ]);

        return createMockORPCClient({
          projects: groupWorkspacesByProject(workspaces),
          workspaces,
          onChat: createOnChatAdapter(chatHandlers),
          backgroundProcesses,
        });
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    await waitForScrollStabilization(canvasElement);

    const storyRoot = document.getElementById("storybook-root") ?? canvasElement;
    const canvas = within(storyRoot);

    const toolTitle = await canvas.findByText("task_await", {}, { timeout: 8000 });
    await userEvent.click(toolTitle);

    await canvas.findByText("task-fe-001", {}, { timeout: 8000 });
  },
};

/**
 * Completed task with full markdown report.
 * Shows the expanded report view with rich content.
 */
export const TaskWithReport: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          messages: [
            createUserMessage("u1", "Find all the test files in this project", {
              historySequence: 1,
            }),
            createAssistantMessage("a1", "I'll spawn a sub-agent to explore the test files.", {
              historySequence: 2,
              toolCalls: [
                createCompletedTaskTool("tc1", {
                  subagent_type: "explore",
                  prompt:
                    "Find all test files in this project. Look for patterns like *.test.ts, *.spec.ts, and test directories.",
                  title: "Exploring test file structure",
                  taskId: "task-abc123",
                  reportMarkdown: `# Test File Analysis

Found **47 test files** across the project:

## Unit Tests (\`src/**/*.test.ts\`)
- 32 files covering components, hooks, and utilities
- Located in \`src/browser/\` and \`src/common/\`

## Integration Tests (\`tests/integration/\`)  
- 15 files for end-to-end scenarios
- Uses \`TEST_INTEGRATION=1\` environment variable

### Key Patterns
- Test files are co-located with implementation
- Uses \`bun test\` for unit tests
- Uses \`bun x jest\` for integration tests`,
                  reportTitle: "Test File Analysis",
                }),
              ],
            }),
          ],
        })
      }
    />
  ),
  play: async ({ canvasElement }) => {
    await waitForScrollStabilization(canvasElement);

    const noticeButton = canvasElement.querySelector('button[aria-label="View notice"]');
    if (noticeButton instanceof HTMLElement) {
      await userEvent.hover(noticeButton);

      // Tooltip content is portaled to document.body.
      const doc = canvasElement.ownerDocument;
      await waitFor(() => {
        const tooltip = doc.querySelector('[role="tooltip"]');
        if (!tooltip) {
          throw new Error("Notice tooltip not shown");
        }
      });
    }
  },
};

/**
 * task_apply_git_patch states: executing, dry-run success, success, failure.
 */
export const TaskApplyGitPatchStates: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          messages: [
            createUserMessage("u1", "Apply the patch from task-fe-001", { historySequence: 1 }),
            createAssistantMessage("a1", "Applying the patch artifact in a few different modes:", {
              historySequence: 2,
              toolCalls: [
                createPendingTool("tc1", "task_apply_git_patch", {
                  task_id: "task-fe-001",
                  dry_run: true,
                  three_way: true,
                }),
                createTaskApplyGitPatchTool("tc2", {
                  task_id: "task-fe-001",
                  dry_run: true,
                  three_way: true,
                  output: {
                    success: true,
                    appliedCommitCount: 2,
                    dryRun: true,
                    note: "Dry run succeeded; no commits were applied.",
                  },
                }),
                createTaskApplyGitPatchTool("tc3", {
                  task_id: "task-fe-001",
                  three_way: true,
                  output: {
                    success: true,
                    appliedCommitCount: 2,
                    headCommitSha: "d7a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9",
                  },
                }),
                createTaskApplyGitPatchTool("tc4", {
                  task_id: "task-fe-001",
                  three_way: true,
                  output: {
                    success: false,
                    error: "Working tree is not clean.",
                    note: "Commit/stash your changes (or pass force=true) before applying patches.",
                  },
                }),
              ],
            }),
          ],
        })
      }
    />
  ),
};

/**
 * Task termination and error states.
 * Shows task_terminate with mixed success/error results, task_await errors, and task spawn failures.
 */
export const TaskErrorStates: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          messages: [
            // Failed task spawn (invalid agentId)
            createUserMessage("u0", "Run a bash task to check the system", { historySequence: 1 }),
            createAssistantMessage("a0", "I'll spawn a task to check the system.", {
              historySequence: 2,
              toolCalls: [
                createFailedTaskTool("tc0", {
                  subagent_type: "bash",
                  prompt: "Check system status and report back",
                  title: "System check",
                  error:
                    "Task.create: unknown agentId (bash). Built-in runnable agentIds: explore, exec",
                }),
              ],
            }),
            // Check tasks with various error states
            createUserMessage("u1", "Check on my background tasks", { historySequence: 3 }),
            createAssistantMessage("a1", "Here's the status of your tasks:", {
              historySequence: 4,
              toolCalls: [
                createTaskAwaitTool("tc1", {
                  timeout_secs: 30,
                  results: [
                    {
                      taskId: "task-001",
                      status: "completed",
                      title: "Quick Analysis",
                      reportMarkdown: "Analysis complete. Found 5 issues.",
                    },
                    {
                      taskId: "task-002",
                      status: "running",
                    },
                    {
                      taskId: "task-404",
                      status: "not_found",
                    },
                    {
                      taskId: "task-err",
                      status: "error",
                      error: "Task crashed due to memory limit",
                    },
                  ],
                }),
              ],
            }),
            // Terminate tasks with mixed results
            createUserMessage("u2", "Stop all tasks", { historySequence: 5 }),
            createAssistantMessage("a2", "Some tasks could not be terminated:", {
              historySequence: 6,
              toolCalls: [
                createTaskTerminateTool("tc2", {
                  task_ids: ["task-001", "task-002", "task-invalid"],
                  results: [
                    {
                      taskId: "task-001",
                      status: "terminated",
                      terminatedTaskIds: ["task-001", "task-001-sub-a"],
                    },
                    {
                      taskId: "task-002",
                      status: "terminated",
                      terminatedTaskIds: ["task-002"],
                    },
                    {
                      taskId: "task-invalid",
                      status: "invalid_scope",
                    },
                  ],
                }),
              ],
            }),
          ],
        })
      }
    />
  ),
  play: async ({ canvasElement }) => {
    await waitForScrollStabilization(canvasElement);

    const noticeButton = canvasElement.querySelector('button[aria-label="View notice"]');
    if (noticeButton instanceof HTMLElement) {
      await userEvent.hover(noticeButton);

      // Tooltip content is portaled to document.body.
      const doc = canvasElement.ownerDocument;
      await waitFor(() => {
        const tooltip = doc.querySelector('[role="tooltip"]');
        if (!tooltip) {
          throw new Error("Notice tooltip not shown");
        }
      });
    }
  },
};
