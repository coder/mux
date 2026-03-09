import type { ComponentType } from "react";
import { within, userEvent, waitFor } from "@storybook/test";

import type { APIClient } from "@/browser/contexts/API";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import {
  RIGHT_SIDEBAR_TAB_KEY,
  RIGHT_SIDEBAR_WIDTH_KEY,
  getPostCompactionStateKey,
  getRightSidebarLayoutKey,
} from "@/common/constants/storage";
import assert from "@/common/utils/assert";

import { appMeta, AppWithMocks, type AppStory } from "./meta.js";
import { createAssistantMessage, createUserMessage } from "./mockFactory";
import { expandRightSidebar, setupSimpleChatStory } from "./storyHelpers";

const PLAN_PREVIEW_WORKSPACE_ID = "ws-plan-preview";
const PLAN_PREVIEW_PATH = "/home/user/.mux/plans/my-app/ws-plan-preview.md";
const PLAN_PREVIEW_CONTENT = `# Plan preview modal story

- Show the preserved plan directly in the right sidebar flow.
- Keep open-in-editor as a secondary action.
- Verify markdown remains readable in a dialog.`;

function configurePlanArtifactMocks(client: APIClient): void {
  const excludedItems = new Set<string>();

  client.workspace.getPostCompactionState = (input) => {
    assert(input.workspaceId === PLAN_PREVIEW_WORKSPACE_ID, "Unexpected workspace in story mock");

    return Promise.resolve({
      planPath: PLAN_PREVIEW_PATH,
      trackedFilePaths: ["src/browser/features/RightSidebar/PostCompactionSection.tsx"],
      excludedItems: Array.from(excludedItems),
    });
  };

  client.workspace.setPostCompactionExclusion = (input) => {
    assert(input.workspaceId === PLAN_PREVIEW_WORKSPACE_ID, "Unexpected workspace in story mock");

    if (input.excluded) {
      excludedItems.add(input.itemId);
    } else {
      excludedItems.delete(input.itemId);
    }

    return Promise.resolve({ success: true as const, data: undefined });
  };

  client.workspace.getPlanContent = (input) => {
    assert(input.workspaceId === PLAN_PREVIEW_WORKSPACE_ID, "Unexpected workspace in story mock");

    return Promise.resolve({
      success: true as const,
      data: {
        content: PLAN_PREVIEW_CONTENT,
        path: PLAN_PREVIEW_PATH,
      },
    });
  };
}

export default {
  ...appMeta,
  title: "App/RightSidebar/Plan Preview",
  decorators: [
    (Story: ComponentType) => (
      <div style={{ width: 1600, height: "100dvh" }}>
        <Story />
      </div>
    ),
  ],
  parameters: {
    ...appMeta.parameters,
    chromatic: {
      ...(appMeta.parameters?.chromatic ?? {}),
      modes: {
        dark: { theme: "dark", viewport: 1600 },
        light: { theme: "light", viewport: 1600 },
      },
    },
  },
};

export const PlanPreviewModal: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        localStorage.setItem(RIGHT_SIDEBAR_TAB_KEY, JSON.stringify("costs"));
        localStorage.setItem(RIGHT_SIDEBAR_WIDTH_KEY, "420");
        localStorage.removeItem(getRightSidebarLayoutKey(PLAN_PREVIEW_WORKSPACE_ID));

        updatePersistedState(getPostCompactionStateKey(PLAN_PREVIEW_WORKSPACE_ID), {
          planPath: PLAN_PREVIEW_PATH,
          trackedFilePaths: ["src/browser/features/RightSidebar/PostCompactionSection.tsx"],
          excludedItems: [],
        });

        const client = setupSimpleChatStory({
          workspaceId: PLAN_PREVIEW_WORKSPACE_ID,
          workspaceName: "feature/plan-preview",
          projectName: "my-app",
          messages: [
            createUserMessage("msg-1", "compact this chat and keep important context", {
              historySequence: 1,
            }),
            createAssistantMessage("msg-2", "Compaction completed and artifacts were saved.", {
              historySequence: 2,
            }),
          ],
        });

        configurePlanArtifactMocks(client);
        expandRightSidebar();
        return client;
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const body = within(document.body);

    const artifactsButton = await canvas.findByRole("button", { name: "Artifacts" });
    await userEvent.click(artifactsButton);

    const planFileButton = await canvas.findByRole("button", { name: "Plan file" });
    await userEvent.click(planFileButton);

    await waitFor(() => {
      body.getByText("Plan preview modal story");
      body.getByText(PLAN_PREVIEW_PATH);
    });
  },
};
