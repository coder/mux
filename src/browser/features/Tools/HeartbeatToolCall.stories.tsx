import type { Meta, StoryObj } from "@storybook/react-vite";
import { HeartbeatToolCall } from "@/browser/features/Tools/HeartbeatToolCall";
import { CHROMATIC_DISABLED, lightweightMeta, StoryUiShell } from "@/browser/stories/meta.js";
import { HEARTBEAT_DEFAULT_MESSAGE_BODY } from "@/constants/heartbeat";

const meta = {
  ...lightweightMeta,
  title: "App/Chat/Tools/Heartbeat",
  component: HeartbeatToolCall,
  parameters: {
    ...lightweightMeta.parameters,
    // The repo-wide Chromatic snapshot budget (tests/ui/storybook/budget.test.ts) is
    // already at its ceiling, so these states stay out of paid visual snapshots. They
    // still render under local Storybook and the CI Storybook test-runner smoke pass.
    // Flip to CHROMATIC_SINGLE_MODE once the budget is raised to add regression coverage.
    chromatic: CHROMATIC_DISABLED,
  },
  decorators: [
    (Story) => (
      <StoryUiShell>
        <div className="bg-background p-6">
          <div className="w-full max-w-2xl">
            <Story />
          </div>
        </div>
      </StoryUiShell>
    ),
  ],
} satisfies Meta<typeof HeartbeatToolCall>;

export default meta;

type Story = StoryObj<typeof meta>;

const TASK_PROMPT =
  "Check the CI run for the auth refactor. If it's green, open the PR; if it's red, " +
  "summarize the first failure and stop.";

/** set · enabled with a custom task prompt (expanded to show the full schedule). */
export const ScheduledEnabled: Story = {
  args: {
    args: {
      action: "set",
      enabled: true,
      intervalMs: 30 * 60_000,
      contextMode: "normal",
      message: TASK_PROMPT,
    },
    status: "completed",
    defaultExpanded: true,
    result: {
      success: true,
      action: "set",
      configured: true,
      settings: {
        enabled: true,
        intervalMs: 30 * 60_000,
        contextMode: "normal",
        message: TASK_PROMPT,
      },
      summary: "Heartbeat is enabled for this workspace at 30 minutes.",
    },
  },
};

/**
 * set · long cadence that compacts context first, with no custom message — exercises
 * the default-prompt fallback (the common case, since `message` is only stored when set).
 */
export const LongCadenceCompact: Story = {
  args: {
    args: { action: "set", enabled: true, intervalMs: 2 * 3_600_000, contextMode: "compact" },
    status: "completed",
    defaultExpanded: true,
    result: {
      success: true,
      action: "set",
      configured: true,
      settings: { enabled: true, intervalMs: 2 * 3_600_000, contextMode: "compact" },
      summary: "Heartbeat is enabled for this workspace at 2 hours.",
    },
  },
};

/** get · reads current settings (reset context mode). */
export const ReadReset: Story = {
  args: {
    args: { action: "get" },
    status: "completed",
    defaultExpanded: true,
    result: {
      success: true,
      action: "get",
      configured: true,
      settings: {
        enabled: true,
        intervalMs: 3_600_000,
        contextMode: "reset",
        message: HEARTBEAT_DEFAULT_MESSAGE_BODY,
      },
      summary: "Heartbeat is enabled for this workspace at 1 hour.",
    },
  },
};

/** set · kept but paused (amber). */
export const Paused: Story = {
  args: {
    args: { action: "set", enabled: false },
    status: "completed",
    defaultExpanded: true,
    result: {
      success: true,
      action: "set",
      configured: true,
      settings: {
        enabled: false,
        intervalMs: 30 * 60_000,
        contextMode: "normal",
        message: HEARTBEAT_DEFAULT_MESSAGE_BODY,
      },
      summary: "Heartbeat is disabled for this workspace at 30 minutes.",
    },
  },
};

/** get · nothing configured for this workspace. */
export const ReadNotConfigured: Story = {
  args: {
    args: { action: "get" },
    status: "completed",
    defaultExpanded: true,
    result: {
      success: true,
      action: "get",
      configured: false,
      settings: null,
      summary: "No heartbeat settings are configured for this workspace.",
    },
  },
};

/** unset · schedule removed. */
export const Cleared: Story = {
  args: {
    args: { action: "unset" },
    status: "completed",
    defaultExpanded: true,
    result: {
      success: true,
      action: "unset",
      configured: false,
      settings: null,
      summary: "Heartbeat settings removed for this workspace.",
    },
  },
};

/** Mid-flight, before the result arrives. */
export const Executing: Story = {
  args: {
    args: { action: "set", enabled: true, intervalMs: 30 * 60_000 },
    status: "executing",
    defaultExpanded: true,
  },
};

/** Error · interval outside the supported range. */
export const ErrorOutOfRange: Story = {
  args: {
    args: { action: "set", intervalMs: 30_000 },
    status: "failed",
    defaultExpanded: true,
    result: { success: false, error: "intervalMs must be between 5 minutes and 24 hours." },
  },
};
