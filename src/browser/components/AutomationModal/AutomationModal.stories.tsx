import { useRef } from "react";
import type { FC, ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "@storybook/test";

import { APIProvider, type APIClient } from "@/browser/contexts/API";
import { ProjectProvider } from "@/browser/contexts/ProjectContext";
import { StoryUiShell } from "@/browser/stories/meta";
import type { ProjectWorkflowSchedule } from "@/common/types/project";
import type { WorkflowDefinitionDescriptor } from "@/common/types/workflow";
import { AutomationModal } from "./AutomationModal";

const PROJECT_PATH = "/Users/test/mux";
const WORKSPACE_ID = "triage-control";
const WORKSPACE_NAME = "Triage control";

const WORKFLOW_DEFINITIONS: WorkflowDefinitionDescriptor[] = [
  {
    name: "triage-github-issues",
    description: "Scan untriaged GitHub issues and create triage workspaces.",
    scope: "project",
    sourcePath: `${PROJECT_PATH}/.mux/workflows/triage-github-issues.js`,
    executable: true,
  },
  {
    name: "daily-maintenance",
    description: "Run daily repository maintenance checks.",
    scope: "global",
    sourcePath: "/Users/test/.mux/workflows/daily-maintenance.js",
    executable: true,
  },
  {
    name: "blocked-project-workflow",
    description: "A trusted-project-only workflow that should not be selectable.",
    scope: "project",
    sourcePath: `${PROJECT_PATH}/.mux/workflows/blocked-project-workflow.js`,
    executable: false,
    blockedReason: "Trust this project before running project-local workflows.",
  },
];

const WORKFLOW_SCHEDULE: ProjectWorkflowSchedule = {
  id: "triage-control-schedule",
  enabled: true,
  workflowName: "triage-github-issues",
  intervalMs: 30 * 60_000,
  args: { label: "needs-triage" },
  target: { type: "existing-workspace", workspaceId: WORKSPACE_ID },
  lastRunStartedAt: "2026-06-13T08:00:00.000Z",
};

function createAutomationClient(): APIClient {
  return {
    workflows: {
      listDefinitions: () => Promise.resolve(WORKFLOW_DEFINITIONS),
    },
    workspace: {
      setWorkflowSchedule: () => Promise.resolve({ success: true as const, data: undefined }),
    },
    projects: {
      list: () =>
        Promise.resolve([
          [
            PROJECT_PATH,
            {
              workspaces: [{ id: WORKSPACE_ID, path: "/tmp/triage-control" }],
              workflowSchedules: [WORKFLOW_SCHEDULE],
            },
          ],
        ]),
      workflowSchedules: {
        set: () => Promise.resolve({ success: true as const, data: WORKFLOW_SCHEDULE }),
        remove: () => Promise.resolve({ success: true as const, data: undefined }),
      },
    },
  } as unknown as APIClient;
}

const AutomationStoryShell: FC<{ children: ReactNode }> = (props) => {
  const clientRef = useRef<APIClient | null>(null);
  clientRef.current ??= createAutomationClient();

  return (
    <StoryUiShell>
      <APIProvider client={clientRef.current}>
        <ProjectProvider>{props.children}</ProjectProvider>
      </APIProvider>
    </StoryUiShell>
  );
};

function renderAutomationModal(): JSX.Element {
  return (
    <AutomationStoryShell>
      <AutomationModal
        open={true}
        projectPath={PROJECT_PATH}
        workspaceId={WORKSPACE_ID}
        workspaceName={WORKSPACE_NAME}
        projectWorkflowSchedule={WORKFLOW_SCHEDULE}
        onOpenChange={() => {
          // Keep the story stable while users interact with the form.
        }}
      />
    </AutomationStoryShell>
  );
}

const meta: Meta<typeof AutomationModal> = {
  title: "Components/AutomationModal",
  component: AutomationModal,
  parameters: {
    layout: "fullscreen",
    chromatic: { delay: 500 },
  },
};

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: renderAutomationModal,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    await expect(canvas.findByText("Automation for Triage control")).resolves.toBeInTheDocument();
    await expect(canvas.findByLabelText("Automation workflow")).resolves.toBeInTheDocument();
  },
};

export const Mobile: Story = {
  render: renderAutomationModal,
  globals: { viewport: { value: "mobile1", isRotated: false } },
  parameters: {
    // Pinned mobile mode so Chromatic snapshots the responsive modal controls at phone width.
    chromatic: { modes: { "dark-mobile": { theme: "dark", viewport: "mobile1", hasTouch: true } } },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    await expect(canvas.findByText("Automation for Triage control")).resolves.toBeInTheDocument();
    await expect(canvas.findByLabelText("Automation args")).resolves.toBeInTheDocument();
  },
};
