/**
 * Storybook stories for task tool components (task, task_await, task_list, task_terminate).
 *
 * These stories showcase the various states and configurations of sub-agent task tools
 * in the full app context.
 */

import { appMeta, AppWithMocks, type AppStory } from "./meta.js";
import { setupSimpleChatStory } from "./storyHelpers";
import {
  createUserMessage,
  createAssistantMessage,
  createTaskTool,
  createCompletedTaskTool,
  createTaskAwaitTool,
  createTaskListTool,
  createTaskTerminateTool,
} from "./mockFactory";

export default {
  ...appMeta,
  title: "App/Task Tools",
};

// ═══════════════════════════════════════════════════════════════════════════════
// TASK TOOL (spawn sub-agent)
// ═══════════════════════════════════════════════════════════════════════════════

/** Task completed synchronously with a report */
export const TaskCompleted: AppStory = {
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
                  description: "Exploring test file structure",
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
                  title: "Test File Analysis",
                }),
              ],
            }),
          ],
        })
      }
    />
  ),
};

/** Task running in background */
export const TaskBackground: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          messages: [
            createUserMessage("u1", "Run the full test suite in the background", {
              historySequence: 1,
            }),
            createAssistantMessage("a1", "I'll spawn a background task to run the tests.", {
              historySequence: 2,
              toolCalls: [
                createTaskTool("tc1", {
                  subagent_type: "exec",
                  prompt: "Run the full test suite with `make test` and report the results",
                  description: "Running test suite",
                  run_in_background: true,
                  taskId: "task-xyz789",
                  status: "running",
                }),
              ],
            }),
          ],
        })
      }
    />
  ),
};

/** Task in queued state */
export const TaskQueued: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          messages: [
            createUserMessage("u1", "Analyze the codebase structure", { historySequence: 1 }),
            createAssistantMessage("a1", "Spawning an explore task to analyze the structure.", {
              historySequence: 2,
              toolCalls: [
                createTaskTool("tc1", {
                  subagent_type: "explore",
                  prompt: "Analyze the directory structure and report on the architecture",
                  taskId: "task-queued-001",
                  status: "queued",
                }),
              ],
            }),
          ],
        })
      }
    />
  ),
};

/** Multiple tasks spawned */
export const TaskMultiple: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          messages: [
            createUserMessage("u1", "Analyze both frontend and backend code", {
              historySequence: 1,
            }),
            createAssistantMessage("a1", "I'll spawn two parallel tasks for analysis.", {
              historySequence: 2,
              toolCalls: [
                createTaskTool("tc1", {
                  subagent_type: "explore",
                  prompt: "Analyze the frontend React components in src/browser/",
                  description: "Frontend analysis",
                  run_in_background: true,
                  taskId: "task-fe-001",
                  status: "running",
                }),
                createTaskTool("tc2", {
                  subagent_type: "explore",
                  prompt: "Analyze the backend Node.js code in src/node/",
                  description: "Backend analysis",
                  run_in_background: true,
                  taskId: "task-be-002",
                  status: "running",
                }),
              ],
            }),
          ],
        })
      }
    />
  ),
};

// ═══════════════════════════════════════════════════════════════════════════════
// TASK_AWAIT TOOL
// ═══════════════════════════════════════════════════════════════════════════════

/** Awaiting multiple tasks - all completed */
export const TaskAwaitAllCompleted: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          messages: [
            createUserMessage("u1", "Wait for all the analysis tasks", { historySequence: 1 }),
            createAssistantMessage("a1", "Both tasks have completed.", {
              historySequence: 2,
              toolCalls: [
                createTaskAwaitTool("tc1", {
                  task_ids: ["task-fe-001", "task-be-002"],
                  results: [
                    {
                      taskId: "task-fe-001",
                      status: "completed",
                      title: "Frontend Analysis",
                      reportMarkdown: `Found **23 React components** using hooks and TypeScript.

Key patterns:
- Context providers for state management
- Custom hooks for reusable logic
- Tailwind for styling`,
                    },
                    {
                      taskId: "task-be-002",
                      status: "completed",
                      title: "Backend Analysis",
                      reportMarkdown: `The backend uses **Express + tRPC** architecture.

Services:
- IPC handlers for Electron communication
- File system operations
- Git integration`,
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
};

/** Awaiting tasks with mixed statuses */
export const TaskAwaitMixedStatus: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          messages: [
            createUserMessage("u1", "Check on all my tasks", { historySequence: 1 }),
            createAssistantMessage("a1", "Here's the status of your tasks:", {
              historySequence: 2,
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
                      taskId: "task-003",
                      status: "queued",
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
          ],
        })
      }
    />
  ),
};

// ═══════════════════════════════════════════════════════════════════════════════
// TASK_LIST TOOL
// ═══════════════════════════════════════════════════════════════════════════════

/** Listing active tasks */
export const TaskListActive: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          messages: [
            createUserMessage("u1", "Show me all running tasks", { historySequence: 1 }),
            createAssistantMessage("a1", "Here are the active tasks:", {
              historySequence: 2,
              toolCalls: [
                createTaskListTool("tc1", {
                  statuses: ["running", "queued"],
                  tasks: [
                    {
                      taskId: "task-runner-001",
                      status: "running",
                      parentWorkspaceId: "ws-main",
                      agentType: "exec",
                      title: "Test Suite Runner",
                      depth: 0,
                    },
                    {
                      taskId: "task-analyze-002",
                      status: "running",
                      parentWorkspaceId: "ws-main",
                      agentType: "explore",
                      title: "Code Analysis",
                      depth: 0,
                    },
                    {
                      taskId: "task-sub-003",
                      status: "queued",
                      parentWorkspaceId: "task-runner-001",
                      agentType: "exec",
                      title: "Unit Test Batch",
                      depth: 1,
                    },
                    {
                      taskId: "task-deep-004",
                      status: "running",
                      parentWorkspaceId: "task-sub-003",
                      agentType: "explore",
                      depth: 2,
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
};

/** Empty task list */
export const TaskListEmpty: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          messages: [
            createUserMessage("u1", "List any background tasks", { historySequence: 1 }),
            createAssistantMessage("a1", "No active tasks found.", {
              historySequence: 2,
              toolCalls: [
                createTaskListTool("tc1", {
                  tasks: [],
                }),
              ],
            }),
          ],
        })
      }
    />
  ),
};

// ═══════════════════════════════════════════════════════════════════════════════
// TASK_TERMINATE TOOL
// ═══════════════════════════════════════════════════════════════════════════════

/** Terminating tasks successfully */
export const TaskTerminateSuccess: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          messages: [
            createUserMessage("u1", "Stop all running tasks", { historySequence: 1 }),
            createAssistantMessage("a1", "I've terminated the tasks and their descendants.", {
              historySequence: 2,
              toolCalls: [
                createTaskTerminateTool("tc1", {
                  task_ids: ["task-001", "task-002"],
                  results: [
                    {
                      taskId: "task-001",
                      status: "terminated",
                      terminatedTaskIds: ["task-001", "task-001-sub-a", "task-001-sub-b"],
                    },
                    {
                      taskId: "task-002",
                      status: "terminated",
                      terminatedTaskIds: ["task-002"],
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
};

/** Terminating with errors */
export const TaskTerminateErrors: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          messages: [
            createUserMessage("u1", "Terminate these tasks: task-a, task-b, task-c", {
              historySequence: 1,
            }),
            createAssistantMessage("a1", "Some tasks could not be terminated:", {
              historySequence: 2,
              toolCalls: [
                createTaskTerminateTool("tc1", {
                  task_ids: ["task-a", "task-b", "task-c"],
                  results: [
                    {
                      taskId: "task-a",
                      status: "terminated",
                      terminatedTaskIds: ["task-a"],
                    },
                    {
                      taskId: "task-b",
                      status: "not_found",
                    },
                    {
                      taskId: "task-c",
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
};
