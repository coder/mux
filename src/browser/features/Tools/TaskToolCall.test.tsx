import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";

import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";

import type { DisplayedMessage } from "@/common/types/message";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { computeTaskReportLinking } from "@/browser/utils/messages/taskReportLinking";

let workspaceContextMock: {
  workspaceMetadata: Map<string, FrontendWorkspaceMetadata>;
  setSelectedWorkspace?: (selection: unknown) => void;
} | null = null;

void mock.module("@/browser/contexts/WorkspaceContext", () => ({
  useOptionalWorkspaceContext: () => workspaceContextMock,
  toWorkspaceSelection: (workspace: FrontendWorkspaceMetadata) => workspace,
}));

void mock.module("./SubagentTranscriptDialog", () => ({
  SubagentTranscriptDialog: (props: { open: boolean; taskId: string }) =>
    props.open ? (
      <div data-testid="legacy-transcript">Legacy transcript: {props.taskId}</div>
    ) : null,
}));

void mock.module("./Shared/ElapsedTimeDisplay", () => ({
  ElapsedTimeDisplay: ({
    startedAt,
    isActive,
    prefix,
    separator,
  }: {
    startedAt: number | undefined;
    isActive: boolean;
    prefix?: string;
    separator?: string;
  }) => (
    <span
      data-testid="elapsed-time"
      data-active={String(isActive)}
      data-prefix={prefix ?? ""}
      data-separator={separator ?? " • "}
      data-started-at={startedAt == null ? "missing" : String(startedAt)}
    />
  ),
}));

import { getToolComponent } from "./Shared/getToolComponent";

const workspaceTaskArgs = {
  kind: "workspace" as const,
  prompt: "Investigate this issue in a separate workspace.",
  title: "Workspace investigation",
  run_in_background: true,
};
const TaskToolCall = getToolComponent("task", workspaceTaskArgs);

function createWorkspaceMetadata(
  overrides: Partial<FrontendWorkspaceMetadata> = {}
): FrontendWorkspaceMetadata {
  return {
    id: "workspace-1",
    name: "workspace-task",
    projectName: "project",
    projectPath: "/project",
    runtimeConfig: { type: "local" },
    namedWorkspacePath: "/project/workspace-task",
    ...overrides,
  };
}

const taskAwaitArgs = { task_ids: ["task-1"], timeout_secs: 70 };
const TaskAwaitToolCall = getToolComponent("task_await", taskAwaitArgs);

function createToolMessage(overrides: {
  toolName: string;
  args: unknown;
  result?: unknown;
}): DisplayedMessage {
  return {
    type: "tool",
    id: "tool-msg-1",
    historyId: "hist-1",
    toolCallId: "call-1",
    status: "completed",
    isPartial: false,
    historySequence: 1,
    ...overrides,
  };
}

function renderTaskAwaitToolCall(props: Record<string, unknown> = {}) {
  return render(
    <TooltipProvider>
      <TaskAwaitToolCall
        args={taskAwaitArgs}
        status="executing"
        startedAt={1_700_000_000_000}
        {...props}
      />
    </TooltipProvider>
  );
}

describe("TaskToolCall", () => {
  let originalWindow: typeof globalThis.window;
  let originalDocument: typeof globalThis.document;

  beforeEach(() => {
    originalWindow = globalThis.window;
    originalDocument = globalThis.document;

    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
  });

  afterEach(() => {
    workspaceContextMock = null;
    cleanup();
    mock.restore();
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
  });

  for (const scenario of [
    { kind: "agent", state: "running" },
    { kind: "agent", state: "completed" },
    { kind: "agent", state: "error" },
    { kind: "workspace", state: "running" },
    { kind: "workspace", state: "completed" },
    { kind: "workspace", state: "error" },
  ] as const) {
    test(`opens canonical ${scenario.state} ${scenario.kind} executions as ordinary workspaces`, () => {
      const taskId = `opaque-${scenario.kind}-${scenario.state}`;
      const workspace = createWorkspaceMetadata({
        id: `workspace-${scenario.kind}-${scenario.state}`,
        name: `workspace-branch-${scenario.state}`,
        title: `Workspace display ${scenario.state}`,
        projectName: "customer-platform",
        projectPath: "/projects/customer-platform",
        subProjectPath: "/projects/customer-platform/packages/frontend",
        taskStatus: scenario.state === "completed" ? "reported" : "running",
        taskLaunchError: scenario.state === "error" ? "Execution failed to launch." : undefined,
      });
      const setSelectedWorkspace = mock((selection: unknown) => {
        void selection;
      });
      workspaceContextMock = {
        workspaceMetadata: new Map([[workspace.id, workspace]]),
        setSelectedWorkspace,
      };

      const args =
        scenario.kind === "workspace"
          ? workspaceTaskArgs
          : {
              agentId: "exec",
              prompt: "Implement the navigation change.",
              title: `Execution title ${scenario.state}`,
              run_in_background: true,
            };
      const ScenarioTaskToolCall = getToolComponent("task", args);
      const result =
        scenario.state === "completed"
          ? {
              status: "completed" as const,
              taskId,
              workspaceId: workspace.id,
              handleKind: scenario.kind === "workspace" ? ("workspace_turn" as const) : undefined,
              reportMarkdown: "Finished.",
            }
          : {
              status: "running" as const,
              taskId,
              workspaceId: workspace.id,
              handleKind: scenario.kind === "workspace" ? ("workspace_turn" as const) : undefined,
              note: "Task started in background.",
            };

      const view = render(
        <TooltipProvider>
          <ScenarioTaskToolCall args={args} result={result} status="completed" />
        </TooltipProvider>
      );

      expect(view.getAllByRole("button", { name: "Open workspace" })).toHaveLength(1);
      expect(view.queryByText("View legacy transcript")).toBeNull();
      if (!view.queryByText(args.title)) {
        fireEvent.click(view.getByText("task"));
      }
      expect(view.getByText(args.title)).toBeDefined();
      expect(view.getByText(`workspace: ${workspace.title ?? workspace.name}`)).toBeDefined();
      expect(view.getByText("customer-platform / packages/frontend")).toBeDefined();
      fireEvent.click(view.getByRole("button", { name: "Open workspace" }));

      expect(setSelectedWorkspace).toHaveBeenCalledTimes(1);
      expect(setSelectedWorkspace.mock.calls[0][0]).toEqual(workspace);
    });
  }

  test("never treats an opaque taskId as a workspaceId", () => {
    const taskId = "opaque-task-id";
    const wrongWorkspace = createWorkspaceMetadata({ id: taskId, title: "Wrong workspace" });
    workspaceContextMock = {
      workspaceMetadata: new Map([[wrongWorkspace.id, wrongWorkspace]]),
      setSelectedWorkspace: mock(() => undefined),
    };

    const agentTaskArgs = {
      agentId: "exec",
      prompt: "Check target identity.",
      title: "Identity check",
      run_in_background: true,
    };
    const AgentTaskToolCall = getToolComponent("task", agentTaskArgs);
    const view = render(
      <TooltipProvider>
        <AgentTaskToolCall
          args={agentTaskArgs}
          result={{
            status: "running",
            taskId,
            workspaceId: "canonical-workspace-missing",
            note: "Task started in background.",
          }}
          status="completed"
        />
      </TooltipProvider>
    );

    expect(view.queryByRole("button", { name: "Open workspace" })).toBeNull();
    expect(view.queryByText("View legacy transcript")).toBeNull();
  });

  test("opens a legacy executionId live target instead of the transcript fallback", () => {
    const workspace = createWorkspaceMetadata({
      id: "legacy-live-workspace",
      executionId: "legacy-live-task",
    });
    const setSelectedWorkspace = mock((selection: unknown) => {
      void selection;
    });
    workspaceContextMock = {
      workspaceMetadata: new Map([[workspace.id, workspace]]),
      setSelectedWorkspace,
    };
    const agentTaskArgs = {
      agentId: "explore",
      prompt: "Inspect old history.",
      title: "Legacy live exploration",
      run_in_background: true,
    };
    const AgentTaskToolCall = getToolComponent("task", agentTaskArgs);
    const view = render(
      <TooltipProvider>
        <AgentTaskToolCall
          args={agentTaskArgs}
          result={{
            status: "completed",
            taskId: "legacy-live-task",
            reportMarkdown: "Legacy live report",
          }}
          status="completed"
        />
      </TooltipProvider>
    );

    expect(view.queryByText("View legacy transcript")).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "Open workspace" }));
    expect(setSelectedWorkspace.mock.calls[0][0]).toEqual(workspace);
  });

  test("keeps the historical transcript fallback for legacy completed tasks without a live target", () => {
    workspaceContextMock = { workspaceMetadata: new Map() };
    const agentTaskArgs = {
      agentId: "explore",
      prompt: "Inspect old history.",
      title: "Legacy exploration",
      run_in_background: true,
    };
    const AgentTaskToolCall = getToolComponent("task", agentTaskArgs);
    const view = render(
      <TooltipProvider>
        <AgentTaskToolCall
          args={agentTaskArgs}
          result={{
            status: "completed",
            taskId: "legacy-task",
            reportMarkdown: "Legacy report",
          }}
          status="completed"
        />
      </TooltipProvider>
    );

    fireEvent.click(view.getByText("task"));
    fireEvent.click(view.getByText("View legacy transcript"));
    expect(view.getByTestId("legacy-transcript").textContent).toContain("legacy-task");
  });

  test("opens an archived canonical transcript-only task target", () => {
    const workspace = createWorkspaceMetadata({
      id: "archived-transcript",
      executionId: "exe_archived_transcript",
      transcriptOnly: true,
      archivedAt: "2026-08-05T00:00:00.000Z",
    });
    const setSelectedWorkspace = mock((selection: unknown) => {
      void selection;
    });
    workspaceContextMock = {
      workspaceMetadata: new Map([[workspace.id, workspace]]),
      setSelectedWorkspace,
    };

    const view = render(
      <TooltipProvider>
        <TaskToolCall
          args={workspaceTaskArgs}
          result={{
            status: "completed",
            taskId: "exe_archived_transcript",
            workspaceId: workspace.id,
            handleKind: "workspace_turn",
            reportMarkdown: "Finished.",
          }}
          status="completed"
        />
      </TooltipProvider>
    );

    fireEvent.click(view.getByRole("button", { name: "Open workspace" }));
    expect(setSelectedWorkspace.mock.calls[0][0]).toEqual(workspace);
  });

  for (const unavailable of ["archived", "removing", "missing"] as const) {
    test(`hides canonical workspace navigation when the target is ${unavailable}`, () => {
      const workspaceId = `workspace-${unavailable}`;
      const workspace = createWorkspaceMetadata({
        id: workspaceId,
        executionId: `exe_${unavailable}`,
        archivedAt: unavailable === "archived" ? "2026-08-05T00:00:00.000Z" : undefined,
        isRemoving: unavailable === "removing" ? true : undefined,
      });
      workspaceContextMock = {
        workspaceMetadata:
          unavailable === "missing"
            ? new Map<string, FrontendWorkspaceMetadata>()
            : new Map([[workspace.id, workspace]]),
        setSelectedWorkspace: mock(() => undefined),
      };

      const view = render(
        <TooltipProvider>
          <TaskToolCall
            args={workspaceTaskArgs}
            result={{
              status: "running",
              taskId: `opaque-${unavailable}`,
              workspaceId,
              handleKind: "workspace_turn",
              note: "Task started in background.",
            }}
            status="completed"
          />
        </TooltipProvider>
      );

      expect(view.queryByRole("button", { name: "Open workspace" })).toBeNull();
      expect(view.queryByText("View legacy transcript")).toBeNull();
    });
  }

  test("surfaces progress interruptions from foreground task spawns", () => {
    const agentTaskArgs = {
      subagent_type: "explore",
      prompt: "Trace the report path.",
      title: "Trace reports",
      run_in_background: false,
    };
    const AgentTaskToolCall = getToolComponent("task", agentTaskArgs);
    const view = render(
      <TooltipProvider>
        <AgentTaskToolCall
          args={agentTaskArgs}
          result={{
            status: "running",
            taskId: "task-child-progress",
            interruption: {
              reason: "progress_report_received",
              sourceTaskId: "task-child-progress",
              report: {
                agentType: "explore",
                title: "Progress finding",
                reportMarkdown: "Found the report rendering path.",
              },
            },
            note: "Foreground wait paused because a queued message needs attention.",
          }}
          status="completed"
        />
      </TooltipProvider>
    );

    expect(view.getByText("Wait paused for subagent update")).toBeDefined();
    expect(view.getByText("Progress finding")).toBeDefined();
    expect(view.getByText("Found the report rendering path.")).toBeDefined();
    expect(view.queryByText("background")).toBeNull();
  });

  test("prefers live workspace settings over the result snapshot", () => {
    // A plan child's auto-handoff to exec rewrites live metadata after launch; the
    // result snapshot keeps the stale plan-phase settings.
    const workspace = createWorkspaceMetadata({
      id: "workspace-child-1",
      taskModelString: "anthropic:claude-opus-5",
      taskThinkingLevel: "high",
    });
    workspaceContextMock = {
      workspaceMetadata: new Map([[workspace.id, workspace]]),
    };

    const agentTaskArgs = {
      subagent_type: "plan",
      prompt: "Plan then implement.",
      title: "Plan task",
      run_in_background: true,
    };
    const AgentTaskToolCall = getToolComponent("task", agentTaskArgs);
    const view = render(
      <TooltipProvider>
        <AgentTaskToolCall
          args={agentTaskArgs}
          result={{
            status: "running",
            taskId: "opaque-task-child-1",
            workspaceId: workspace.id,
            modelString: "openai:gpt-5.2",
            thinkingLevel: "low",
            note: "Task started in background.",
          }}
          status="completed"
        />
      </TooltipProvider>
    );

    fireEvent.click(view.getByText("task"));

    const settings = view.container.querySelector("[data-task-ai-settings]");
    expect(settings?.textContent).toContain("Opus 5");
    expect(settings?.textContent).toContain("thinking: high");
    expect(settings?.textContent).not.toContain("thinking: low");
  });

  test("shows compact attach_file availability without duplicating previews", () => {
    const view = render(
      <TooltipProvider>
        <TaskToolCall
          args={workspaceTaskArgs}
          result={{
            status: "completed",
            taskId: "wst_artifacts",
            handleKind: "workspace_turn",
            workspaceId: "child-workspace",
            reportMarkdown: "Created the chart.",
            artifacts: {
              attachFiles: [
                {
                  path: "/owner/task-artifacts/wst_artifacts/chart.png",
                  filename: "chart.png",
                  mediaType: "image/png",
                  sourceToolCallId: "attach-chart",
                },
              ],
            },
          }}
          status="completed"
        />
      </TooltipProvider>
    );

    fireEvent.click(view.getByText("task"));

    expect(view.getByText("Attachment available: chart.png")).toBeDefined();
    expect(view.container.querySelector("img")).toBeNull();
  });

  test("prefers linked report settings over the spawn snapshot after cleanup", () => {
    // Workspace already cleaned up; the task_await-linked report carries the exec
    // settings while the spawn result kept the stale plan-phase ones.
    workspaceContextMock = { workspaceMetadata: new Map() };

    const agentTaskArgs = {
      subagent_type: "plan",
      prompt: "Plan then implement.",
      title: "Plan task",
      run_in_background: true,
    };
    const AgentTaskToolCall = getToolComponent("task", agentTaskArgs);
    const view = render(
      <TooltipProvider>
        <AgentTaskToolCall
          args={agentTaskArgs}
          result={{
            status: "running",
            taskId: "task-child-3",
            modelString: "openai:gpt-5.2",
            thinkingLevel: "low",
            note: "Task started in background.",
          }}
          taskReportLinking={{
            reportByTaskId: new Map([
              [
                "task-child-3",
                {
                  taskId: "task-child-3",
                  reportMarkdown: "done",
                  modelString: "anthropic:claude-opus-5",
                  thinkingLevel: "high",
                },
              ],
            ]),
            suppressReportInAwaitTaskIds: new Set(["task-child-3"]),
            spawnTitleByTaskId: new Map(),
          }}
          status="completed"
        />
      </TooltipProvider>
    );

    fireEvent.click(view.getByText("task"));

    const settings = view.container.querySelector("[data-task-ai-settings]");
    expect(settings?.textContent).toContain("Opus 5");
    expect(settings?.textContent).toContain("thinking: high");
    expect(settings?.textContent).not.toContain("thinking: low");
  });

  test("falls back to result-carried settings after workspace cleanup", () => {
    workspaceContextMock = { workspaceMetadata: new Map() };

    const agentTaskArgs = {
      subagent_type: "explore",
      prompt: "Look around.",
      title: "Explore task",
      run_in_background: true,
    };
    const AgentTaskToolCall = getToolComponent("task", agentTaskArgs);
    const view = render(
      <TooltipProvider>
        <AgentTaskToolCall
          args={agentTaskArgs}
          result={{
            status: "running",
            taskId: "task-child-2",
            modelString: "openai:gpt-5.2",
            thinkingLevel: "low",
            note: "Task started in background.",
          }}
          status="completed"
        />
      </TooltipProvider>
    );

    fireEvent.click(view.getByText("task"));

    const settings = view.container.querySelector("[data-task-ai-settings]");
    expect(settings?.textContent).toContain("thinking: low");
  });
});

describe("TaskAwaitToolCall", () => {
  let originalWindow: typeof globalThis.window;
  let originalDocument: typeof globalThis.document;

  beforeEach(() => {
    originalWindow = globalThis.window;
    originalDocument = globalThis.document;

    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
  });

  afterEach(() => {
    workspaceContextMock = null;
    cleanup();
    mock.restore();
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
  });

  test("shows elapsed time while task_await is executing", () => {
    const startedAt = 1_700_000_000_123;

    const view = renderTaskAwaitToolCall({ startedAt });

    const timer = view.getByTestId("elapsed-time");
    expect(timer.dataset.active).toBe("true");
    expect(timer.dataset.startedAt).toBe(String(startedAt));
    expect(timer.dataset.prefix).toBe("");
    expect(view.getByText("Waiting for 1 task")).toBeDefined();
    expect(timer.dataset.separator).toBe("");
  });

  test("summarizes completed polls without generic tool chrome", () => {
    const view = renderTaskAwaitToolCall({
      status: "completed",
      result: { results: [{ status: "running", taskId: "task-1" }] },
    });

    expect(view.getByText("Still waiting for 1 task")).toBeDefined();
    expect(view.queryByText("task_await")).toBeNull();
  });

  test("opens task_await canonical workspace targets without using the opaque taskId", () => {
    const workspace = createWorkspaceMetadata({
      id: "await-workspace",
      title: "Await target workspace",
      projectName: "customer-platform",
      projectPath: "/projects/customer-platform",
      subProjectPath: "/projects/customer-platform/packages/mobile",
    });
    const wrongWorkspace = createWorkspaceMetadata({
      id: "opaque-await-task",
      title: "Wrong opaque-ID workspace",
    });
    const setSelectedWorkspace = mock((selection: unknown) => {
      void selection;
    });
    workspaceContextMock = {
      workspaceMetadata: new Map([
        [workspace.id, workspace],
        [wrongWorkspace.id, wrongWorkspace],
      ]),
      setSelectedWorkspace,
    };

    const view = renderTaskAwaitToolCall({
      status: "completed",
      result: {
        results: [
          {
            status: "completed",
            taskId: "opaque-await-task",
            workspaceId: workspace.id,
            title: "Canonical await execution",
            reportMarkdown: "Done",
          },
        ],
      },
    });

    fireEvent.click(view.getByLabelText("1 task completed. Show task wait details"));
    expect(view.getByText("workspace: Await target workspace")).toBeDefined();
    expect(view.getByText("customer-platform / packages/mobile")).toBeDefined();
    expect(view.getAllByRole("button", { name: "Open workspace" })).toHaveLength(1);
    fireEvent.click(view.getByRole("button", { name: "Open workspace" }));

    expect(setSelectedWorkspace).toHaveBeenCalledTimes(1);
    expect(setSelectedWorkspace.mock.calls[0][0]).toEqual(workspace);
  });

  test("shows a compact attachment count for completed task awaits", () => {
    const view = renderTaskAwaitToolCall({
      status: "completed",
      result: {
        results: [
          {
            status: "completed",
            taskId: "task-1",
            reportMarkdown: "Done",
            artifacts: {
              attachFiles: [
                {
                  path: "/owner/task-artifacts/task-1/chart.png",
                  filename: "chart.png",
                  mediaType: "image/png",
                },
                {
                  path: "/owner/task-artifacts/task-1/report.pdf",
                  filename: "report.pdf",
                  mediaType: "application/pdf",
                },
              ],
            },
          },
        ],
      },
    });

    fireEvent.click(view.getByLabelText("1 task completed. Show task wait details"));
    expect(view.getByText("2 attachments available: chart.png +1")).toBeDefined();
    expect(view.container.querySelector("img")).toBeNull();
  });

  test("surfaces progress-report interruptions instead of presenting another wait", () => {
    const view = renderTaskAwaitToolCall({
      status: "completed",
      result: {
        results: [{ status: "running", taskId: "task-1" }],
        interruption: {
          reason: "progress_report_received",
          sourceTaskId: "task-1",
          report: {
            agentType: "explore",
            title: "Progress finding",
            reportMarkdown: "Found the report rendering path.",
          },
        },
      },
    });

    expect(view.getByText("Wait paused for subagent update")).toBeDefined();
    expect(view.getAllByText("Progress finding").length).toBeGreaterThan(0);
    expect(view.getByText("Found the report rendering path.")).toBeDefined();
    expect(view.queryByText(/still waiting/i)).toBeNull();
  });

  test("renders interrupted waits as terminal instead of still waiting", () => {
    const view = renderTaskAwaitToolCall({
      status: "completed",
      result: { results: [{ status: "interrupted", taskId: "task-1" }] },
    });

    expect(view.getByText("1 task interrupted")).toBeDefined();
    expect(view.queryByText(/still waiting/i)).toBeNull();
  });

  test("treats interrupted error rows as cancelled waits, not failed tasks", () => {
    const view = renderTaskAwaitToolCall({
      status: "completed",
      result: {
        results: [{ status: "error", taskId: "task-1", error: "Interrupted" }],
      },
    });

    expect(view.getByText("1 task interrupted")).toBeDefined();
    expect(view.queryByText("1 task failed")).toBeNull();
  });

  test("renders call-level interruption as terminal", () => {
    const view = renderTaskAwaitToolCall({ status: "interrupted", result: undefined });

    expect(view.getByText("Task wait interrupted")).toBeDefined();
    expect(view.queryByText("Checked task status")).toBeNull();
  });

  test("keeps active task counts visible beside interruptions", () => {
    const view = renderTaskAwaitToolCall({
      status: "completed",
      result: {
        results: [
          { status: "interrupted", taskId: "task-1" },
          { status: "running", taskId: "task-2" },
          { status: "queued", taskId: "task-3" },
        ],
      },
    });

    expect(view.getByText("1 task interrupted")).toBeDefined();
    expect(view.getByText(/2 tasks still active/)).toBeDefined();
  });

  test("surfaces call-level task_await failures", () => {
    const view = renderTaskAwaitToolCall({
      status: "failed",
      result: { success: false, error: "Task service unavailable" },
    });

    expect(view.getByText("Task wait failed")).toBeDefined();
    expect(view.getByText("Task service unavailable")).toBeDefined();
  });

  test("shows bash kind and spawn model_intent for a single completed bash task", () => {
    const bashSpawn = createToolMessage({
      toolName: "bash",
      args: {
        script: "./scripts/wait_pr_ready.sh 27330",
        display_name: "PR ready watcher",
        model_intent: "watching PR 27330 until it is ready",
        timeout_secs: 3600,
        run_in_background: true,
      },
      result: {
        success: true,
        output: "Started",
        exitCode: 0,
        wall_duration_ms: 10,
        taskId: "bash:pr-ready-watcher-a1b2",
        backgroundProcessId: "pr-ready-watcher-a1b2",
      },
    });

    const view = renderTaskAwaitToolCall({
      status: "completed",
      args: { task_ids: ["bash:pr-ready-watcher-a1b2"] },
      result: {
        results: [
          {
            status: "completed",
            taskId: "bash:pr-ready-watcher-a1b2",
            title: "PR ready watcher",
            reportMarkdown: "exit 0",
          },
        ],
      },
      taskReportLinking: computeTaskReportLinking([bashSpawn]),
    });

    expect(view.getByText("1 task completed")).toBeDefined();
    expect(view.getByText(/bash · Watching PR 27330 until it is ready/)).toBeDefined();
  });

  test("falls back to the task title when the spawn intent merely restates the command", () => {
    const bashSpawn = createToolMessage({
      toolName: "bash",
      args: {
        script: "git status",
        display_name: "Repo State",
        model_intent: "git status",
        timeout_secs: 30,
        run_in_background: true,
      },
      result: {
        success: true,
        output: "Started",
        exitCode: 0,
        wall_duration_ms: 10,
        taskId: "bash:repo-state-a1b2",
        backgroundProcessId: "repo-state-a1b2",
      },
    });

    const view = renderTaskAwaitToolCall({
      status: "completed",
      args: { task_ids: ["bash:repo-state-a1b2"] },
      result: {
        results: [
          {
            status: "completed",
            taskId: "bash:repo-state-a1b2",
            title: "Repo State",
            reportMarkdown: "exit 0",
          },
        ],
      },
      taskReportLinking: computeTaskReportLinking([bashSpawn]),
    });

    expect(view.getByText(/bash · Repo State/)).toBeDefined();
    expect(view.queryByText(/bash · Git status/)).toBeNull();
  });

  test("falls back to the completed task title when no spawn intent is linked", () => {
    const view = renderTaskAwaitToolCall({
      status: "completed",
      args: { task_ids: ["bash:pr-ready-watcher-a1b2"] },
      result: {
        results: [
          {
            status: "completed",
            taskId: "bash:pr-ready-watcher-a1b2",
            title: "PR ready watcher",
            reportMarkdown: "exit 0",
          },
        ],
      },
    });

    expect(view.getByText(/bash · PR ready watcher/)).toBeDefined();
  });

  test("shows agent type and title for a single completed sub-agent task", () => {
    const taskSpawn = createToolMessage({
      toolName: "task",
      args: {
        agentId: "explore",
        prompt: "Find pagination helpers.",
        title: "Pagination exploration",
        run_in_background: true,
      },
      result: { status: "queued", taskId: "task-1" },
    });

    const view = renderTaskAwaitToolCall({
      status: "completed",
      result: {
        results: [
          {
            status: "completed",
            taskId: "task-1",
            title: "Pagination exploration",
            reportMarkdown: "Report",
          },
        ],
      },
      taskReportLinking: computeTaskReportLinking([taskSpawn]),
    });

    expect(view.getByText(/explore · Pagination exploration/)).toBeDefined();
  });

  test("prefers the spawn title over the sub-agent's own report title", () => {
    const taskSpawn = createToolMessage({
      toolName: "task",
      args: {
        agentId: "explore",
        prompt: "Find pagination helpers.",
        title: "Pagination exploration",
        run_in_background: true,
      },
      result: { status: "queued", taskId: "task-1" },
    });

    const view = renderTaskAwaitToolCall({
      status: "completed",
      result: {
        results: [
          {
            status: "completed",
            taskId: "task-1",
            title: "Pagination Helpers Investigation Complete",
            reportMarkdown: "Report",
          },
        ],
      },
      taskReportLinking: computeTaskReportLinking([taskSpawn]),
    });

    expect(view.getByText(/explore · Pagination exploration/)).toBeDefined();
    expect(view.queryByText(/Investigation Complete/)).toBeNull();
  });

  test("shows each task's kind and intent for multi-task completions", () => {
    const bashSpawn = createToolMessage({
      toolName: "bash",
      args: {
        script: "./scripts/wait_pr_ready.sh 27330",
        display_name: "PR ready watcher",
        model_intent: "watching PR 27330 until it is ready",
        timeout_secs: 3600,
        run_in_background: true,
      },
      result: {
        success: true,
        output: "Started",
        exitCode: 0,
        wall_duration_ms: 10,
        taskId: "bash:pr-ready-watcher-a1b2",
        backgroundProcessId: "pr-ready-watcher-a1b2",
      },
    });
    const taskSpawn = createToolMessage({
      toolName: "task",
      args: {
        agentId: "explore",
        prompt: "Find pagination helpers.",
        title: "Pagination exploration",
        run_in_background: true,
      },
      result: { status: "queued", taskId: "task-1" },
    });

    const view = renderTaskAwaitToolCall({
      status: "completed",
      args: { task_ids: ["bash:pr-ready-watcher-a1b2", "task-1"] },
      result: {
        results: [
          {
            status: "completed",
            taskId: "bash:pr-ready-watcher-a1b2",
            title: "PR ready watcher",
            reportMarkdown: "exit 0",
          },
          {
            status: "completed",
            taskId: "task-1",
            title: "Pagination exploration",
            reportMarkdown: "Report",
          },
        ],
      },
      taskReportLinking: computeTaskReportLinking([bashSpawn, taskSpawn]),
    });

    expect(view.getByText("2 tasks completed")).toBeDefined();
    expect(view.getByText("bash · Watching PR 27330 until it is ready")).toBeDefined();
    expect(view.getByText("explore · Pagination exploration")).toBeDefined();
  });

  test("uses valid legacy agentType for task_await rows when agentId is invalid", () => {
    workspaceContextMock = {
      workspaceMetadata: new Map([
        [
          "workspace-1",
          {
            id: "workspace-1",
            executionId: "task-1",
            name: "agent_explore_task",
            projectName: "project",
            projectPath: "/project",
            runtimeConfig: { type: "local" },
            namedWorkspacePath: "/project/task",
            parentWorkspaceId: "parent-1",
            agentId: "???",
            agentType: "explore",
            taskStatus: "running",
          },
        ],
      ]),
    };

    const view = renderTaskAwaitToolCall();

    fireEvent.click(view.getByLabelText("Waiting for 1 task. Show task wait details"));

    expect(view.getByText("explore")).toBeDefined();
    expect(view.queryByText("???")).toBeNull();
  });
});

const taskSendMessageArgs = {
  task_id: "child-task",
  message: "Use the corrected API shape.",
};
const TaskSendMessageToolCall = getToolComponent("task_send_message", taskSendMessageArgs);

describe("TaskSendMessageToolCall", () => {
  let originalWindow: typeof globalThis.window;
  let originalDocument: typeof globalThis.document;

  beforeEach(() => {
    originalWindow = globalThis.window;
    originalDocument = globalThis.document;
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
  });

  afterEach(() => {
    cleanup();
    mock.restore();
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
  });

  test("shows the guidance and target when expanded", () => {
    const view = render(
      <TooltipProvider>
        <TaskSendMessageToolCall
          args={taskSendMessageArgs}
          status="completed"
          result={{ status: "queued", taskId: "child-task", queueDispatchMode: "tool-end" }}
        />
      </TooltipProvider>
    );

    expect(view.getByText("queued")).toBeDefined();
    expect(view.getByText("Sent guidance to")).toBeDefined();
    expect(view.getByText("child-task")).toBeDefined();
    fireEvent.click(view.getByText("Sent guidance to"));
    expect(view.getByText("Use the corrected API shape.")).toBeDefined();
  });

  test("does not claim rejected guidance was sent", () => {
    const view = render(
      <TooltipProvider>
        <TaskSendMessageToolCall
          args={taskSendMessageArgs}
          status="completed"
          result={{
            status: "not_active",
            taskId: "child-task",
            taskStatus: "reported",
            error: "Task already completed.",
          }}
        />
      </TooltipProvider>
    );

    expect(view.getByText("Could not send guidance to")).toBeDefined();
    expect(view.queryByText("Sent guidance to")).toBeNull();
  });
});

const taskTerminateArgs = { task_ids: ["wfr_x"] };
const TaskTerminateToolCall = getToolComponent("task_terminate", taskTerminateArgs);

describe("TaskTerminateToolCall", () => {
  let originalWindow: typeof globalThis.window;
  let originalDocument: typeof globalThis.document;

  beforeEach(() => {
    originalWindow = globalThis.window;
    originalDocument = globalThis.document;

    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
  });

  afterEach(() => {
    workspaceContextMock = null;
    cleanup();
    mock.restore();
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
  });

  test("summarizes interrupted workflow runs and reveals the note when expanded", () => {
    const note = "Workflow run interrupted durably; resume it with workflow_resume.";
    const view = render(
      <TooltipProvider>
        <TaskTerminateToolCall
          args={taskTerminateArgs}
          status="completed"
          result={{ results: [{ status: "interrupted", taskId: "wfr_x", note }] }}
        />
      </TooltipProvider>
    );

    // Interrupted workflow runs are a successful outcome, not a still-pending termination.
    expect(view.getByText("1 interrupted")).toBeDefined();
    expect(view.queryByText("1 to terminate")).toBeNull();
    expect(view.queryByText(note)).toBeNull();

    fireEvent.click(view.getByText("task_terminate"));

    expect(view.getByText(note)).toBeDefined();
    const badge = view.getByText("interrupted");
    expect(badge.className).toContain("text-interrupted");
  });
});
