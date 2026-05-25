import type { Meta, StoryObj } from "@storybook/react-vite";
import { lightweightMeta } from "@/browser/stories/meta.js";
import { ConcurrentLocalWarningDecoration } from "./ConcurrentLocalWarning.js";

const meta = {
  ...lightweightMeta,
  title: "App/Chat/Components/ConcurrentLocalWarning",
  component: ConcurrentLocalWarningDecoration,
} satisfies Meta<typeof ConcurrentLocalWarningDecoration>;

export default meta;

type Story = StoryObj<typeof meta>;

export const ComposerDecoration: Story = {
  args: {
    streamingWorkspaceName: "refactor-db",
  },
  render: (args) => (
    <div className="bg-surface-primary text-light flex h-[360px] flex-col">
      <div className="min-h-0 flex-1 overflow-hidden p-4">
        <div className="mx-auto max-w-4xl space-y-4 text-sm">
          <div className="ml-auto max-w-[70%] rounded-lg border border-[var(--color-user-border)] bg-[var(--color-user-surface)] px-3 py-2">
            Can you keep working while I ask another agent to inspect the same checkout?
          </div>
          <div className="border-border bg-background-secondary text-muted rounded-lg border px-3 py-2">
            I&apos;ll continue here, but there is another local workspace actively running in this
            project directory.
          </div>
        </div>
      </div>
      {/* Keep the warning in the composer decoration lane so appended transcript rows do not
          insert above it and trigger bottom-lock correction flashes. */}
      <ConcurrentLocalWarningDecoration {...args} />
      <div className="border-border bg-surface-primary border-t px-4 py-3">
        <div className="border-border bg-background-secondary text-muted mx-auto max-w-4xl rounded-lg border px-3 py-2 text-sm">
          Ask Mux anything...
        </div>
      </div>
    </div>
  ),
  tags: ["concurrent-local-warning"],
  parameters: {
    docs: {
      description: {
        story:
          "Shows the concurrent local-agent warning pinned in the composer decoration lane, above the input and outside the transcript scroll flow.",
      },
    },
  },
};
