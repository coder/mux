import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ReactNode } from "react";

import { CoalescedToolCall } from "@/browser/features/Tools/CoalescedToolCall";
import { lightweightMeta } from "@/browser/stories/meta.js";

/**
 * Chromatic-snapshotted story for the new coalesced-tool-call row.
 *
 * Most coverage for `CoalescedToolCall` lives in the sibling
 * `CoalescedToolCall.stories.tsx` file, which is Chromatic-disabled and uses
 * `play` functions to exercise click-to-expand, dedupe, and the kind-specific
 * verb. This file deliberately contains a single visual baseline — the
 * collapsed `Read files …` row — so reviewers get one pinned snapshot of the
 * canonical new behavior without pushing the global snapshot budget over.
 */

function StoryLayout(props: { children: ReactNode }) {
  return (
    <div className="bg-background p-6">
      <div className="w-full max-w-3xl">{props.children}</div>
    </div>
  );
}

const NOOP = () => undefined;

const meta = {
  ...lightweightMeta,
  title: "App/Chat/Tools/CoalescedToolCall (visual)",
  component: CoalescedToolCall,
  render: (args) => (
    <StoryLayout>
      <CoalescedToolCall {...args} />
    </StoryLayout>
  ),
} satisfies Meta<typeof CoalescedToolCall>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * Collapsed coalesce row for a two-file read burst — the headline new UX. The
 * adjacent interactions file covers expansion, dedupe, and the `file_edit`
 * verb in play functions.
 */
export const CollapsedReadFiles: Story = {
  args: {
    kind: "file_read",
    filePaths: ["src/App.tsx", "src/main.ts"],
    expanded: false,
    onToggle: NOOP,
  },
};
