import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";

import { CoalescedToolCall } from "@/browser/features/Tools/CoalescedToolCall";
import { lightweightMeta } from "@/browser/stories/meta.js";

const meta = {
  ...lightweightMeta,
  title: "App/Chat/Tools/CoalescedToolCall",
  component: CoalescedToolCall,
  decorators: [
    (Story) => (
      <div className="bg-background p-6">
        <div className="w-full max-w-3xl">
          <Story />
        </div>
      </div>
    ),
  ],
} satisfies Meta<typeof CoalescedToolCall>;

export default meta;

type Story = StoryObj<typeof meta>;

function InteractiveCoalesced(
  args: Omit<React.ComponentProps<typeof CoalescedToolCall>, "expanded" | "onToggle">
) {
  const [expanded, setExpanded] = useState(false);
  return (
    <CoalescedToolCall {...args} expanded={expanded} onToggle={() => setExpanded((e) => !e)} />
  );
}

export const TwoReads: Story = {
  args: {
    kind: "file_read",
    filePaths: ["src/App.tsx", "src/main.ts"],
    expanded: false,
    onToggle: () => undefined,
  },
  render: (args) => <InteractiveCoalesced {...args} />,
};

export const ManyReads: Story = {
  args: {
    kind: "file_read",
    filePaths: [
      "src/App.tsx",
      "src/main.ts",
      "src/preload.ts",
      "src/config.ts",
      "src/browser/features/Tools/CoalescedToolCall.tsx",
    ],
    expanded: false,
    onToggle: () => undefined,
  },
  render: (args) => <InteractiveCoalesced {...args} />,
};

export const TwoEdits: Story = {
  args: {
    kind: "file_edit",
    filePaths: ["src/App.tsx", "src/main.ts"],
    expanded: false,
    onToggle: () => undefined,
  },
  render: (args) => <InteractiveCoalesced {...args} />,
};

export const ExpandedReads: Story = {
  args: {
    kind: "file_read",
    filePaths: ["src/App.tsx", "src/main.ts", "src/preload.ts"],
    expanded: true,
    onToggle: () => undefined,
  },
};
