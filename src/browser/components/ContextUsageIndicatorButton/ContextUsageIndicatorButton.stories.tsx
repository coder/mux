import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn, userEvent, waitFor, within } from "@storybook/test";
import { lightweightMeta } from "@/browser/stories/meta.js";
import { TOKEN_COMPONENT_COLORS, type TokenMeterData } from "@/common/utils/tokens/tokenMeterUtils";
import { ContextUsageIndicatorButton } from "./ContextUsageIndicatorButton.js";

const CONTEXT_METER_DATA: TokenMeterData = {
  totalTokens: 130000,
  maxTokens: 200000,
  totalPercentage: 65,
  segments: [
    {
      type: "input",
      tokens: 124000,
      percentage: 62,
      color: TOKEN_COMPONENT_COLORS.input,
    },
    {
      type: "output",
      tokens: 6000,
      percentage: 3,
      color: TOKEN_COMPONENT_COLORS.output,
    },
  ],
};

const HOVER_SUMMARY_DATA: TokenMeterData = {
  totalTokens: 130500,
  maxTokens: 200000,
  totalPercentage: 65.25,
  segments: [
    {
      type: "input",
      tokens: 128000,
      percentage: 64,
      color: TOKEN_COMPONENT_COLORS.input,
    },
    {
      type: "output",
      tokens: 2500,
      percentage: 1.25,
      color: TOKEN_COMPONENT_COLORS.output,
    },
  ],
};

const meta = {
  ...lightweightMeta,
  title: "App/Chat/Components/ContextUsageIndicator",
  component: ContextUsageIndicatorButton,
} satisfies Meta<typeof ContextUsageIndicatorButton>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * Context meter with high usage and idle compaction enabled.
 * Shows the context usage indicator badge in the chat input area with the
 * hourglass badge indicating idle compaction is configured.
 */
export const ContextMeterWithIdleCompaction: Story = {
  args: {
    data: CONTEXT_METER_DATA,
    autoCompaction: { threshold: 80, setThreshold: fn() },
    idleCompaction: { hours: 4, setHours: fn() },
  },
  render: (args) => (
    <div className="bg-background flex min-h-[180px] items-end p-6">
      <ContextUsageIndicatorButton {...args} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => {
      canvas.getByRole("button", { name: /context usage/i });
    });
  },
  parameters: {
    docs: {
      description: {
        story:
          "Shows the Context Meter with high usage (~65%) and idle compaction enabled (4h). " +
          "The meter displays an hourglass badge indicating idle compaction is configured.",
      },
    },
  },
};

/**
 * Context meter hover summary tooltip.
 *
 * Captures the non-interactive one-line tooltip shown on hover so the quick
 * compaction stats remain visible even after controls moved to click-to-open.
 */
export const ContextMeterHoverSummaryTooltip: Story = {
  args: {
    data: HOVER_SUMMARY_DATA,
    autoCompaction: { threshold: 80, setThreshold: fn() },
    idleCompaction: { hours: 4, setHours: fn() },
  },
  render: (args) => (
    <div className="bg-background flex min-h-[180px] items-end p-6">
      <ContextUsageIndicatorButton {...args} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    const contextButton = await waitFor(
      () => canvas.getByRole("button", { name: /context usage/i }),
      { interval: 50, timeout: 10000 }
    );

    await userEvent.hover(contextButton);

    await waitFor(
      () => {
        const tooltip = document.querySelector('[role="tooltip"]');
        if (!(tooltip instanceof HTMLElement)) {
          throw new Error("Compaction hover summary tooltip not visible");
        }

        const text = tooltip.textContent ?? "";
        if (!text.includes("Context ")) {
          throw new Error("Expected context usage summary in tooltip");
        }
        if (!text.includes("Auto ")) {
          throw new Error("Expected auto-compaction summary in tooltip");
        }
        if (!text.includes("Idle 4h")) {
          throw new Error("Expected idle compaction summary in tooltip");
        }
      },
      { interval: 50, timeout: 5000 }
    );
  },
  parameters: {
    docs: {
      description: {
        story:
          "Captures the context usage hover summary tooltip with one-line stats for context, auto-compaction threshold, and idle timer.",
      },
    },
  },
};
