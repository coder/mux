import type { Meta, StoryObj } from "@storybook/react-vite";

import { APIContext } from "@/browser/contexts/API";
import { ThemeProvider } from "@/browser/contexts/ThemeContext";
import type { WorkflowRunRecord, WorkflowRunStreamEvent } from "@/common/types/workflow";

import { WorkflowsTab } from "./WorkflowsTab";

const meta = {
  title: "Features/RightSidebar/Workflows",
  component: WorkflowsTab,
  parameters: {
    layout: "centered",
    backgrounds: { default: "dark" },
  },
  decorators: [
    (Story) => (
      <ThemeProvider forcedTheme="dark">
        <div className="bg-background text-foreground border-border h-[760px] w-[430px] overflow-auto rounded-xl border p-4">
          <Story />
        </div>
      </ThemeProvider>
    ),
  ],
} satisfies Meta<typeof WorkflowsTab>;

export default meta;
type Story = StoryObj<typeof meta>;

const NOW = "2026-05-29T00:00:00.000Z";

const nestedChildRun: WorkflowRunRecord = {
  id: "wfr_child_story",
  workspaceId: "workspace-1",
  workflow: {
    name: "implementation-loop",
    description: "Implementation loop",
    scope: "global",
    requestedScriptPath: "skill://implementation-loop/workflow.js",
    canonicalScriptPath: "skill://implementation-loop/workflow.js",
    sourceKind: "skill",
    sourceHash: "sha256:nested-child",
    executable: true,
  },
  source: "export default function workflow() { return null; }",
  sourceHash: "sha256:nested-child",
  args: { target: "coder/mux#3546" },
  parentWorkflow: {
    runId: "wfr_nested_parent_story",
    stepId: "implementation-loop",
    inputHash: "sha256:nested-child-input",
    depth: 0,
  },
  status: "running",
  createdAt: NOW,
  updatedAt: "2026-05-29T00:00:04.000Z",
  events: [
    { sequence: 1, type: "status", at: NOW, status: "running" },
    { sequence: 2, type: "phase", at: "2026-05-29T00:00:01.000Z", name: "fetch-context" },
    {
      sequence: 3,
      type: "task",
      at: "2026-05-29T00:00:01.500Z",
      stepId: "fetch-issue-context",
      taskId: "task_context",
      status: "completed",
      title: "Fetch issue context",
    },
    { sequence: 4, type: "phase", at: "2026-05-29T00:00:03.000Z", name: "implementation" },
    {
      sequence: 5,
      type: "task",
      at: "2026-05-29T00:00:03.500Z",
      stepId: "implement",
      taskId: "task_implement",
      status: "started",
      title: "Implement nested slice",
    },
  ],
  steps: [
    {
      stepId: "fetch-issue-context",
      inputHash: "sha256:context",
      status: "completed",
      taskId: "task_context",
      startedAt: "2026-05-29T00:00:01.500Z",
      completedAt: "2026-05-29T00:00:02.500Z",
      result: { reportMarkdown: "Fetched issue context." },
    },
    {
      stepId: "implement",
      inputHash: "sha256:implement",
      status: "started",
      taskId: "task_implement",
      startedAt: "2026-05-29T00:00:03.500Z",
    },
  ],
};

const nestedParentRun: WorkflowRunRecord = {
  id: "wfr_nested_parent_story",
  workspaceId: "workspace-1",
  workflow: {
    name: "issue-implementation-loop",
    description: "Issue implementation loop",
    scope: "global",
    requestedScriptPath: "skill://issue-implementation-loop/workflow.js",
    canonicalScriptPath: "skill://issue-implementation-loop/workflow.js",
    sourceKind: "skill",
    sourceHash: "sha256:nested-parent",
    executable: true,
  },
  source: "export default function workflow() { return null; }",
  sourceHash: "sha256:nested-parent",
  args: { repo: "coder/mux", issue: 3546, maxVerifierRuns: 1 },
  status: "running",
  createdAt: NOW,
  updatedAt: "2026-05-29T00:00:04.000Z",
  events: [
    { sequence: 1, type: "status", at: NOW, status: "running" },
    { sequence: 2, type: "phase", at: "2026-05-29T00:00:01.000Z", name: "implementation-loop" },
    {
      sequence: 3,
      type: "workflow",
      at: "2026-05-29T00:00:02.000Z",
      stepId: "implementation-loop",
      runId: nestedChildRun.id,
      name: "implementation-loop",
      status: "started",
      details: { target: "coder/mux#3546" },
    },
  ],
  steps: [
    {
      stepId: "implementation-loop",
      inputHash: "sha256:nested-child-input",
      status: "started",
      startedAt: "2026-05-29T00:00:02.000Z",
    },
  ],
};

async function* subscribeWorkflowRuns(): AsyncGenerator<WorkflowRunStreamEvent> {
  await Promise.resolve();
  yield { type: "snapshot", runs: [nestedParentRun] };
}

const workflowApi = {
  workflows: {
    subscribe: () => subscribeWorkflowRuns(),
    listScripts: () => Promise.resolve([]),
    getRun: (input: { runId: string }) =>
      Promise.resolve(input.runId === nestedChildRun.id ? nestedChildRun : nestedParentRun),
    interrupt: () => Promise.resolve(nestedParentRun),
    resume: () => Promise.resolve(nestedParentRun),
    retryFromCheckpoint: () => Promise.resolve(nestedParentRun),
    start: () => Promise.resolve({ runId: nestedParentRun.id, status: "running", result: null }),
  },
};

export const NestedWorkflow: Story = {
  args: { workspaceId: "workspace-1" },
  render: (args) => (
    <APIContext.Provider
      value={{
        status: "connected",
        api: workflowApi as never,
        error: null,
        authenticate: () => undefined,
        retry: () => undefined,
      }}
    >
      <WorkflowsTab {...args} />
    </APIContext.Provider>
  ),
};
