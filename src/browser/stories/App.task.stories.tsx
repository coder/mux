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
  type ChatHandler,
} from "./storyHelpers";
import { waitForScrollStabilization } from "./storyPlayHelpers";
import {
  STABLE_TIMESTAMP,
  createUserMessage,
  createAssistantMessage,
  createBashTool,
  createPendingTool,
  createPendingTaskTool,
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
import type { MuxMessage } from "@/common/types/message";
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
 * Foreground `task` tool call executing: the tool result isn't available yet, but we
 * still show the spawned `taskId` via the UI-only `task-created` stream event.
 */
export const TaskForegroundShowsTaskId: AppStory = {
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

        const taskWorkspaceId = "task-foreground-001";
        const toolCallId = "tc-foreground-1";

        const taskWorkspace = {
          ...createWorkspace({
            id: taskWorkspaceId,
            name: taskWorkspaceId,
            projectName,
          }),
          parentWorkspaceId: workspaceId,
          agentType: "explore",
          taskStatus: "running" as const,
          title: "Foreground task",
        };

        const workspaces = [mainWorkspace, taskWorkspace];

        selectWorkspace(mainWorkspace);
        collapseRightSidebar();

        const messages = [
          createUserMessage("u1", "Spawn a foreground task", { historySequence: 1 }),
          createAssistantMessage("a1", "Spawning… (foreground)", {
            historySequence: 2,
            toolCalls: [
              createPendingTaskTool(toolCallId, {
                subagent_type: "explore",
                prompt: "Open the child workspace as soon as it is created.",
                title: "Foreground task",
                run_in_background: false,
              }),
            ],
          }),
        ];

        const chatHandlers = new Map<string, ChatHandler>([
          [
            workspaceId,
            (emit) => {
              const timeoutId = setTimeout(() => {
                for (const msg of messages) {
                  emit(msg);
                }

                emit({ type: "caught-up" });

                emit({
                  type: "task-created",
                  workspaceId,
                  toolCallId,
                  taskId: taskWorkspaceId,
                  timestamp: STABLE_TIMESTAMP,
                });
              }, 50);

              return () => clearTimeout(timeoutId);
            },
          ],
        ]);

        return createMockORPCClient({
          projects: groupWorkspacesByProject(workspaces),
          workspaces,
          onChat: createOnChatAdapter(chatHandlers),
        });
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    await waitForScrollStabilization(canvasElement);

    const storyRoot = document.getElementById("storybook-root") ?? canvasElement;
    const canvas = within(storyRoot);

    // Expand the tool card so the taskId is visible.
    const toolTitle = await canvas.findByText("task", {}, { timeout: 8000 });
    await userEvent.click(toolTitle);

    await canvas.findByText("task-foreground-001", {}, { timeout: 8000 });
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
    const storyRoot = document.getElementById("storybook-root") ?? canvasElement;
    await waitForScrollStabilization(storyRoot);

    // Expand the tool card so the awaited-task preview is visible.
    //
    // Scope to the message window so we don't accidentally click unrelated disclosure arrows
    // in the sidebars.
    const messageWindow = storyRoot.querySelector('[data-testid="message-window"]');
    if (!(messageWindow instanceof HTMLElement)) {
      throw new Error("Message window not found");
    }

    const canvas = within(messageWindow);

    // Expand the tool card so the awaited-task preview is visible.
    //
    // Best-effort: this story is primarily for Chromatic snapshots, and Storybook test-runner
    // can be sensitive to navigation/hit-testing differences between local and CI.
    if (!messageWindow.textContent?.includes("task-fe-001")) {
      const toolName = canvas.queryByText("task_await");
      const header = toolName?.closest("div.cursor-pointer");
      if (header instanceof HTMLElement) {
        header.click();

        // One RAF to let any pending coalesced scroll complete after tool expansion.
        await new Promise((r) => requestAnimationFrame(r));
      }
    }
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
 * Completed task with an archived transcript.
 *
 * Verifies the transcript viewer dialog renders messages loaded via workspace.getSubagentTranscript.
 */
export const TaskTranscriptViewer: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        const taskId = "task-transcript-001";

        const transcriptMessages: MuxMessage[] = [
          createUserMessage("tu1", "Summarize the workspace cleanup flow.", {
            historySequence: 1,
          }),
          createAssistantMessage("ta1", "Here's what happens during cleanup:", {
            historySequence: 2,
            toolCalls: [
              createBashTool(
                "tcb1",
                "ls -la",
                "total 0\n-rw-r--r-- 1 user group 0 Jan 1 00:00 chat.jsonl",
                0
              ),
            ],
          }),
        ];

        return setupSimpleChatStory({
          workspaceId: "ws-task-transcript-viewer",
          messages: [
            createUserMessage("u1", "Show me the completed task transcript", {
              historySequence: 1,
            }),
            createAssistantMessage("a1", "Here's the task result:", {
              historySequence: 2,
              toolCalls: [
                createCompletedTaskTool("tc1", {
                  subagent_type: "explore",
                  prompt: "Investigate the workspace cleanup flow",
                  title: "Cleanup investigation",
                  taskId,
                  reportMarkdown:
                    "Report is trimmed for brevity. Click **View transcript** to inspect the full chat.",
                  reportTitle: "Cleanup investigation",
                }),
              ],
            }),
          ],
          subagentTranscripts: new Map([
            [
              taskId,
              {
                messages: transcriptMessages,
                model: "openai:gpt-4o-mini",
                thinkingLevel: "medium",
              },
            ],
          ]),
        });
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    await waitForScrollStabilization(canvasElement);

    const taskId = "task-transcript-001";
    const canvas = within(canvasElement);

    // TaskToolCall cards are collapsed by default. The task id + "View transcript" button
    // only render once the tool card is expanded.
    const taskToolPrompt = "Investigate the workspace cleanup flow";
    const promptPreview = canvas.getByText(taskToolPrompt);
    const toolContainer = promptPreview.parentElement;
    if (!(toolContainer instanceof HTMLElement)) {
      throw new Error("Task tool container not found");
    }

    await userEvent.click(within(toolContainer).getByText("task", { selector: "span" }));

    // Find the transcript button associated with our specific task.
    // The app may render multiple tasks (and multiple "View transcript" buttons).
    const taskIdButton = await waitFor(() => {
      const button = canvas.queryByRole("button", { name: taskId });
      if (!button) {
        throw new Error(`Task id button not rendered yet: ${taskId}`);
      }
      return button;
    });

    let viewTranscriptButton: HTMLElement | null = null;
    let searchNode: HTMLElement | null = taskIdButton;

    while (searchNode) {
      const candidate = within(searchNode).queryByRole("button", {
        name: /view transcript/i,
      });
      if (candidate) {
        viewTranscriptButton = candidate;
        break;
      }
      searchNode = searchNode.parentElement;
    }

    if (!viewTranscriptButton) {
      throw new Error(`View transcript button not found for task ${taskId}`);
    }

    await userEvent.click(viewTranscriptButton);

    // Dialog content is portaled outside the canvasElement, but inside the iframe body.
    // Wait for the dialog to appear, then for messages to render.
    // Both steps re-query the DOM to avoid stale refs if the portal re-mounts.
    await waitFor(() => {
      const dialog = Array.from(
        canvasElement.ownerDocument.body.querySelectorAll('[role="dialog"]')
      ).find((el) => el.textContent?.includes(taskId));
      if (!dialog) {
        throw new Error("Transcript dialog not found");
      }
      // MessageRenderer renders each message inside a MessageWindow with data-message-block.
      if (dialog.querySelectorAll("[data-message-block]").length === 0) {
        const debugText = dialog.textContent?.trim().slice(0, 200) ?? "<no text>";
        throw new Error(`Transcript messages not rendered. Dialog text: ${debugText}`);
      }
    });
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
          workspaceId: "ws-task-apply-git-patch-states",
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
                    appliedCommits: [
                      { subject: "feat: add Apply Patch tool UI" },
                      { subject: "fix: render applied commit list" },
                    ],
                    dryRun: true,
                    note: "Dry run succeeded; no commits were applied.",
                  },
                }),
                createTaskApplyGitPatchTool("tc3", {
                  task_id: "task-fe-001",
                  three_way: true,
                  output: {
                    success: true,
                    appliedCommits: [
                      {
                        sha: "0f1e2d3c4b5a69788796a5b4c3d2e1f0a9b8c7d6",
                        subject: "feat: add Apply Patch tool UI",
                      },
                      {
                        sha: "d7a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9",
                        subject: "fix: render applied commit list",
                      },
                    ],
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

async function playTaskApplyGitPatchCommitListStory(
  canvasElement: HTMLElement,
  opts: { expectedAssistantText: string }
): Promise<void> {
  const getMessageWindow = (): HTMLElement => {
    // `canvasElement` can be a stale reference if Storybook is in the middle of transitioning
    // between stories. Query the iframe document directly so we always see the current story DOM.
    const candidates = Array.from(
      canvasElement.ownerDocument.querySelectorAll('[data-testid="message-window"]')
    ).filter((candidate): candidate is HTMLElement => candidate instanceof HTMLElement);

    const match = candidates.find((candidate) =>
      candidate.textContent?.includes(opts.expectedAssistantText)
    );

    if (match) {
      return match;
    }

    const debugUrl = window.location.href;
    const debugText = candidates.at(0)?.textContent?.trim().slice(0, 200) ?? "<no text>";

    throw new Error(
      `Story not loaded yet: missing "${opts.expectedAssistantText}" (url=${debugUrl}, windows=${candidates.length}, firstText=${JSON.stringify(
        debugText
      )})`
    );
  };

  const isExpanded = (header: HTMLElement): boolean =>
    header.querySelector("span.rotate-90") !== null;

  const getToolHeader = (): HTMLElement => {
    const messageWindow = getMessageWindow();
    const matches = Array.from(messageWindow.querySelectorAll("div.cursor-pointer")).filter(
      (candidate) =>
        candidate.textContent?.includes("Apply patch") &&
        candidate.textContent?.includes("task-fe-001")
    );

    const header = matches.at(-1);
    if (!(header instanceof HTMLElement)) {
      throw new Error("Apply patch tool header not found");
    }

    return header;
  };

  // Storybook test-runner can race navigation between stories.
  // Guard on a story-specific text node to ensure the intended story is rendered.
  const toolHeader = await waitFor(
    () => {
      const messageWindow = getMessageWindow();
      if (messageWindow.getAttribute("data-loaded") !== "true") {
        throw new Error("Messages not loaded yet");
      }

      return getToolHeader();
    },
    // Leave headroom under the default per-story Jest timeout.
    { timeout: 12000 }
  );

  // Tool cards are collapsed by default; ensure the card is expanded so the commit subjects render.
  if (!isExpanded(toolHeader)) {
    // Best-effort: direct click is less sensitive to hit-testing differences than userEvent.
    getToolHeader().click();
  }

  await waitFor(() => {
    const currentToolHeader = getToolHeader();
    if (!isExpanded(currentToolHeader)) {
      throw new Error("Apply patch tool did not expand");
    }

    const text = getMessageWindow().textContent ?? "";
    const missing: string[] = [];

    if (!text.includes("feat: add Apply Patch tool UI")) {
      missing.push("feat: add Apply Patch tool UI");
    }

    if (!text.includes("fix: render applied commit list")) {
      missing.push("fix: render applied commit list");
    }

    if (missing.length > 0) {
      throw new Error(`Expected commit subject not found: ${missing.join(", ")}`);
    }
  });
}

/**
 * task_apply_git_patch success: show applied commit list.
 *
 * Chromatic note: this story expands the tool card so the commit list is visible.
 */
export const TaskApplyGitPatchCommitList: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          workspaceId: "ws-task-apply-git-patch-commit-list",
          messages: [
            createUserMessage("u1", "Apply the patch from task-fe-001", { historySequence: 1 }),
            createAssistantMessage("a1", "Applied the patch.", {
              historySequence: 2,
              toolCalls: [
                createTaskApplyGitPatchTool("tc1", {
                  task_id: "task-fe-001",
                  three_way: true,
                  output: {
                    success: true,
                    appliedCommits: [
                      {
                        sha: "0f1e2d3c4b5a69788796a5b4c3d2e1f0a9b8c7d6",
                        subject: "feat: add Apply Patch tool UI",
                      },
                      {
                        sha: "d7a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9",
                        subject: "fix: render applied commit list",
                      },
                    ],
                    headCommitSha: "d7a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9",
                  },
                }),
              ],
            }),
          ],
        })
      }
    />
  ),
  play: async ({ canvasElement }) => {
    await playTaskApplyGitPatchCommitListStory(canvasElement, {
      expectedAssistantText: "Applied the patch.",
    });
  },
};

/**
 * task_apply_git_patch dry-run: show would-apply commit subjects (no SHAs).
 *
 * Chromatic note: this story expands the tool card so the commit list is visible.
 */
export const TaskApplyGitPatchDryRunCommitList: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          workspaceId: "ws-task-apply-git-patch-dry-run-commit-list",
          messages: [
            createUserMessage("u1", "Dry-run the patch from task-fe-001", { historySequence: 1 }),
            createAssistantMessage("a1", "Dry-run succeeded.", {
              historySequence: 2,
              toolCalls: [
                createTaskApplyGitPatchTool("tc1", {
                  task_id: "task-fe-001",
                  dry_run: true,
                  three_way: true,
                  output: {
                    success: true,
                    appliedCommits: [
                      { subject: "feat: add Apply Patch tool UI" },
                      { subject: "fix: render applied commit list" },
                    ],
                    dryRun: true,
                    note: "Dry run succeeded; no commits were applied.",
                  },
                }),
              ],
            }),
          ],
        })
      }
    />
  ),
  play: async ({ canvasElement }) => {
    await playTaskApplyGitPatchCommitListStory(canvasElement, {
      expectedAssistantText: "Dry-run succeeded.",
    });
  },
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
