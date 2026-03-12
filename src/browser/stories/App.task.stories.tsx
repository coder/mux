/**
 * Storybook stories for task tool components (task, task_apply_git_patch,
 * task_await, task_list, task_terminate) rendered as direct lightweight cards.
 */

import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ReactNode } from "react";
import { userEvent, waitFor, within } from "@storybook/test";
import { APIProvider } from "@/browser/contexts/API";
import { TaskApplyGitPatchToolCall } from "@/browser/features/Tools/TaskApplyGitPatchToolCall";
import {
  TaskAwaitToolCall,
  TaskListToolCall,
  TaskTerminateToolCall,
  TaskToolCall,
} from "@/browser/features/Tools/TaskToolCall";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";
import { lightweightMeta } from "./meta.js";

const meta = {
  ...lightweightMeta,
  title: "App/Task Tools",
  component: TaskToolCall,
} satisfies Meta<typeof TaskToolCall>;

export default meta;

type Story = StoryObj<typeof meta>;

function TaskStoryFrame(props: {
  children: ReactNode;
  client: ReturnType<typeof createMockORPCClient>;
}) {
  return (
    <APIProvider client={props.client}>
      <div className="bg-background min-h-screen p-6">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-3">{props.children}</div>
      </div>
    </APIProvider>
  );
}

/**
 * Full task workflow: spawn parallel tasks, list them, and await completion.
 */
export const TaskWorkflow: Story = {
  render: () => {
    const client = createMockORPCClient();

    return (
      <TaskStoryFrame client={client}>
        <TaskToolCall
          args={{
            subagent_type: "explore",
            prompt: "Analyze the frontend React components in src/browser/",
            title: "Frontend analysis",
            run_in_background: true,
          }}
          result={{
            status: "running",
            taskId: "task-fe-001",
            note: "Use task_await to monitor progress.",
          }}
          status="completed"
        />

        <TaskToolCall
          args={{
            subagent_type: "exec",
            prompt: "Run linting on the backend code in src/node/",
            title: "Backend linting",
            run_in_background: true,
          }}
          result={{
            status: "queued",
            taskId: "task-be-002",
            note: "Task is queued and will start shortly.",
          }}
          status="completed"
        />

        <TaskListToolCall
          args={{ statuses: ["running", "queued"] }}
          result={{
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
          }}
          status="completed"
        />

        <TaskAwaitToolCall
          args={{ task_ids: ["task-fe-001", "task-be-002"], timeout_secs: 30 }}
          result={{
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
                reportMarkdown: "Linting passed with **0 errors** and 3 warnings.",
              },
            ],
          }}
          status="completed"
        />
      </TaskStoryFrame>
    );
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    const awaitToolHeader = await canvas.findByText("task_await", { selector: "span" });
    await userEvent.click(awaitToolHeader);

    const noticeButton = await canvas.findByRole("button", { name: "View notice" });
    await userEvent.hover(noticeButton);

    await waitFor(() => {
      const tooltip = canvasElement.ownerDocument.querySelector('[role="tooltip"]');
      if (!tooltip) {
        throw new Error("Notice tooltip not shown");
      }
    });
  },
};

/**
 * Foreground `task` call executing with a visible taskId.
 */
export const TaskForegroundShowsTaskId: Story = {
  render: () => {
    const client = createMockORPCClient();

    return (
      <TaskStoryFrame client={client}>
        <TaskToolCall
          args={{
            subagent_type: "explore",
            prompt: "Open the child workspace as soon as it is created.",
            title: "Foreground task",
            run_in_background: false,
          }}
          result={{
            status: "running",
            taskId: "task-foreground-001",
            note: "Use task_await to monitor foreground progress.",
          }}
          status="executing"
        />
      </TaskStoryFrame>
    );
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const toolHeader = await canvas.findByText("task", { selector: "span" });
    await userEvent.click(toolHeader);
    await canvas.findByText("task-foreground-001");
  },
};

/**
 * task_await executing state: show awaited task IDs.
 */
export const TaskAwaitExecuting: Story = {
  render: () => {
    const client = createMockORPCClient();

    return (
      <TaskStoryFrame client={client}>
        <TaskAwaitToolCall
          args={{
            task_ids: ["task-fe-001", "bash:proc-123", "task-be-002"],
            timeout_secs: 30,
          }}
          status="executing"
        />
      </TaskStoryFrame>
    );
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const toolHeader = await canvas.findByText("task_await", { selector: "span" });
    await userEvent.click(toolHeader);
    await canvas.findByText("task-fe-001");
  },
};

/**
 * Completed task with full markdown report.
 */
export const TaskWithReport: Story = {
  render: () => {
    const client = createMockORPCClient();

    return (
      <TaskStoryFrame client={client}>
        <TaskToolCall
          workspaceId="ws-report"
          args={{
            subagent_type: "explore",
            prompt:
              "Find all test files in this project. Look for patterns like *.test.ts, *.spec.ts, and test directories.",
            title: "Exploring test file structure",
            run_in_background: true,
          }}
          result={{
            status: "completed",
            taskId: "task-abc123",
            title: "Test File Analysis",
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
          }}
          status="completed"
        />
      </TaskStoryFrame>
    );
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const toolHeader = await canvas.findByText("task", { selector: "span" });
    await userEvent.click(toolHeader);

    await waitFor(() => {
      const reportText = canvasElement.textContent ?? "";
      if (!reportText.includes("Found 47 test files")) {
        throw new Error("Expected report summary text was not rendered");
      }
    });
  },
};

/**
 * Best-of-n task card: coalesces duplicate prompts into one grouped chat card.
 */
export const BestOfTaskGroup: Story = {
  render: () => {
    const client = createMockORPCClient();

    return (
      <TaskStoryFrame client={client}>
        <TaskToolCall
          workspaceId="ws-best-of"
          args={{
            subagent_type: "explore",
            prompt: "Compare three implementation strategies for the sidebar grouping UI.",
            title: "Compare implementation strategies",
            run_in_background: false,
            n: 3,
          }}
          result={{
            status: "completed",
            taskIds: ["task-best-of-1", "task-best-of-2", "task-best-of-3"],
            reports: [
              {
                taskId: "task-best-of-1",
                title: "Option 1",
                agentId: "explore",
                agentType: "explore",
                reportMarkdown: "Focus on **shared helper utilities** for tree coalescing.",
              },
              {
                taskId: "task-best-of-2",
                title: "Option 2",
                agentId: "explore",
                agentType: "explore",
                reportMarkdown: "Prefer a **synthetic group row** with expandable candidates.",
              },
              {
                taskId: "task-best-of-3",
                title: "Option 3",
                agentId: "explore",
                agentType: "explore",
                reportMarkdown: "Keep the grouping logic **local to ProjectSidebar**.",
              },
            ],
          }}
          status="completed"
        />
      </TaskStoryFrame>
    );
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const toolHeader = await canvas.findByText("task", { selector: "span" });
    await userEvent.click(toolHeader);

    await waitFor(() => {
      const text = canvasElement.textContent ?? "";
      if (!text.includes("Best of 3")) {
        throw new Error("Expected grouped best-of task header to be rendered");
      }
      if (!text.includes("candidate 1") || !text.includes("candidate 3")) {
        throw new Error("Expected grouped candidates to be rendered");
      }
    });
  },
};

/**
 * Completed task with transcript viewer support.
 */
export const TaskTranscriptViewer: Story = {
  render: () => {
    const client = createMockORPCClient({
      subagentTranscripts: new Map([
        [
          "task-transcript-001",
          {
            messages: [],
            model: "openai:gpt-4o-mini",
            thinkingLevel: "medium",
          },
        ],
      ]),
    });

    return (
      <TaskStoryFrame client={client}>
        <TaskToolCall
          workspaceId="ws-task-transcript-viewer"
          args={{
            subagent_type: "explore",
            prompt: "Investigate the workspace cleanup flow",
            title: "Cleanup investigation",
            run_in_background: true,
          }}
          result={{
            status: "completed",
            taskId: "task-transcript-001",
            title: "Cleanup investigation",
            reportMarkdown:
              "Report is trimmed for brevity. Click **View transcript** to inspect the full chat.",
          }}
          status="completed"
        />
      </TaskStoryFrame>
    );
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    const toolHeader = await canvas.findByText("task", { selector: "span" });
    await userEvent.click(toolHeader);

    const viewTranscriptButton = await canvas.findByRole("button", {
      name: /view transcript/i,
    });
    await userEvent.click(viewTranscriptButton);

    await waitFor(() => {
      const dialog = canvasElement.ownerDocument.querySelector('[role="dialog"]');
      if (!dialog?.textContent?.includes("task-transcript-001")) {
        throw new Error("Transcript dialog not found");
      }
    });

    await waitFor(() => {
      const dialog = canvasElement.ownerDocument.querySelector('[role="dialog"]');
      if (!dialog?.textContent?.includes("Transcript is empty")) {
        throw new Error("Transcript content not rendered");
      }
    });
  },
};

/**
 * task_apply_git_patch states: executing, dry-run success, success, failure.
 */
export const TaskApplyGitPatchStates: Story = {
  render: () => {
    const client = createMockORPCClient();

    return (
      <TaskStoryFrame client={client}>
        <TaskApplyGitPatchToolCall
          args={{ task_id: "task-fe-001", dry_run: true, three_way: true }}
          status="executing"
        />

        <TaskApplyGitPatchToolCall
          args={{ task_id: "task-fe-001", dry_run: true, three_way: true }}
          result={{
            success: true,
            taskId: "task-fe-001",
            appliedCommits: [
              { subject: "feat: add Apply Patch tool UI" },
              { subject: "fix: render applied commit list" },
            ],
            dryRun: true,
            note: "Dry run succeeded; no commits were applied.",
          }}
          status="completed"
        />

        <TaskApplyGitPatchToolCall
          args={{ task_id: "task-fe-001", three_way: true }}
          result={{
            success: true,
            taskId: "task-fe-001",
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
          }}
          status="completed"
        />

        <TaskApplyGitPatchToolCall
          args={{ task_id: "task-fe-001", three_way: true }}
          result={{
            success: false,
            taskId: "task-fe-001",
            error: "Working tree is not clean.",
            note: "Commit/stash your changes (or pass force=true) before applying patches.",
          }}
          status="completed"
        />
      </TaskStoryFrame>
    );
  },
};

/**
 * task_apply_git_patch success: show applied commit list.
 */
export const TaskApplyGitPatchCommitList: Story = {
  render: () => {
    const client = createMockORPCClient();

    return (
      <TaskStoryFrame client={client}>
        <TaskApplyGitPatchToolCall
          args={{ task_id: "task-fe-001", three_way: true }}
          result={{
            success: true,
            taskId: "task-fe-001",
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
          }}
          status="completed"
        />
      </TaskStoryFrame>
    );
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const header = await canvas.findByText("Apply patch");
    await userEvent.click(header);

    await waitFor(() => {
      const text = canvasElement.textContent ?? "";
      if (!text.includes("feat: add Apply Patch tool UI")) {
        throw new Error("Expected commit subject not found: feat: add Apply Patch tool UI");
      }
      if (!text.includes("fix: render applied commit list")) {
        throw new Error("Expected commit subject not found: fix: render applied commit list");
      }
    });
  },
};

/**
 * task_apply_git_patch dry-run: show would-apply commit subjects (no SHAs).
 */
export const TaskApplyGitPatchDryRunCommitList: Story = {
  render: () => {
    const client = createMockORPCClient();

    return (
      <TaskStoryFrame client={client}>
        <TaskApplyGitPatchToolCall
          args={{ task_id: "task-fe-001", dry_run: true, three_way: true }}
          result={{
            success: true,
            taskId: "task-fe-001",
            appliedCommits: [
              { subject: "feat: add Apply Patch tool UI" },
              { subject: "fix: render applied commit list" },
            ],
            dryRun: true,
            note: "Dry run succeeded; no commits were applied.",
          }}
          status="completed"
        />
      </TaskStoryFrame>
    );
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const header = await canvas.findByText("Apply patch");
    await userEvent.click(header);

    await waitFor(() => {
      const text = canvasElement.textContent ?? "";
      if (!text.includes("feat: add Apply Patch tool UI")) {
        throw new Error("Expected commit subject not found: feat: add Apply Patch tool UI");
      }
      if (!text.includes("fix: render applied commit list")) {
        throw new Error("Expected commit subject not found: fix: render applied commit list");
      }
    });
  },
};

/**
 * Task termination and mixed error states.
 */
export const TaskErrorStates: Story = {
  render: () => {
    const client = createMockORPCClient();

    return (
      <TaskStoryFrame client={client}>
        <TaskToolCall
          args={{
            subagent_type: "bash",
            prompt: "Check system status and report back",
            title: "System check",
            run_in_background: false,
          }}
          result={{
            success: false,
            error: "Task.create: unknown agentId (bash). Built-in runnable agentIds: explore, exec",
          }}
          status="failed"
        />

        <TaskAwaitToolCall
          args={{ timeout_secs: 30 }}
          result={{
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
          }}
          status="completed"
        />

        <TaskTerminateToolCall
          args={{ task_ids: ["task-001", "task-002", "task-invalid"] }}
          result={{
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
          }}
          status="completed"
        />
      </TaskStoryFrame>
    );
  },
};
