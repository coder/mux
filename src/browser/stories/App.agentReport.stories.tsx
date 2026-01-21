/**
 * Storybook stories for the agent_report tool UI.
 *
 * This tool is primarily used inside sub-agents to report back a final markdown summary.
 */

import { appMeta, AppWithMocks, type AppStory } from "./meta.js";
import { setupSimpleChatStory } from "./storyHelpers";
import {
  blurActiveElement,
  waitForChatInputAutofocusDone,
  waitForScrollStabilization,
} from "./storyPlayHelpers";
import {
  STABLE_TIMESTAMP,
  createAssistantMessage,
  createGenericTool,
  createUserMessage,
} from "./mockFactory";

export default {
  ...appMeta,
  title: "App/Agent Report Tool",
};

/**
 * Renders an agent_report tool call as a proper tool card with markdown.
 *
 * This is what you should see inside a sub-agent when it emits its final report.
 */
export const AgentReportToolCall: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          workspaceId: "ws-agent-report",
          workspaceName: "subagent/explore",
          messages: [
            createUserMessage("u1", "Investigate the tool rendering issue", {
              historySequence: 1,
              timestamp: STABLE_TIMESTAMP - 60000,
            }),
            createAssistantMessage("a1", "Here's my final report:", {
              historySequence: 2,
              timestamp: STABLE_TIMESTAMP - 59000,
              toolCalls: [
                createGenericTool(
                  "tc1",
                  "agent_report",
                  {
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
                  },
                  { success: true }
                ),
              ],
            }),
          ],
        })
      }
    />
  ),
  play: async ({ canvasElement }) => {
    await waitForScrollStabilization(canvasElement);
    await waitForChatInputAutofocusDone(canvasElement);
    blurActiveElement();
  },
};
