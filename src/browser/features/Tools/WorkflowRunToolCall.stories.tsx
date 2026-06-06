import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";

import type { WorkflowRunRecord } from "@/common/types/workflow";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { APIContext } from "@/browser/contexts/API";
import { WorkflowRunToolCall } from "@/browser/features/Tools/WorkflowRunToolCall";
import { useWorkspaceStoreRaw } from "@/browser/stores/WorkspaceStore";
import { lightweightMeta } from "@/browser/stories/meta.js";

const storyApi = {
  workflows: {
    promoteScratch: (input: {
      name: string;
      description: string;
      location: "project" | "global";
    }) =>
      Promise.resolve({
        name: input.name,
        description: input.description,
        scope: input.location,
        sourcePath:
          input.location === "project"
            ? `/repo/.mux/workflows/${input.name}.js`
            : `~/.mux/workflows/${input.name}.js`,
        executable: true,
      }),
  },
};

function StoryAPIProvider(props: { children: ReactNode }) {
  return (
    <APIContext.Provider
      value={{
        status: "connected",
        api: storyApi as never,
        error: null,
        authenticate: () => undefined,
        retry: () => undefined,
      }}
    >
      {props.children}
    </APIContext.Provider>
  );
}

const meta = {
  ...lightweightMeta,
  title: "App/Chat/Tools/WorkflowRun",
  component: WorkflowRunToolCall,
} satisfies Meta<typeof WorkflowRunToolCall>;

export default meta;

type Story = StoryObj<typeof meta>;

export const CompletedDeepResearch: Story = {
  args: {
    args: {
      name: "deep-research",
      args: { topic: "workflow run cards" },
      run_in_background: false,
    },
    status: "completed",
    result: {
      status: "completed",
      runId: "wfr_story",
      result: {
        reportMarkdown:
          "# Deep Research\n\nWorkflow run cards should show phases, tasks, and final synthesis.",
        structuredOutput: { confidence: "medium", gaps: ["Dogfood in full app"] },
      },
      run: {
        id: "wfr_story",
        workspaceId: "workspace-1",
        definition: {
          name: "deep-research",
          description: "Deep research",
          scope: "built-in",
          executable: true,
        },
        definitionSource: "export default function workflow() { return null; }",
        definitionHash: "sha256:story",
        args: { topic: "workflow run cards" },
        status: "completed",
        createdAt: "2026-05-29T00:00:00.000Z",
        updatedAt: "2026-05-29T00:00:02.000Z",
        events: [
          { sequence: 1, type: "status", at: "2026-05-29T00:00:00.000Z", status: "running" },
          { sequence: 2, type: "phase", at: "2026-05-29T00:00:00.000Z", name: "scope" },
          {
            sequence: 3,
            type: "task",
            at: "2026-05-29T00:00:01.000Z",
            stepId: "scope-topic",
            taskId: "task_scope",
            status: "completed",
          },
          {
            sequence: 4,
            type: "phase",
            at: "2026-05-29T00:00:01.000Z",
            name: "adversarial-verification",
          },
          { sequence: 5, type: "status", at: "2026-05-29T00:00:02.000Z", status: "completed" },
        ],
        steps: [],
      },
    },
  },
};

const foregroundDiscoveryRun: WorkflowRunRecord = {
  id: "wfr_story_foreground",
  workspaceId: "workspace-1",
  definition: {
    name: "deep-research",
    description: "Deep research",
    scope: "built-in" as const,
    executable: true,
  },
  definitionSource: "export default function workflow() { return null; }",
  definitionHash: "sha256:story-foreground",
  args: { topic: "workflow run cards" },
  status: "running" as const,
  createdAt: "2026-05-29T00:00:01.000Z",
  updatedAt: "2026-05-29T00:00:02.000Z",
  events: [
    {
      sequence: 1,
      type: "status" as const,
      at: "2026-05-29T00:00:01.000Z",
      status: "running" as const,
    },
    { sequence: 2, type: "phase" as const, at: "2026-05-29T00:00:02.000Z", name: "scope" },
  ],
  steps: [],
};

const interruptedForegroundDiscoveryRun: WorkflowRunRecord = {
  ...foregroundDiscoveryRun,
  status: "interrupted" as const,
  updatedAt: "2026-05-29T00:00:03.000Z",
  events: [
    ...foregroundDiscoveryRun.events,
    {
      sequence: 3,
      type: "status" as const,
      at: "2026-05-29T00:00:03.000Z",
      status: "interrupted" as const,
    },
  ],
};

const resumedForegroundDiscoveryRun: WorkflowRunRecord = {
  ...foregroundDiscoveryRun,
  updatedAt: "2026-05-29T00:00:04.000Z",
  events: [
    ...interruptedForegroundDiscoveryRun.events,
    {
      sequence: 4,
      type: "status" as const,
      at: "2026-05-29T00:00:04.000Z",
      status: "running" as const,
    },
  ],
};

function createTaskWorkspaceMetadata(workspaceId: string): FrontendWorkspaceMetadata {
  return {
    id: workspaceId,
    name: workspaceId,
    title: workspaceId,
    projectPath: "/repo",
    projectName: "repo",
    namedWorkspacePath: `/repo/${workspaceId}`,
    createdAt: "2026-05-29T00:00:00.000Z",
    runtimeConfig: { type: "local", srcBaseDir: "/tmp/mux-src" },
  };
}

const taskActionsRun: WorkflowRunRecord = {
  id: "wfr_story_task_actions",
  workspaceId: "workspace-1",
  definition: {
    name: "implementation",
    description: "Implementation workflow",
    scope: "built-in" as const,
    executable: true,
  },
  definitionSource: "export default function workflow() { return null; }",
  definitionHash: "sha256:story-task-actions",
  args: { topic: "workflow task actions" },
  status: "running" as const,
  createdAt: "2026-05-29T00:00:00.000Z",
  updatedAt: "2026-05-29T00:00:02.000Z",
  events: [
    {
      sequence: 1,
      type: "status" as const,
      at: "2026-05-29T00:00:00.000Z",
      status: "running" as const,
    },
    { sequence: 2, type: "phase" as const, at: "2026-05-29T00:00:00.000Z", name: "implementation" },
    {
      sequence: 3,
      type: "task" as const,
      at: "2026-05-29T00:00:01.000Z",
      stepId: "summarize-source-15",
      taskId: "7b1a07d84d",
      status: "completed",
    },
    {
      sequence: 4,
      type: "task" as const,
      at: "2026-05-29T00:00:02.000Z",
      stepId: "extract-claims",
      taskId: "a36921beca",
      status: "started",
    },
  ],
  steps: [
    {
      stepId: "summarize-source-15",
      inputHash: "sha256:summarize",
      status: "completed" as const,
      taskId: "7b1a07d84d",
      startedAt: "2026-05-29T00:00:01.000Z",
      completedAt: "2026-05-29T00:00:02.000Z",
      result: {
        reportMarkdown: "## Summary report\n\nCompleted task report body.",
        structuredOutput: {
          summary: "Source 15 is ready for downstream extraction.",
          confidence: "high",
          citations: 3,
        },
      },
    },
    {
      stepId: "extract-claims",
      inputHash: "sha256:extract",
      status: "started" as const,
      taskId: "a36921beca",
      startedAt: "2026-05-29T00:00:02.000Z",
    },
  ],
};

function WorkflowTaskActionsStory(props: Parameters<typeof WorkflowRunToolCall>[0]) {
  const [openedTaskId, setOpenedTaskId] = useState<string | null>(null);

  useEffect(() => {
    const workspaceStore = useWorkspaceStoreRaw();
    workspaceStore.syncWorkspaces(
      new Map([
        ["7b1a07d84d", createTaskWorkspaceMetadata("7b1a07d84d")],
        ["a36921beca", createTaskWorkspaceMetadata("a36921beca")],
      ])
    );
    workspaceStore.setNavigateToWorkspace((workspaceId) => {
      setOpenedTaskId(workspaceId);
    });
    return () => {
      workspaceStore.setNavigateToWorkspace(() => undefined);
      workspaceStore.syncWorkspaces(new Map());
    };
  }, []);

  return (
    <div className="space-y-2">
      <WorkflowRunToolCall {...props} />
      <div className="text-muted text-xs" aria-live="polite">
        Last opened task: {openedTaskId ?? "none"}
      </div>
    </div>
  );
}

function ForegroundWorkflowAPIProvider(props: { children: ReactNode }) {
  const currentRunRef = useRef(foregroundDiscoveryRun);
  const [, setRenderVersion] = useState(0);
  const setCurrentRun = (run: WorkflowRunRecord) => {
    currentRunRef.current = run;
    setRenderVersion((version) => version + 1);
  };

  const foregroundWorkflowApi = {
    workflows: {
      listRuns: () => Promise.resolve([currentRunRef.current]),
      getRun: () => Promise.resolve(currentRunRef.current),
      interrupt: () => {
        setCurrentRun(interruptedForegroundDiscoveryRun);
        return Promise.resolve(interruptedForegroundDiscoveryRun);
      },
      resume: () => {
        setCurrentRun(resumedForegroundDiscoveryRun);
        return Promise.resolve({
          runId: foregroundDiscoveryRun.id,
          status: "running",
          result: null,
        });
      },
    },
  };

  return (
    <APIContext.Provider
      value={{
        status: "connected",
        api: foregroundWorkflowApi as never,
        error: null,
        authenticate: () => undefined,
        retry: () => undefined,
      }}
    >
      {props.children}
    </APIContext.Provider>
  );
}

const taskActionsProps = {
  args: {
    name: "implementation",
    args: { topic: "workflow task actions" },
    run_in_background: true,
  },
  status: "completed" as const,
  result: {
    status: "running" as const,
    runId: "wfr_story_task_actions",
    result: null,
    run: taskActionsRun,
  },
} satisfies Parameters<typeof WorkflowRunToolCall>[0];

export const TaskActions: Story = {
  render: (args) => <WorkflowTaskActionsStory {...taskActionsProps} {...args} />,
  args: taskActionsProps,
};

export const RunningForegroundDiscovered: Story = {
  render: (args) => (
    <ForegroundWorkflowAPIProvider>
      <WorkflowRunToolCall
        {...args}
        workspaceId="workspace-1"
        startedAt={Date.parse("2026-05-29T00:00:00.500Z")}
      />
    </ForegroundWorkflowAPIProvider>
  ),
  args: {
    args: {
      name: "deep-research",
      args: { topic: "workflow run cards" },
      run_in_background: false,
    },
    status: "executing",
  },
};

export const RunningBackgroundWithRun: Story = {
  render: (args) => (
    <ForegroundWorkflowAPIProvider>
      <WorkflowRunToolCall {...args} />
    </ForegroundWorkflowAPIProvider>
  ),
  args: {
    args: {
      name: "deep-research",
      args: { topic: "workflow run cards" },
      run_in_background: true,
    },
    status: "completed",
    result: {
      status: "running",
      runId: "wfr_story_foreground",
      result: null,
      run: foregroundDiscoveryRun,
    },
  },
};

export const ScratchPromotable: Story = {
  render: (args) => (
    <StoryAPIProvider>
      <WorkflowRunToolCall {...args} />
    </StoryAPIProvider>
  ),
  args: {
    args: {
      name: "scratch",
      args: { topic: "promote this workflow" },
      run_in_background: true,
    },
    status: "completed",
    result: {
      status: "completed",
      runId: "wfr_scratch_story",
      result: { reportMarkdown: "# Scratch workflow\n\nThis one-off workflow can be promoted." },
      run: {
        id: "wfr_scratch_story",
        workspaceId: "workspace-1",
        definition: {
          name: "scratch",
          description: "Scratch workflow",
          scope: "scratch",
          executable: true,
        },
        definitionSource: "export default function workflow() { return null; }",
        definitionHash: "sha256:scratch-story",
        args: { topic: "promote this workflow" },
        status: "completed",
        createdAt: "2026-05-29T00:00:00.000Z",
        updatedAt: "2026-05-29T00:00:02.000Z",
        events: [
          { sequence: 1, type: "phase", at: "2026-05-29T00:00:00.000Z", name: "draft" },
          { sequence: 2, type: "status", at: "2026-05-29T00:00:02.000Z", status: "completed" },
        ],
        steps: [],
      },
    },
  },
};
