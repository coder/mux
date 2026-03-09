import type { Meta, StoryObj } from "@storybook/react-vite";
import { InitMessage } from "@/browser/features/Messages/InitMessage";
import { STABLE_TIMESTAMP } from "@/browser/stories/mockFactory";
import { lightweightMeta } from "@/browser/stories/meta.js";
import type { DisplayedMessage } from "@/common/types/message";

type WorkspaceInitMessage = Extract<DisplayedMessage, { type: "workspace-init" }>;

const INIT_SUCCESS_MESSAGE: WorkspaceInitMessage = {
  type: "workspace-init",
  id: "init-success",
  historySequence: 1,
  status: "success",
  hookPath: "/home/user/projects/my-app/.mux/init.sh",
  lines: [
    { line: "Installing dependencies...", isError: false },
    { line: "Setting up environment variables...", isError: false },
    { line: "Starting development server...", isError: false },
  ],
  exitCode: 0,
  timestamp: STABLE_TIMESTAMP - 106000,
  durationMs: 3000,
};

const INIT_ERROR_MESSAGE: WorkspaceInitMessage = {
  type: "workspace-init",
  id: "init-error",
  historySequence: 1,
  status: "error",
  hookPath: "/home/user/projects/my-app/.mux/init.sh",
  lines: [
    { line: "Installing dependencies...", isError: false },
    { line: "Failed to install package 'missing-dep'", isError: true },
    { line: "npm ERR! code E404", isError: true },
  ],
  exitCode: 1,
  timestamp: STABLE_TIMESTAMP - 107000,
  durationMs: 3000,
};

const meta = {
  ...lightweightMeta,
  title: "App/Chat/Messages/Init",
  component: InitMessage,
  render: (args) => (
    <div className="bg-background flex min-h-screen items-start p-6">
      <div className="w-full max-w-2xl">
        <InitMessage {...args} />
      </div>
    </div>
  ),
} satisfies Meta<typeof InitMessage>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * Story showing the InitMessage component in success state.
 * Tests the workspace init hook display with completed status.
 */
export const InitHookSuccess: Story = {
  args: {
    message: INIT_SUCCESS_MESSAGE,
  },
  parameters: {
    docs: {
      description: {
        story:
          "Shows the InitMessage component after a successful init hook execution. " +
          "The message displays with a green checkmark, hook path, and output lines.",
      },
    },
  },
};

/**
 * Story showing the InitMessage component in error state.
 * Tests the workspace init hook display with failed status.
 */
export const InitHookError: Story = {
  args: {
    message: INIT_ERROR_MESSAGE,
  },
  parameters: {
    docs: {
      description: {
        story:
          "Shows the InitMessage component after a failed init hook execution. " +
          "The message displays with a red alert icon, error styling, and error output.",
      },
    },
  },
};
