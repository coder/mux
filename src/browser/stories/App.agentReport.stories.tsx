/**
 * Storybook stories for the agent_report tool UI.
 *
 * This tool is primarily used inside sub-agents to report back a final markdown summary.
 */

import type { Meta, StoryObj } from "@storybook/react-vite";
import { AgentReportToolCall as AgentReportToolCallCard } from "@/browser/features/Tools/AgentReportToolCall";
import { lightweightMeta } from "./meta.js";

const meta = {
  ...lightweightMeta,
  title: "App/Agent Report Tool",
  component: AgentReportToolCallCard,
} satisfies Meta<typeof AgentReportToolCallCard>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * Renders an agent_report tool call as a proper tool card with markdown.
 *
 * This is what you should see inside a sub-agent when it emits its final report.
 */
export const AgentReportToolCall: Story = {
  render: () => (
    <div className="bg-background flex min-h-screen items-start p-6">
      <div className="w-full max-w-2xl">
        <AgentReportToolCallCard
          args={{
            title: "Agent report",
            reportMarkdown: `## Summary

- The \`agent_report\` tool now renders as a first-class tool card.
- The report body is displayed using the same markdown pipeline as \`task\` / \`task_await\`.

## Notes

<details>
<summary>Implementation details</summary>

- Uses \`MarkdownRenderer\` for consistent formatting (GFM, math, mermaid, etc.).
- Defaults to expanded since the report is the entire point of the tool.

</details>`,
          }}
          result={{ success: true }}
          status="completed"
        />
      </div>
    </div>
  ),
};
