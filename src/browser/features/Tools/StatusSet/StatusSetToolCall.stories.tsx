import type { Meta, StoryObj } from "@storybook/react-vite";
import { StatusSetToolCall } from "@/browser/features/Tools/StatusSetToolCall";
import { lightweightMeta } from "@/browser/stories/meta.js";

const meta = {
  ...lightweightMeta,
  title: "App/Chat/Tools/StatusSet",
  component: StatusSetToolCall,
} satisfies Meta<typeof StatusSetToolCall>;

export default meta;

type Story = StoryObj<typeof meta>;

/** Chat with agent status indicator */
export const WithAgentStatus: Story = {
  args: {
    args: {
      emoji: "🚀",
      message: "PR #1234 waiting for CI",
      url: "https://github.com/example/repo/pull/1234",
    },
    result: {
      success: true,
      emoji: "🚀",
      message: "PR #1234 waiting for CI",
      url: "https://github.com/example/repo/pull/1234",
    },
    status: "completed",
  },
};
