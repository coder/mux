/**
 * RightSidebar tab stories - testing dynamic tab data display
 *
 * Uses wide viewport (1600px) to ensure RightSidebar tabs are visible.
 */

import { appMeta, AppWithMocks, type AppStory } from "./meta.js";
import { setupSimpleChatStory, setupStreamingChatStory } from "./storyHelpers";
import { createUserMessage, createAssistantMessage } from "./mockFactory";
import { within, userEvent, waitFor } from "@storybook/test";
import {
  RIGHT_SIDEBAR_TAB_KEY,
  RIGHT_SIDEBAR_COSTS_WIDTH_KEY,
  RIGHT_SIDEBAR_REVIEW_WIDTH_KEY,
} from "@/common/constants/storage";
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
        // Set per-tab widths: costs at 350px, review at 700px
        localStorage.setItem(RIGHT_SIDEBAR_COSTS_WIDTH_KEY, "350");
        localStorage.setItem(RIGHT_SIDEBAR_REVIEW_WIDTH_KEY, "700");

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
 * Costs tab showing cache create vs cache read differentiation.
 * Cache create (orange) is typically more expensive than cache read (grey).
 * This story uses realistic Anthropic-style usage where most input is cached.
 */
export const CostsTabWithCacheCreate: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        localStorage.setItem(RIGHT_SIDEBAR_TAB_KEY, JSON.stringify("costs"));
        localStorage.setItem(RIGHT_SIDEBAR_COSTS_WIDTH_KEY, "350");

        return setupSimpleChatStory({
          workspaceId: "ws-cache-create",
          workspaceName: "feature/caching",
          projectName: "my-app",
          messages: [
            createUserMessage("msg-1", "Refactor the auth module", { historySequence: 1 }),
            createAssistantMessage("msg-2", "I'll refactor the authentication module.", {
              historySequence: 2,
            }),
          ],
          sessionUsage: {
            byModel: {
              "anthropic:claude-sonnet-4-20250514": {
                // Realistic Anthropic usage: heavy caching, cache create is expensive
                input: { tokens: 2000, cost_usd: 0.006 },
                cached: { tokens: 45000, cost_usd: 0.0045 }, // Cache read: cheap
                cacheCreate: { tokens: 30000, cost_usd: 0.1125 }, // Cache create: expensive!
                output: { tokens: 3000, cost_usd: 0.045 },
                reasoning: { tokens: 0, cost_usd: 0 },
                model: "anthropic:claude-sonnet-4-20250514",
              },
            },
            version: 1,
          },
        });
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // Wait for costs to render - cache create should be dominant cost
    await waitFor(
      () => {
        canvas.getByText("Cache Create");
        canvas.getByText("Cache Read");
      },
      { timeout: 5000 }
    );
  },
};

/**
 * Review tab selected - click switches from Costs to Review tab
 * Verifies per-tab width persistence: starts at Costs width (350px), switches to Review width (700px)
 */
export const ReviewTab: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        localStorage.setItem(RIGHT_SIDEBAR_TAB_KEY, JSON.stringify("costs"));
        // Set distinct widths per tab to verify switching behavior
        localStorage.setItem(RIGHT_SIDEBAR_COSTS_WIDTH_KEY, "350");
        localStorage.setItem(RIGHT_SIDEBAR_REVIEW_WIDTH_KEY, "700");

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

/**
 * Stats tab when idle (no timing data) - shows placeholder message
 */
export const StatsTabIdle: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        localStorage.setItem(RIGHT_SIDEBAR_TAB_KEY, JSON.stringify("stats"));

        return setupSimpleChatStory({
          workspaceId: "ws-stats-idle",
          workspaceName: "feature/stats",
          projectName: "my-app",
          messages: [
            createUserMessage("msg-1", "Help me with something", { historySequence: 1 }),
            createAssistantMessage("msg-2", "Sure, I can help with that.", { historySequence: 2 }),
          ],
          sessionUsage: createSessionUsage(0.25),
        });
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // Feature flags are async, so allow more time.
    const statsTab = await canvas.findByRole("tab", { name: /^stats/i }, { timeout: 3000 });
    await userEvent.click(statsTab);

    await waitFor(() => {
      canvas.getByText(/no timing data yet/i);
    });
  },
};

/**
 * Stats tab during active streaming - shows timing statistics
 */
export const StatsTabStreaming: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        localStorage.setItem(RIGHT_SIDEBAR_TAB_KEY, JSON.stringify("stats"));

        return setupStreamingChatStory({
          workspaceId: "ws-stats-streaming",
          workspaceName: "feature/streaming",
          projectName: "my-app",
          statsTabEnabled: true,
          messages: [
            createUserMessage("msg-1", "Write a comprehensive test suite", { historySequence: 1 }),
          ],
          streamingMessageId: "msg-2",
          historySequence: 2,
          streamText: "I'll create a test suite for you. Let me start by analyzing...",
        });
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // Feature flags are async; wait for Stats tab to appear, then select it.
    const statsTab = await canvas.findByRole("tab", { name: /^stats/i }, { timeout: 5000 });
    await userEvent.click(statsTab);

    await waitFor(
      () => {
        canvas.getByRole("tab", { name: /^stats/i, selected: true });
      },
      { timeout: 5000 }
    );

    // Verify timing header is shown (with pulsing active indicator)
    await waitFor(() => {
      canvas.getByText(/timing/i);
    });

    // Verify timing table components are displayed
    await waitFor(() => {
      canvas.getByText(/model time/i);
    });
  },
};
