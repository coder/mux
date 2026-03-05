import type { AppStory } from "@/browser/stories/meta.js";
import { appMeta, AppWithMocks } from "@/browser/stories/meta.js";
import {
  STABLE_TIMESTAMP,
  createAssistantMessage,
  createGenericTool,
  createUserMessage,
} from "@/browser/stories/mockFactory";
import { setupSimpleChatStory } from "@/browser/stories/storyHelpers.js";

const meta = { ...appMeta, title: "App/Chat/Tools/SwitchAgent" };
export default meta;

/** switch_agent tool call rendered with custom handoff card UI */
export const SwitchAgentHandoff: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          workspaceId: "ws-switch-agent",
          messages: [
            createUserMessage("msg-1", "Should we plan this migration before editing files?", {
              historySequence: 1,
              timestamp: STABLE_TIMESTAMP - 100000,
            }),
            createAssistantMessage("msg-2", "I'll hand this off to the planning agent first.", {
              historySequence: 2,
              timestamp: STABLE_TIMESTAMP - 90000,
              toolCalls: [
                createGenericTool(
                  "call-switch-agent-1",
                  "switch_agent",
                  {
                    agentId: "plan",
                    reason:
                      "This requires a scoped rollout plan with risk assessment before making code edits.",
                    followUp:
                      "Draft a migration plan that lists dependencies, sequencing, and rollback steps.",
                  },
                  {
                    ok: true,
                    agentId: "plan",
                  }
                ),
              ],
            }),
            createUserMessage(
              "msg-3",
              "Draft a migration plan that lists dependencies, sequencing, and rollback steps.",
              {
                historySequence: 3,
                timestamp: STABLE_TIMESTAMP - 85000,
                synthetic: true,
              }
            ),
          ],
        })
      }
    />
  ),
};
