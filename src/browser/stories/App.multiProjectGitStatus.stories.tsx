/**
 * Multi-project git status stories.
 *
 * These full-app stories exercise the top-bar indicator that only appears when a
 * workspace spans multiple repos, plus the dialog opened from that indicator.
 */

import type { APIClient } from "@/browser/contexts/API";
import type { ProjectGitStatusResult } from "@/common/orpc/schemas/api";
import { getExperimentKey, EXPERIMENT_IDS } from "@/common/constants/experiments";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";
import { appMeta, AppWithMocks, type AppStory } from "./meta.js";
import { createWorkspace, groupWorkspacesByProject } from "./mockFactory";
import { collapseRightSidebar, expandProjects, selectWorkspace } from "./storyHelpers";
import { userEvent, waitFor, within } from "@storybook/test";

export default {
  ...appMeta,
  title: "App/MultiProjectGitStatus",
};

interface MultiProjectStoryOptions {
  workspaceId: string;
  projectName: string;
  projectStatuses: ProjectGitStatusResult[];
}

function createMultiProjectClient(options: MultiProjectStoryOptions): APIClient {
  const workspace = {
    // GitStatusStore caches local repo refreshes by projectName. Give each story a
    // unique primary project name so captures don't reuse another story's status.
    ...createWorkspace({
      id: options.workspaceId,
      name: "feature/multi-project-status",
      projectName: options.projectName,
      createdAt: "2023-11-14T22:13:20.000Z",
    }),
    projects: [
      {
        projectPath: `/home/user/projects/${options.projectName}`,
        projectName: "app",
      },
      {
        projectPath: "/home/user/projects/docs",
        projectName: "docs",
      },
    ],
  };

  const workspaces = [workspace];
  const projects = groupWorkspacesByProject(workspaces);

  selectWorkspace(workspace);
  expandProjects([...projects.keys()]);
  collapseRightSidebar();

  const experimentKey = getExperimentKey(EXPERIMENT_IDS.MULTI_PROJECT_WORKSPACES);
  window.localStorage.setItem(experimentKey, JSON.stringify(true));

  return createMockORPCClient({
    projects,
    workspaces,
    projectGitStatusesByWorkspace: new Map([[workspace.id, options.projectStatuses]]),
  });
}

async function waitForMultiProjectChip(
  canvasElement: HTMLElement,
  expectedText: string
): Promise<HTMLButtonElement> {
  const canvas = within(canvasElement);
  const chip = await canvas.findByRole(
    "button",
    { name: /open multi-project git status details/i },
    { timeout: 10000 }
  );

  await waitFor(() => {
    if (!chip.textContent?.includes(expectedText)) {
      throw new Error(`Expected multi-project git chip to include "${expectedText}".`);
    }
  });

  return chip as HTMLButtonElement;
}

const divergedProjectStatuses: ProjectGitStatusResult[] = [
  {
    projectPath: "/home/user/projects/app-diverged",
    projectName: "app",
    gitStatus: {
      branch: "main",
      ahead: 2,
      behind: 1,
      dirty: false,
      outgoingAdditions: 14,
      outgoingDeletions: 3,
      incomingAdditions: 8,
      incomingDeletions: 2,
    },
    error: null,
  },
  {
    projectPath: "/home/user/projects/docs",
    projectName: "docs",
    gitStatus: {
      branch: "main",
      ahead: 0,
      behind: 0,
      dirty: false,
      outgoingAdditions: 0,
      outgoingDeletions: 0,
      incomingAdditions: 0,
      incomingDeletions: 0,
    },
    error: null,
  },
];

const cleanProjectStatuses: ProjectGitStatusResult[] = [
  {
    projectPath: "/home/user/projects/app-clean",
    projectName: "app",
    gitStatus: {
      branch: "main",
      ahead: 0,
      behind: 0,
      dirty: false,
      outgoingAdditions: 0,
      outgoingDeletions: 0,
      incomingAdditions: 0,
      incomingDeletions: 0,
    },
    error: null,
  },
  {
    projectPath: "/home/user/projects/docs",
    projectName: "docs",
    gitStatus: {
      branch: "main",
      ahead: 0,
      behind: 0,
      dirty: false,
      outgoingAdditions: 0,
      outgoingDeletions: 0,
      incomingAdditions: 0,
      incomingDeletions: 0,
    },
    error: null,
  },
];

const dialogProjectStatuses: ProjectGitStatusResult[] = [
  {
    projectPath: "/home/user/projects/app-dialog",
    projectName: "app",
    gitStatus: {
      branch: "main",
      ahead: 2,
      behind: 1,
      dirty: false,
      outgoingAdditions: 14,
      outgoingDeletions: 3,
      incomingAdditions: 8,
      incomingDeletions: 2,
    },
    error: null,
  },
  {
    projectPath: "/home/user/projects/docs",
    projectName: "docs",
    gitStatus: {
      branch: "main",
      ahead: 0,
      behind: 0,
      dirty: true,
      outgoingAdditions: 4,
      outgoingDeletions: 1,
      incomingAdditions: 0,
      incomingDeletions: 0,
    },
    error: null,
  },
];

export const Diverged: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        createMultiProjectClient({
          workspaceId: "ws-multi-diverged",
          projectName: "app-diverged-story",
          projectStatuses: divergedProjectStatuses,
        })
      }
    />
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await waitForMultiProjectChip(canvasElement, "1 diverged");
  },
};

export const Clean: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        createMultiProjectClient({
          workspaceId: "ws-multi-clean",
          projectName: "app-clean-story",
          projectStatuses: cleanProjectStatuses,
        })
      }
    />
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await waitForMultiProjectChip(canvasElement, "2 repos");
  },
};

export const DialogOpen: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        createMultiProjectClient({
          workspaceId: "ws-multi-dialog",
          projectName: "app-dialog-story",
          projectStatuses: dialogProjectStatuses,
        })
      }
    />
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    const chip = await waitForMultiProjectChip(canvasElement, "1 diverged");
    await userEvent.click(chip);

    const body = within(canvasElement.ownerDocument.body);
    const dialog = await waitFor(() => {
      const foundDialog = body.getByRole("dialog");
      if (!foundDialog.textContent?.includes("Multi-project git status")) {
        throw new Error("Multi-project git status dialog not rendered yet.");
      }
      return foundDialog;
    });

    const dialogScope = within(dialog);
    await dialogScope.findByText("Project");
    await dialogScope.findByText("docs");
    await dialogScope.findByText("Dirty");
  },
};
