import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "@storybook/test";
import { lightweightMeta } from "@/browser/stories/meta.js";
import { StreamingBarrierView } from "./StreamingBarrierView";

const meta = {
  ...lightweightMeta,
  title: "App/Chat/Barriers/Streaming",
  component: StreamingBarrierView,
  render: (args) => (
    <div className="bg-background flex min-h-screen items-start p-6">
      <div className="w-full max-w-3xl rounded-md border border-[var(--color-border-medium)] bg-[var(--color-card)] p-4">
        <StreamingBarrierView {...args} />
      </div>
    </div>
  ),
} satisfies Meta<typeof StreamingBarrierView>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * Frontend display for the first-init SSH diagnostic state while the workspace
 * is still waiting for initialization to complete.
 */
export const WaitingForWorkspaceInitialization: Story = {
  args: {
    statusText: "Waiting for workspace initialization...",
    cancelText: "hit Esc to cancel",
    cancelShortcutText: "Esc",
    onCancel: fn(),
  },
  parameters: {
    docs: {
      description: {
        story:
          "Shows the startup diagnostic users see when an SSH workspace is still in first-init setup and the frontend is waiting for workspace initialization.",
      },
    },
  },
};

/**
 * Frontend display for the later startup diagnostic state after runtime
 * readiness, when the request is still assembling tools.
 */
export const LoadingToolsDiagnostic: Story = {
  args: {
    statusText: "Loading tools...",
    cancelText: "hit Esc to cancel",
    cancelShortcutText: "Esc",
    onCancel: fn(),
  },
  parameters: {
    docs: {
      description: {
        story:
          "Shows the more specific startup diagnostic text after runtime readiness succeeds but request startup is still blocked on tool assembly.",
      },
    },
  },
};
