import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ReactNode } from "react";
import { TaskApplyGitPatchToolCall } from "@/browser/features/Tools/TaskApplyGitPatchToolCall";
import { TaskToolCall } from "@/browser/features/Tools/TaskToolCall";
import { lightweightMeta } from "@/browser/stories/meta.js";

const meta = {
  ...lightweightMeta,
  title: "App/Chat/Tools/Task",
  component: TaskToolCall,
} satisfies Meta<typeof TaskToolCall>;

export default meta;

type Story = StoryObj<typeof meta>;

function ToolStoryShell(props: { children: ReactNode }) {
  return (
    <div className="bg-background p-6">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-3">{props.children}</div>
    </div>
  );
}

/** task cards in queued/running workflow states */
export const TaskWorkflowStates: Story = {
  render: () => (
    <ToolStoryShell>
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
          prompt: "Run linting on src/node/ and summarize the findings.",
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
    </ToolStoryShell>
  ),
};

/** completed task showing markdown report content */
export const TaskWithReport: Story = {
  render: () => (
    <ToolStoryShell>
      <TaskToolCall
        args={{
          subagent_type: "explore",
          prompt:
            "Find all test files in this project. Look for *.test.ts, *.spec.ts, and tests directories.",
          title: "Exploring test file structure",
          run_in_background: true,
        }}
        result={{
          status: "completed",
          taskId: "task-abc123",
          title: "Test File Analysis",
          reportMarkdown: `# Test File Analysis

Found **47 test files** across the project.

## Key Patterns
- Unit tests are co-located with implementation files.
- Integration tests live under \`tests/integration/\`.
- Most suites run through \`bun test\`.`,
        }}
        status="completed"
      />
    </ToolStoryShell>
  ),
};

/** best-of-n task group rendered as one grouped task card */
export const BestOfTaskGroup: Story = {
  render: () => (
    <ToolStoryShell>
      <TaskToolCall
        args={{
          subagent_type: "explore",
          prompt: "Compare three implementation strategies for sidebar grouping.",
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
              reportMarkdown: "Use **shared helper utilities** for tree coalescing.",
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
              reportMarkdown: "Keep grouping logic **local to ProjectSidebar**.",
            },
          ],
        }}
        status="completed"
      />
    </ToolStoryShell>
  ),
};

/** task_apply_git_patch states: executing, dry-run, success, and failure */
export const TaskApplyGitPatchStates: Story = {
  render: () => (
    <ToolStoryShell>
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
    </ToolStoryShell>
  ),
};
