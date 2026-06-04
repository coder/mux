import { useRef, useState, type ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";

import type { WorkflowRunRecord } from "@/common/types/workflow";
import { APIContext } from "@/browser/contexts/API";
import { WorkflowRunToolCall } from "@/browser/features/Tools/WorkflowRunToolCall";
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
