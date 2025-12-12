/**
 * RightSidebar tab stories - testing dynamic tab data display
 *
 * Uses wide viewport (1600px) to ensure RightSidebar tabs are visible.
 */

import { appMeta, AppWithMocks, type AppStory } from "./meta.js";
import { setupSimpleChatStory } from "./storyHelpers";
import { createUserMessage, createAssistantMessage } from "./mockFactory";
import { within, userEvent, waitFor } from "@storybook/test";
import { RIGHT_SIDEBAR_TAB_KEY } from "@/common/constants/storage";
import type { ComponentType } from "react";
import type { MockSessionUsage } from "../../../.storybook/mocks/orpc";

export default {
  ...appMeta,
  title: "App/RightSidebar",
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
      modes: {
        dark: { theme: "dark", viewport: 1600 },
        light: { theme: "light", viewport: 1600 },
      },
    },
  },
};

/**
 * Helper to create session usage data with costs
 */
function createSessionUsage(cost: number): MockSessionUsage {
  const inputCost = cost * 0.6;
  const outputCost = cost * 0.2;
  const cachedCost = cost * 0.1;
  const reasoningCost = cost * 0.1;

  return {
    byModel: {
      "claude-sonnet-4-20250514": {
        input: { tokens: 10000, cost_usd: inputCost },
        cached: { tokens: 5000, cost_usd: cachedCost },
        cacheCreate: { tokens: 0, cost_usd: 0 },
        output: { tokens: 2000, cost_usd: outputCost },
        reasoning: { tokens: 1000, cost_usd: reasoningCost },
        model: "claude-sonnet-4-20250514",
      },
    },
    version: 1,
  };
}

/**
 * Costs tab with session cost displayed in tab label ($0.56)
 */
export const CostsTab: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        localStorage.setItem(RIGHT_SIDEBAR_TAB_KEY, JSON.stringify("costs"));

        return setupSimpleChatStory({
          workspaceId: "ws-costs",
          workspaceName: "feature/api",
          projectName: "my-app",
          messages: [
            createUserMessage("msg-1", "Help me build an API", { historySequence: 1 }),
            createAssistantMessage("msg-2", "I'll help you build a REST API.", {
              historySequence: 2,
            }),
          ],
          sessionUsage: createSessionUsage(0.56),
        });
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // Session usage is fetched async via WorkspaceStore; wait to avoid snapshot races.
    await waitFor(
      () => {
        canvas.getByRole("tab", { name: /costs.*\$0\.56/i });
      },
      { timeout: 5000 }
    );
  },
};

/**
 * Review tab selected - click switches from Costs to Review tab
 */
export const ReviewTab: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        localStorage.setItem(RIGHT_SIDEBAR_TAB_KEY, JSON.stringify("costs"));

        return setupSimpleChatStory({
          workspaceId: "ws-review",
          workspaceName: "feature/review",
          projectName: "my-app",
          messages: [
            createUserMessage("msg-1", "Add a new component", { historySequence: 1 }),
            createAssistantMessage("msg-2", "I've added the component.", { historySequence: 2 }),
          ],
          sessionUsage: createSessionUsage(0.42),
        });
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // Wait for session usage to land (avoid theme/mode snapshots diverging on timing).
    await waitFor(
      () => {
        canvas.getByRole("tab", { name: /costs.*\$0\.42/i });
      },
      { timeout: 5000 }
    );

    const reviewTab = canvas.getByRole("tab", { name: /^review/i });
    await userEvent.click(reviewTab);

    await waitFor(() => {
      canvas.getByRole("tab", { name: /^review/i, selected: true });
    });
  },
};
