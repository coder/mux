import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ReactNode } from "react";
import { useState } from "react";

import { CoalescedToolCall } from "@/browser/features/Tools/CoalescedToolCall";
import { CHROMATIC_DISABLED, lightweightMeta } from "@/browser/stories/meta.js";

/**
 * Layout shell rendered inside each story so the meta-level decorator
 * stack (which provides `TooltipProvider` via `StoryUiShell`) is not
 * shadowed by a story-local `decorators` override.
 */
function StoryLayout(props: { children: ReactNode }) {
  return (
    <div className="bg-background p-6">
      <div className="w-full max-w-3xl">{props.children}</div>
    </div>
  );
}

// These stories are visual references for the coalesce row; they don't add
// regression-meaningful coverage beyond the unit/test files in this folder,
// so opt out of Chromatic snapshots to stay under the global snapshot budget.
const meta = {
  ...lightweightMeta,
  title: "App/Chat/Tools/CoalescedToolCall",
  component: CoalescedToolCall,
  parameters: {
    ...lightweightMeta.parameters,
    chromatic: CHROMATIC_DISABLED,
  },
} satisfies Meta<typeof CoalescedToolCall>;

export default meta;

type Story = StoryObj<typeof meta>;

function InteractiveCoalesced(
  args: Omit<React.ComponentProps<typeof CoalescedToolCall>, "expanded" | "onToggle">
) {
  const [expanded, setExpanded] = useState(false);
  return (
    <StoryLayout>
      <CoalescedToolCall {...args} expanded={expanded} onToggle={() => setExpanded((e) => !e)} />
    </StoryLayout>
  );
}

const NOOP = () => undefined;

export const TwoReads: Story = {
  args: {
    kind: "file_read",
    filePaths: ["src/App.tsx", "src/main.ts"],
    expanded: false,
    onToggle: NOOP,
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
    onToggle: NOOP,
  },
  render: (args) => <InteractiveCoalesced {...args} />,
};

export const TwoEdits: Story = {
  args: {
    kind: "file_edit",
    filePaths: ["src/App.tsx", "src/main.ts"],
    expanded: false,
    onToggle: NOOP,
  },
  render: (args) => <InteractiveCoalesced {...args} />,
};

export const ExpandedReads: Story = {
  args: {
    kind: "file_read",
    filePaths: ["src/App.tsx", "src/main.ts", "src/preload.ts"],
    expanded: true,
    onToggle: NOOP,
  },
  render: (args) => (
    <StoryLayout>
      <CoalescedToolCall {...args} />
    </StoryLayout>
  ),
};
