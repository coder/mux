import type { Meta, StoryObj } from "@storybook/react-vite";
import { SwitchAgentToolCall } from "@/browser/features/Tools/SwitchAgentToolCall";
import { lightweightMeta } from "@/browser/stories/meta.js";

const meta = {
  ...lightweightMeta,
  title: "App/Chat/Tools/SwitchAgent",
  component: SwitchAgentToolCall,
} satisfies Meta<typeof SwitchAgentToolCall>;

export default meta;

type Story = StoryObj<typeof meta>;

/** switch_agent tool call rendered with custom handoff card UI */
export const SwitchAgentHandoff: Story = {
  args: {
    args: {
      agentId: "plan",
      reason:
        "This requires a scoped rollout plan with risk assessment before making code edits.",
      followUp:
        "Draft a migration plan that lists dependencies, sequencing, and rollback steps.",
    },
    status: "completed",
  },
};
