import type { ReactNode } from "react";
import { waitFor, within } from "@storybook/test";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { GoogleSearchToolCall } from "@/browser/features/Tools/GoogleSearchToolCall";
import { lightweightMeta } from "@/browser/stories/meta.js";
import {
  SAMPLE_GOOGLE_SEARCH_QUERIES,
  SAMPLE_SEARCH_SUGGESTIONS_HTML,
} from "@/browser/features/Tools/GoogleSearchToolCall.fixtures";

const meta = {
  ...lightweightMeta,
  title: "App/Chat/Tools/GoogleSearch",
  component: GoogleSearchToolCall,
} satisfies Meta<typeof GoogleSearchToolCall>;

export default meta;

type Story = StoryObj<typeof meta>;

function ToolStoryShell(props: { children: ReactNode }) {
  return (
    <div className="bg-background p-6">
      <div className="w-full max-w-2xl">{props.children}</div>
    </div>
  );
}

/** Completed grounding call: queries + parsed suggestion chips, expanded via play. */
export const Completed: Story = {
  args: {
    args: { queries: SAMPLE_GOOGLE_SEARCH_QUERIES },
    result: { search_suggestions: SAMPLE_SEARCH_SUGGESTIONS_HTML },
    status: "completed",
  },
  render: (args) => (
    <ToolStoryShell>
      <GoogleSearchToolCall {...args} />
    </ToolStoryShell>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    canvas.getByText("Google Search").click();
    await waitFor(() => canvas.getByText("Suggested searches"));
  },
};

/** Provider is still executing the search: no result yet, loading details. */
export const Executing: Story = {
  args: {
    args: { queries: SAMPLE_GOOGLE_SEARCH_QUERIES.slice(0, 2) },
    status: "executing",
  },
  render: (args) => (
    <ToolStoryShell>
      <GoogleSearchToolCall {...args} />
    </ToolStoryShell>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    canvas.getByText("Google Search").click();
    await waitFor(() => canvas.getByText("Searching"));
  },
};

/** Collapsed single-query row (no "+N more" badge). */
export const SingleQueryCollapsed: Story = {
  args: {
    args: { queries: [SAMPLE_GOOGLE_SEARCH_QUERIES[0] ?? ""] },
    result: { search_suggestions: SAMPLE_SEARCH_SUGGESTIONS_HTML },
    status: "completed",
  },
  render: (args) => (
    <ToolStoryShell>
      <GoogleSearchToolCall {...args} />
    </ToolStoryShell>
  ),
};
