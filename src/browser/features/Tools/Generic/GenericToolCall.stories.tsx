import type { Meta, StoryObj } from "@storybook/react-vite";
import { GenericToolCall } from "@/browser/features/Tools/GenericToolCall";
import { lightweightMeta } from "@/browser/stories/meta.js";

const meta = {
  ...lightweightMeta,
  title: "App/Chat/Tools/Generic",
  component: GenericToolCall,
} satisfies Meta<typeof GenericToolCall>;

export default meta;

type Story = StoryObj<typeof meta>;

/** Generic tool call with JSON-highlighted arguments and results */
export const GenericTool: Story = {
  args: {
    toolName: "fetch_data",
    args: {
      endpoint: "/api/users",
      params: { limit: 100, offset: 0 },
    },
    result: {
      success: true,
      // Generate 100+ line result to test line number alignment
      data: Array.from({ length: 50 }, (_, i) => ({
        id: i + 1,
        name: `User ${i + 1}`,
        email: `user${i + 1}@example.com`,
        active: i % 3 !== 0,
      })),
      total: 500,
      page: 1,
    },
    status: "completed",
  },
  parameters: {
    docs: {
      description: {
        story: "Generic tool call with JSON syntax highlighting and 100+ lines.",
      },
    },
  },
};
