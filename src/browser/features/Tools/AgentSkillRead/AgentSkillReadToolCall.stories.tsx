import type { AppStory } from "@/browser/stories/meta.js";
import { appMeta, AppWithMocks } from "@/browser/stories/meta.js";
import {
  STABLE_TIMESTAMP,
  createAgentSkillReadTool,
  createAssistantMessage,
  createUserMessage,
} from "@/browser/stories/mockFactory";
import { setupSimpleChatStory } from "@/browser/stories/storyHelpers.js";

const meta = { ...appMeta, title: "App/Chat/Tools/AgentSkillRead" };
export default meta;

/** Chat showing loaded skills via agent_skill_read tool calls */
export const WithLoadedSkills: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          workspaceId: "ws-skills-loaded",
          messages: [
            createUserMessage("msg-1", "Help me write tests for this component", {
              historySequence: 1,
              timestamp: STABLE_TIMESTAMP - 120000,
            }),
            createAssistantMessage(
              "msg-2",
              "I'll load the testing skill to follow project conventions.",
              {
                historySequence: 2,
                timestamp: STABLE_TIMESTAMP - 115000,
                toolCalls: [
                  createAgentSkillReadTool("tc-1", "tests", {
                    description: "Testing doctrine, commands, and test layout conventions",
                    scope: "project",
                  }),
                ],
              }
            ),
            createAssistantMessage(
              "msg-3",
              "I'll also load the React effects skill since this is a React component.",
              {
                historySequence: 3,
                timestamp: STABLE_TIMESTAMP - 110000,
                toolCalls: [
                  createAgentSkillReadTool("tc-2", "react-effects", {
                    description: "Guidelines for when to use (and avoid) useEffect in React",
                    scope: "project",
                  }),
                ],
              }
            ),
            createAssistantMessage(
              "msg-4",
              "Now I can write tests that follow your project's testing patterns.",
              {
                historySequence: 4,
                timestamp: STABLE_TIMESTAMP - 100000,
              }
            ),
          ],
          // Available skills organized by scope: Project (3), Global (1), Built-in (1)
          // Loaded: tests, react-effects
          agentSkills: [
            // Project skills
            {
              name: "tests",
              description: "Testing doctrine, commands, and test layout conventions",
              scope: "project",
            },
            {
              name: "react-effects",
              description: "Guidelines for when to use (and avoid) useEffect in React",
              scope: "project",
            },
            {
              name: "pull-requests",
              description: "Guidelines for creating and managing Pull Requests",
              scope: "project",
            },
            // Global skill
            {
              name: "my-company-style",
              description: "Company-wide coding style and conventions",
              scope: "global",
            },
            // Built-in skill
            {
              name: "init",
              description: "Bootstrap an AGENTS.md file in a new or existing project",
              scope: "built-in",
            },
          ],
        })
      }
    />
  ),
};

/** Chat showing a skill invocation command on user messages */
export const WithSkillCommand: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          workspaceId: "ws-skill",
          messages: [
            createUserMessage("msg-1", "/react-effects Audit this effect for stale closures", {
              historySequence: 1,
              timestamp: STABLE_TIMESTAMP - 120000,
              muxMetadata: {
                type: "agent-skill",
                rawCommand: "/react-effects Audit this effect for stale closures",
                commandPrefix: "/react-effects",
                skillName: "react-effects",
                scope: "project",
              },
            }),
            createAssistantMessage(
              "msg-2",
              "I'll review the effect with the react-effects skill and report any stale closure risks.",
              {
                historySequence: 2,
                timestamp: STABLE_TIMESTAMP - 110000,
              }
            ),
          ],
        })
      }
    />
  ),
};
