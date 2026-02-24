/**
 * Chat messages & interactions stories
 */

import { appMeta, AppWithMocks, type AppStory } from "./meta.js";
import {
  STABLE_TIMESTAMP,
  createUserMessage,
  createAssistantMessage,
  createCompactionRequestMessage,
  createFileReadTool,
  createFileEditTool,
  createTerminalTool,
  createStatusTool,
  createGenericTool,
  createPendingTool,
  createProposePlanTool,
  createWebSearchTool,
  createBashTool,
  createAgentSkillReadTool,
  withHookOutput,
} from "./mockFactory";

import type { WorkspaceChatMessage } from "@/common/orpc/types";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import { setWorkspaceModelWithOrigin } from "@/browser/utils/modelChange";
import { getModelKey } from "@/common/constants/storage";
import { waitForChatMessagesLoaded } from "./storyPlayHelpers.js";
import { setupSimpleChatStory, setupStreamingChatStory, setWorkspaceInput } from "./storyHelpers";
import { within, userEvent, waitFor } from "@storybook/test";
import { warmHashCache, setShareData } from "@/browser/utils/sharedUrlCache";

import { MODEL_ABBREVIATION_EXAMPLES } from "@/common/constants/knownModels";
import { formatKeybind, KEYBINDS } from "@/browser/utils/ui/keybinds";
import {
  HelpIndicator,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/browser/components/ui/tooltip";
import { WORKSPACE_DEFAULTS } from "@/constants/workspaceDefaults";
import {
  PLAN_AUTO_ROUTING_STATUS_EMOJI,
  PLAN_AUTO_ROUTING_STATUS_MESSAGE,
} from "@/common/constants/planAutoRoutingStatus";

export default {
  ...appMeta,
  title: "App/Chat",
};

const DEFAULT_AGENT_LABEL =
  WORKSPACE_DEFAULTS.agentId.slice(0, 1).toUpperCase() + WORKSPACE_DEFAULTS.agentId.slice(1);

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

/** Basic chat conversation with various message types */
export const Conversation: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          messages: [
            createUserMessage("msg-1", "Add authentication to the user API endpoint", {
              historySequence: 1,
              timestamp: STABLE_TIMESTAMP - 300000,
            }),
            createAssistantMessage(
              "msg-2",
              "I'll help you add authentication. Let me search for best practices first.",
              {
                historySequence: 2,
                timestamp: STABLE_TIMESTAMP - 295000,
                toolCalls: [createWebSearchTool("call-0", "JWT authentication best practices", 5)],
              }
            ),
            createAssistantMessage("msg-3", "Great, let me check the current implementation.", {
              historySequence: 3,
              timestamp: STABLE_TIMESTAMP - 290000,
              toolCalls: [
                createFileReadTool(
                  "call-1",
                  "src/api/users.ts",
                  "export function getUser(req, res) {\n  const user = db.users.find(req.params.id);\n  res.json(user);\n}"
                ),
              ],
            }),
            createUserMessage("msg-4", "Yes, add JWT token validation", {
              historySequence: 4,
              timestamp: STABLE_TIMESTAMP - 280000,
            }),
            createAssistantMessage("msg-5", "I'll add JWT validation. Here's the update:", {
              historySequence: 5,
              timestamp: STABLE_TIMESTAMP - 270000,
              toolCalls: [
                createFileEditTool(
                  "call-2",
                  "src/api/users.ts",
                  [
                    "--- src/api/users.ts",
                    "+++ src/api/users.ts",
                    "@@ -1,5 +1,15 @@",
                    "+import { verifyToken } from '../auth/jwt';",
                    " export function getUser(req, res) {",
                    "+  const token = req.headers.authorization?.split(' ')[1];",
                    "+  if (!token || !verifyToken(token)) {",
                    "+    return res.status(401).json({ error: 'Unauthorized' });",
                    "+  }",
                    "   const user = db.users.find(req.params.id);",
                    "   res.json(user);",
                    " }",
                  ].join("\n")
                ),
              ],
            }),
          ],
        })
      }
    />
  ),
};

/** Chat with reasoning/thinking blocks */
/** Synthetic auto-resume messages shown with "AUTO" badge and dimmed opacity */
export const SyntheticAutoResumeMessages: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          messages: [
            createUserMessage("msg-1", "Run the full test suite and fix any failures", {
              historySequence: 1,
              timestamp: STABLE_TIMESTAMP - 300000,
            }),
            createAssistantMessage(
              "msg-2",
              "I'll run the tests now. Let me spawn a sub-agent to handle the test execution.",
              {
                historySequence: 2,
                timestamp: STABLE_TIMESTAMP - 295000,
              }
            ),
            createUserMessage(
              "msg-3",
              "You have active background sub-agent task(s) (task-abc123). " +
                "You MUST NOT end your turn while any sub-agent tasks are queued/running/awaiting_report. " +
                "Call task_await now to wait for them to finish.",
              {
                historySequence: 3,
                timestamp: STABLE_TIMESTAMP - 290000,
                synthetic: true,
              }
            ),
            createAssistantMessage("msg-4", "I'll wait for the sub-agent to complete its work.", {
              historySequence: 4,
              timestamp: STABLE_TIMESTAMP - 285000,
            }),
            createUserMessage(
              "msg-5",
              "Your background sub-agent task(s) have completed. Use task_await to retrieve their reports and integrate the results.",
              {
                historySequence: 5,
                timestamp: STABLE_TIMESTAMP - 280000,
                synthetic: true,
              }
            ),
            createAssistantMessage(
              "msg-6",
              "The sub-agent has finished. All 47 tests passed successfully — no failures found.",
              {
                historySequence: 6,
                timestamp: STABLE_TIMESTAMP - 275000,
              }
            ),
          ],
        })
      }
    />
  ),
};

export const WithReasoning: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          workspaceId: "ws-reasoning",
          messages: [
            createUserMessage("msg-1", "What about error handling if the JWT library throws?", {
              historySequence: 1,
              timestamp: STABLE_TIMESTAMP - 100000,
            }),
            createAssistantMessage(
              "msg-2",
              "Good catch! We should add try-catch error handling around the JWT verification.",
              {
                historySequence: 2,
                timestamp: STABLE_TIMESTAMP - 90000,
                reasoning:
                  "The user is asking about error handling for JWT verification. The verifyToken function could throw if the token is malformed or if there's an issue with the secret. I should wrap it in a try-catch block and return a proper error response.",
              }
            ),
            createAssistantMessage(
              "msg-3",
              "Cache is warm, shifting focus to documentation next.",
              {
                historySequence: 3,
                timestamp: STABLE_TIMESTAMP - 80000,
                reasoning: "Cache is warm already; rerunning would be redundant.",
              }
            ),
          ],
        })
      }
    />
  ),
};

/** Chat with terminal output showing test results */
export const WithTerminal: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          workspaceId: "ws-terminal",
          messages: [
            createUserMessage("msg-1", "Can you run the tests?", {
              historySequence: 1,
              timestamp: STABLE_TIMESTAMP - 100000,
            }),
            createAssistantMessage("msg-2", "Running the test suite now:", {
              historySequence: 2,
              timestamp: STABLE_TIMESTAMP - 90000,
              toolCalls: [
                createTerminalTool(
                  "call-1",
                  "npm test",
                  [
                    "PASS src/api/users.test.ts",
                    "  ✓ should return user when authenticated (24ms)",
                    "  ✓ should return 401 when no token (18ms)",
                    "  ✓ should return 401 when invalid token (15ms)",
                    "",
                    "Test Suites: 1 passed, 1 total",
                    "Tests:       3 passed, 3 total",
                  ].join("\n")
                ),
              ],
            }),
            createAssistantMessage("msg-3", "Here's a failing test for comparison:", {
              historySequence: 3,
              timestamp: STABLE_TIMESTAMP - 80000,
              toolCalls: [
                createTerminalTool(
                  "call-2",
                  "npm test -- --testNamePattern='edge case'",
                  [
                    "FAIL src/api/users.test.ts",
                    "  ✕ should handle edge case (45ms)",
                    "",
                    "Error: Expected 200 but got 500",
                    "  at Object.<anonymous> (src/api/users.test.ts:42:5)",
                    "",
                    "Test Suites: 1 failed, 1 total",
                    "Tests:       1 failed, 1 total",
                  ].join("\n"),
                  1
                ),
              ],
            }),
          ],
        })
      }
    />
  ),
};

/** Chat with agent status indicator */
export const WithAgentStatus: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          workspaceId: "ws-status",
          messages: [
            createUserMessage("msg-1", "Create a PR for the auth changes", {
              historySequence: 1,
              timestamp: STABLE_TIMESTAMP - 100000,
            }),
            createAssistantMessage(
              "msg-2",
              "I've created PR #1234 with the authentication changes.",
              {
                historySequence: 2,
                timestamp: STABLE_TIMESTAMP - 90000,
                toolCalls: [
                  createStatusTool(
                    "call-1",
                    "🚀",
                    "PR #1234 waiting for CI",
                    "https://github.com/example/repo/pull/1234"
                  ),
                ],
              }
            ),
          ],
        })
      }
    />
  ),
};

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

/** Voice input button shows user education when OpenAI API key is not set */
export const VoiceInputNoApiKey: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          messages: [],
          // No OpenAI key configured - voice button should be disabled with tooltip
          providersConfig: {
            anthropic: { apiKeySet: true, isEnabled: true, isConfigured: true },
            // openai deliberately missing
          },
        })
      }
    />
  ),
  parameters: {
    docs: {
      description: {
        story:
          "Shows the voice input button in disabled state when OpenAI API key is not configured. Hover over the mic icon in the chat input to see the user education tooltip.",
      },
    },
  },
};

/** Streaming/working state with pending tool call */
export const Streaming: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupStreamingChatStory({
          messages: [
            createUserMessage("msg-1", "Refactor the database connection to use pooling", {
              historySequence: 1,
              timestamp: STABLE_TIMESTAMP - 3000,
            }),
          ],
          streamingMessageId: "msg-2",
          historySequence: 2,
          streamText: "I'll help you refactor the database connection to use connection pooling.",
          pendingTool: {
            toolCallId: "call-1",
            toolName: "file_read",
            args: { path: "src/db/connection.ts" },
          },
          gitStatus: { dirty: 1 },
        })
      }
    />
  ),
};

/** Streaming/working state with ask_user_question pending */
export const AskUserQuestionPending: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          messages: [
            createUserMessage("msg-1", "Please implement the feature", {
              historySequence: 1,
              timestamp: STABLE_TIMESTAMP - 3000,
            }),
            createAssistantMessage("msg-2", "I have a few clarifying questions.", {
              historySequence: 2,
              timestamp: STABLE_TIMESTAMP - 2000,
              toolCalls: [
                createPendingTool("call-ask-1", "ask_user_question", {
                  questions: [
                    {
                      question: "Which approach should we take?",
                      header: "Approach",
                      options: [
                        { label: "A", description: "Approach A" },
                        { label: "B", description: "Approach B" },
                      ],
                      multiSelect: false,
                    },
                    {
                      question: "Which platforms do we need to support?",
                      header: "Platforms",
                      options: [
                        { label: "macOS", description: "Apple macOS" },
                        { label: "Windows", description: "Microsoft Windows" },
                        { label: "Linux", description: "Linux desktops" },
                      ],
                      multiSelect: true,
                    },
                  ],
                }),
              ],
            }),
          ],
          gitStatus: { dirty: 1 },
        })
      }
    />
  ),
  play: async ({ canvasElement }) => {
    const storyRoot = document.getElementById("storybook-root") ?? canvasElement;
    const canvas = within(storyRoot);

    // Wait for the tool card to appear (header is rendered even when collapsed).
    const toolTitle = await canvas.findByText(/ask_user_question/, {}, { timeout: 8000 });

    // Ensure tool is expanded (question text is inside ToolDetails).
    if (!canvas.queryByText("Summary")) {
      await userEvent.click(toolTitle);
    }

    // Use findAllByRole (retry-capable) instead of getAllByRole to handle
    // transient DOM gaps when the Storybook iframe remounts between awaits.
    const getSectionButton = async (prefix: string): Promise<HTMLElement> => {
      const buttons = await canvas.findAllByRole("button");
      const btn = buttons.find(
        (el) => el.tagName === "BUTTON" && (el.textContent ?? "").startsWith(prefix)
      );
      if (!btn) throw new Error(`${prefix} section button not found`);
      return btn;
    };

    // Ensure we're on the first question.
    await userEvent.click(await getSectionButton("Approach"));

    // Wait for the first question to render.
    try {
      await canvas.findByText("Which approach should we take?", {}, { timeout: 8000 });
    } catch {
      const toolContainerText =
        toolTitle.closest("div")?.parentElement?.textContent?.slice(0, 500) ?? "<missing>";
      throw new Error(
        `AskUserQuestionPending: question UI not found. Tool container: ${toolContainerText}`
      );
    }

    // Selecting a single-select option should auto-advance.
    await userEvent.click(await canvas.findByText("Approach A"));
    await canvas.findByText("Which platforms do we need to support?");

    // Regression: you must be able to jump back to a previous section after answering it.
    await userEvent.click(await getSectionButton("Approach"));

    await canvas.findByText("Which approach should we take?");

    // Give React a tick to run any pending effects; we should still be on question 1.
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (canvas.queryByText("Which platforms do we need to support?")) {
      throw new Error("Unexpected auto-advance when navigating back to a previous question");
    }

    // Changing the answer should still auto-advance.
    await userEvent.click(canvas.getByText("Approach B"));
    await canvas.findByText("Which platforms do we need to support?");
  },
};

/** Completed ask_user_question tool call */
export const AskUserQuestionCompleted: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          messages: [
            createUserMessage("msg-1", "Please implement the feature", {
              historySequence: 1,
              timestamp: STABLE_TIMESTAMP - 60000,
            }),
            createAssistantMessage("msg-2", "I asked some questions.", {
              historySequence: 2,
              timestamp: STABLE_TIMESTAMP - 55000,
              toolCalls: [
                createGenericTool(
                  "call-ask-1",
                  "ask_user_question",
                  {
                    questions: [
                      {
                        question: "Which approach should we take?",
                        header: "Approach",
                        options: [
                          { label: "A", description: "Approach A" },
                          { label: "B", description: "Approach B" },
                        ],
                        multiSelect: false,
                      },
                    ],
                  },
                  {
                    questions: [
                      {
                        question: "Which approach should we take?",
                        header: "Approach",
                        options: [
                          { label: "A", description: "Approach A" },
                          { label: "B", description: "Approach B" },
                        ],
                        multiSelect: false,
                      },
                    ],
                    answers: {
                      "Which approach should we take?": "A",
                    },
                  }
                ),
              ],
            }),
          ],
        })
      }
    />
  ),
};

/**
 * Test "Other" option with auto-resizing textarea.
 * Shows the textarea expanded with multi-line content to demonstrate auto-resize.
 */
export const AskUserQuestionOther: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          messages: [
            createUserMessage("msg-1", "How should I set this up?", {
              historySequence: 1,
              timestamp: STABLE_TIMESTAMP - 3000,
            }),
            createAssistantMessage("msg-2", "Let me ask a few questions.", {
              historySequence: 2,
              timestamp: STABLE_TIMESTAMP - 2000,
              toolCalls: [
                createPendingTool("call-ask-1", "ask_user_question", {
                  questions: [
                    {
                      question: "Describe your use case in detail",
                      header: "Use Case",
                      options: [
                        { label: "Web app", description: "A web application" },
                        { label: "CLI tool", description: "A command-line tool" },
                      ],
                      multiSelect: false,
                    },
                  ],
                  // Pre-fill with "Other" selected to show the textarea
                  answers: {
                    "Describe your use case in detail":
                      "I'm building a complex application.\nIt needs web, CLI, and API support.\nThe architecture should be modular.",
                  },
                }),
              ],
            }),
          ],
          gitStatus: { dirty: 0 },
        })
      }
    />
  ),
};

/** Generic tool call with JSON-highlighted arguments and results */
export const GenericTool: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          messages: [
            createUserMessage("msg-1", "Fetch a large dataset", {
              historySequence: 1,
              timestamp: STABLE_TIMESTAMP - 60000,
            }),
            createAssistantMessage("msg-2", "I'll fetch that data for you.", {
              historySequence: 2,
              timestamp: STABLE_TIMESTAMP - 55000,
              toolCalls: [
                createGenericTool(
                  "call-1",
                  "fetch_data",
                  {
                    endpoint: "/api/users",
                    params: { limit: 100, offset: 0 },
                  },
                  {
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
                  }
                ),
              ],
            }),
          ],
        })
      }
    />
  ),
  parameters: {
    docs: {
      description: {
        story: "Generic tool call with JSON syntax highlighting and 100+ lines.",
      },
    },
  },
};

/** Streaming compaction with shimmer effect - tests GPU-accelerated animation */
export const StreamingCompaction: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupStreamingChatStory({
          workspaceId: "ws-compaction",
          messages: [
            createUserMessage("msg-1", "Help me refactor this codebase", {
              historySequence: 1,
              timestamp: STABLE_TIMESTAMP - 300000,
            }),
            createAssistantMessage(
              "msg-2",
              "I've analyzed the codebase and made several improvements to the architecture.",
              {
                historySequence: 2,
                timestamp: STABLE_TIMESTAMP - 200000,
              }
            ),
            createCompactionRequestMessage("msg-3", {
              historySequence: 3,
              timestamp: STABLE_TIMESTAMP - 3000,
            }),
          ],
          streamingMessageId: "msg-4",
          historySequence: 4,
          streamText:
            "## Conversation Summary\n\nThe user requested help refactoring the codebase. Key changes made:\n\n- Restructured component hierarchy for better separation of concerns\n- Extracted shared utilities into dedicated modules\n- Improved type safety across API boundaries",
        })
      }
    />
  ),
  parameters: {
    docs: {
      description: {
        story:
          "Shows the compaction shimmer effect during streaming. The shimmer uses GPU-accelerated CSS transforms instead of background-position animations to prevent frame drops.",
      },
    },
  },
};

/** Streaming compaction with configure hint - shows when no compaction model is set */
export const StreamingCompactionWithConfigureHint: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        // Ensure no compaction model is set so the "configure" hint appears
        localStorage.removeItem("preferredCompactionModel");

        return setupStreamingChatStory({
          workspaceId: "ws-compaction-hint",
          messages: [
            createUserMessage("msg-1", "Help me with this project", {
              historySequence: 1,
              timestamp: STABLE_TIMESTAMP - 300000,
            }),
            createAssistantMessage(
              "msg-2",
              "I've been helping with various tasks on this project.",
              {
                historySequence: 2,
                timestamp: STABLE_TIMESTAMP - 200000,
              }
            ),
            createCompactionRequestMessage("msg-3", {
              historySequence: 3,
              timestamp: STABLE_TIMESTAMP - 3000,
            }),
          ],
          streamingMessageId: "msg-4",
          historySequence: 4,
          streamText: "## Conversation Summary\n\nSummarizing the conversation...",
        });
      }}
    />
  ),
  parameters: {
    docs: {
      description: {
        story:
          'Shows the "configure" hint link in the streaming barrier during compaction when no custom compaction model is set. Clicking it opens Settings → Models.',
      },
    },
  },
};

/** Chat with running background processes banner */
export const BackgroundProcesses: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          messages: [
            createUserMessage("msg-1", "Start the dev server and run tests in background", {
              historySequence: 1,
              timestamp: STABLE_TIMESTAMP - 60000,
            }),
            createAssistantMessage(
              "msg-2",
              "I've started the dev server and test runner in the background. You can continue working while they run.",
              {
                historySequence: 2,
                timestamp: STABLE_TIMESTAMP - 50000,
                toolCalls: [
                  createTerminalTool(
                    "call-1",
                    "npm run dev &",
                    "Starting dev server on port 3000..."
                  ),
                  createTerminalTool("call-2", "npm test -- --watch &", "Running test suite..."),
                ],
              }
            ),
          ],
          backgroundProcesses: [
            {
              id: "bash_1",
              pid: 12345,
              script: "npm run dev",
              displayName: "Dev Server",
              startTime: Date.now() - 45000, // 45 seconds ago
              status: "running",
            },
            {
              id: "bash_2",
              pid: 12346,
              script: "npm test -- --watch",
              displayName: "Test Runner",
              startTime: Date.now() - 30000, // 30 seconds ago
              status: "running",
            },
            {
              id: "bash_3",
              pid: 12347,
              script: "tail -f /var/log/app.log",
              startTime: Date.now() - 120000, // 2 minutes ago
              status: "running",
            },
          ],
        })
      }
    />
  ),
  parameters: {
    docs: {
      description: {
        story:
          "Shows the background processes banner when there are running background bash processes. Click the banner to expand and see process details or terminate them.",
      },
    },
  },
};

/**
 * Mode selector with HelpIndicator tooltip - verifies props forwarding for Radix asChild.
 *
 * Regression test: HelpIndicator must spread rest props so TooltipTrigger's asChild
 * can attach event handlers for tooltip triggering.
 *
 * The fix ensures HelpIndicator forwards props (like onPointerEnter, onFocus) that
 * Radix TooltipTrigger needs when using asChild. Without the fix, the tooltip
 * would never appear on hover/focus.
 */
export const ModeHelpTooltip: AppStory = {
  render: () => (
    <TooltipProvider>
      <div className="bg-background flex min-h-[180px] items-start p-6">
        <Tooltip>
          <TooltipTrigger asChild>
            <HelpIndicator data-testid="mode-help-indicator">?</HelpIndicator>
          </TooltipTrigger>
          <TooltipContent align="start" className="max-w-80 whitespace-normal">
            <strong>Click to edit</strong>
            <br />
            <strong>{formatKeybind(KEYBINDS.CYCLE_MODEL)}</strong> to cycle models
            <br />
            <br />
            <strong>Abbreviations:</strong>
            {MODEL_ABBREVIATION_EXAMPLES.map((ex) => (
              <span key={ex.abbrev}>
                <br />• <code>/model {ex.abbrev}</code> - {ex.displayName}
              </span>
            ))}
            <br />
            <br />
            <strong>Full format:</strong>
            <br />
            <code>/model provider:model-name</code>
            <br />
            (e.g., <code>/model anthropic:claude-sonnet-4-5</code>)
          </TooltipContent>
        </Tooltip>
      </div>
    </TooltipProvider>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const helpIndicator = await canvas.findByTestId("mode-help-indicator");

    await userEvent.hover(helpIndicator);

    await waitFor(
      () => {
        const tooltip = document.querySelector('[role="tooltip"]');
        if (!(tooltip instanceof HTMLElement)) {
          throw new Error("Tooltip not visible");
        }
        if (!tooltip.textContent?.includes("Click to edit")) {
          throw new Error("Expected model help tooltip content to be visible");
        }
      },
      { interval: 50, timeout: 5000 }
    );
  },

  parameters: {
    docs: {
      description: {
        story:
          "Verifies the model help tooltip trigger works and renders the shortcut/abbreviation guidance content.",
      },
    },
  },
};

/**
 * Model selector pretty display with mux-gateway enabled.
 *
 * Regression test: when gateway is enabled, routing happens in the backend,
 * but the UI should still display the canonical provider:model form
 * (e.g. GPT-4o, not \"Openai/gpt 4o\").
 */
export const ModelSelectorPrettyWithGateway: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        const workspaceId = "ws-gateway-model";
        const baseModel = "openai:gpt-4o";

        // Ensure the gateway indicator is active (so the regression would reproduce).
        updatePersistedState(getModelKey(workspaceId), baseModel);

        return setupSimpleChatStory({
          workspaceId,
          messages: [],
          providersConfig: {
            "mux-gateway": {
              apiKeySet: false,
              isEnabled: true,
              couponCodeSet: true,
              isConfigured: true,
              gatewayModels: [baseModel],
            },
          },
        });
      }}
    />
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    const canvas = within(canvasElement);

    // Wait for chat input to mount.
    await canvas.findAllByText(DEFAULT_AGENT_LABEL, {}, { timeout: 15000 });

    // With gateway enabled, we should still display the *pretty* model name.
    // CI can take longer than the default waitFor timeout while workspace/model
    // state hydrates, so wait explicitly instead of triggering a flaky retry.
    await waitFor(
      () => {
        canvas.getByText("GPT-4o");
      },
      { interval: 50, timeout: 10000 }
    );

    // The buggy rendering (mux-gateway:openai/gpt-4o) shows up as "Openai/gpt 4o".
    const ugly = canvas.queryByText("Openai/gpt 4o");
    if (ugly) {
      throw new Error(`Unexpected gateway-formatted model label: ${ugly.textContent ?? "(empty)"}`);
    }

    // Sanity check that the gateway indicator exists (moved to the titlebar).
    const gatewayIndicator = await waitFor(
      () => {
        const el = canvasElement.querySelector('[aria-label="Mux Gateway"]');
        if (!el) throw new Error("Gateway indicator not found");
        return el;
      },
      { interval: 50, timeout: 15000 }
    );

    // Hover to prove the gateway tooltip is wired up (and keep it visible for snapshot).
    await userEvent.hover(gatewayIndicator);
    await waitFor(
      () => {
        const tooltip = document.querySelector('[role="tooltip"]');
        if (!tooltip) throw new Error("Tooltip not visible");
        if (!tooltip.textContent?.includes("Mux Gateway")) {
          throw new Error("Gateway tooltip not visible");
        }
      },
      { interval: 50, timeout: 5000 }
    );
  },
  parameters: {
    docs: {
      description: {
        story:
          "Verifies the bottom-left model selector stays pretty (e.g. GPT-4o) even when mux-gateway routing is enabled.",
      },
    },
  },
};

/**
 * Model selector dropdown open, showing icon alignment.
 * The gateway toggle and default star icons should appear side-by-side without gaps.
 */
export const ModelSelectorDropdownOpen: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        const workspaceId = "ws-model-dropdown";
        const baseModel = "openai:gpt-4o";

        // Set the selected model for this workspace
        updatePersistedState(getModelKey(workspaceId), baseModel);

        return setupSimpleChatStory({
          workspaceId,
          messages: [],
          providersConfig: {
            openai: { apiKeySet: true, isEnabled: true, couponCodeSet: false, isConfigured: true },
            anthropic: {
              apiKeySet: true,
              isEnabled: true,
              couponCodeSet: false,
              isConfigured: true,
            },
          },
        });
      }}
    />
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    const canvas = within(canvasElement);

    // Wait for chat input to mount
    await canvas.findAllByText(DEFAULT_AGENT_LABEL, {}, { timeout: 15000 });

    // Wait for model selector to be clickable (shows pretty name "GPT-4o")
    const modelSelector = await waitFor(() => {
      const el = canvas.getByText("GPT-4o");
      if (!el) throw new Error("Model selector not found");
      return el;
    });

    // Click to open the selector (enters editing mode, shows dropdown)
    await userEvent.click(modelSelector);

    // Wait for the dropdown to appear. The dropdown is rendered inline (not via Radix Portal),
    // so the search input is a reliable signal that it opened.
    await canvas.findByPlaceholderText(/Search \[provider:model-name\]/i);

    // Double RAF for visual stability after dropdown renders
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  },
  parameters: {
    docs: {
      description: {
        story:
          "Model selector dropdown open, showing gateway toggle and default star icons properly aligned without gaps.",
      },
    },
  },
};

/**
 * Editing message state - shows the edit cutoff barrier and amber-styled input.
 * Demonstrates the UI when a user clicks "Edit" on a previous message.
 */
export const EditingMessage: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        const workspaceId = "ws-editing";

        // Ensure a deterministic starting state (Chromatic/Storybook can preserve localStorage
        // across story runs in the same session).
        setWorkspaceInput(workspaceId, "");

        return setupSimpleChatStory({
          workspaceId,
          messages: [
            createUserMessage("msg-1", "Add authentication to the user API endpoint", {
              historySequence: 1,
              timestamp: STABLE_TIMESTAMP - 300000,
            }),
            createAssistantMessage(
              "msg-2",
              "I'll help you add authentication. Let me check the current implementation and add JWT validation.",
              {
                historySequence: 2,
                timestamp: STABLE_TIMESTAMP - 290000,
                toolCalls: [
                  createFileReadTool(
                    "call-1",
                    "src/api/users.ts",
                    "export function getUser(req, res) {\n  const user = db.users.find(req.params.id);\n  res.json(user);\n}"
                  ),
                ],
              }
            ),
            createUserMessage("msg-3", "Actually, can you use a different approach?", {
              historySequence: 3,
              timestamp: STABLE_TIMESTAMP - 280000,
            }),
            createAssistantMessage(
              "msg-4",
              "Of course! I can use a different authentication approach. What would you prefer?",
              {
                historySequence: 4,
                timestamp: STABLE_TIMESTAMP - 270000,
              }
            ),
          ],
        });
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    const storyRoot = document.getElementById("storybook-root") ?? canvasElement;
    const canvas = within(storyRoot);

    // Wait for user message actions to render (Edit buttons only appear on user messages)
    const editButtons = await canvas.findAllByLabelText("Edit", {}, { timeout: 10000 });
    if (editButtons.length === 0) throw new Error("No edit buttons found");

    // Click edit on the first user message
    await userEvent.click(editButtons[0]);

    // Wait for the editing state to be applied
    await waitFor(() => {
      const textarea = canvas.getByLabelText("Edit your last message");
      if (!textarea.className.includes("border-editing-mode")) {
        throw new Error("Textarea not in editing state");
      }
    });

    // Verify the edit cutoff barrier appears
    await canvas.findByText("Messages below will be removed when you submit");
  },
  parameters: {
    docs: {
      description: {
        story:
          "Shows the editing message state with the amber-styled input border and edit cutoff barrier indicating messages that will be removed.",
      },
    },
  },
};

/**
 * Diff padding colors - verifies that the top/bottom padding of diff blocks
 * matches the first/last line type (addition=green, deletion=red, context=default).
 *
 * This story shows three diffs:
 * 1. Diff starting with addition (green top padding)
 * 2. Diff ending with deletion (red bottom padding)
 * 3. Diff with context lines at both ends (default padding)
 */
export const DiffPaddingColors: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          workspaceId: "ws-diff-padding",
          messages: [
            createUserMessage("msg-1", "Show me different diff edge cases", {
              historySequence: 1,
              timestamp: STABLE_TIMESTAMP - 100000,
            }),
            createAssistantMessage(
              "msg-2",
              "Here are diffs with different first/last line types:",
              {
                historySequence: 2,
                timestamp: STABLE_TIMESTAMP - 90000,
                toolCalls: [
                  // Diff starting with addition - top padding should be green
                  createFileEditTool(
                    "call-1",
                    "src/addition-first.ts",
                    [
                      "--- src/addition-first.ts",
                      "+++ src/addition-first.ts",
                      "@@ -1,3 +1,5 @@",
                      "+import { newModule } from './new';",
                      "+import { anotherNew } from './another';",
                      " export function existing() {",
                      "   return 'unchanged';",
                      " }",
                    ].join("\n")
                  ),
                  // Diff ending with deletion - bottom padding should be red
                  createFileEditTool(
                    "call-2",
                    "src/deletion-last.ts",
                    [
                      "--- src/deletion-last.ts",
                      "+++ src/deletion-last.ts",
                      "@@ -1,6 +1,3 @@",
                      " export function keep() {",
                      "   return 'still here';",
                      " }",
                      "-export function remove() {",
                      "-  return 'goodbye';",
                      "-}",
                    ].join("\n")
                  ),
                  // Diff with context at both ends - default padding
                  createFileEditTool(
                    "call-3",
                    "src/context-both.ts",
                    [
                      "--- src/context-both.ts",
                      "+++ src/context-both.ts",
                      "@@ -1,4 +1,4 @@",
                      " function before() {",
                      "+  console.log('added');",
                      "-  console.log('removed');",
                      " }",
                    ].join("\n")
                  ),
                ],
              }
            ),
          ],
        })
      }
    />
  ),
  parameters: {
    docs: {
      description: {
        story:
          "Verifies diff container padding colors match first/last line types. " +
          "The first diff should have green top padding (starts with +), " +
          "the second should have red bottom padding (ends with -), " +
          "and the third should have default padding (context at both ends).",
      },
    },
  },
};

/**
 * Story to verify diff padding alignment with high line numbers.
 * The ch unit misalignment bug is more visible with 3-digit line numbers.
 * The colored padding strip should align perfectly with the gutter edge.
 */
export const DiffPaddingAlignment: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          workspaceId: "ws-diff-alignment",
          messages: [
            createUserMessage("msg-1", "Show me a diff with high line numbers", {
              historySequence: 1,
              timestamp: STABLE_TIMESTAMP - 100000,
            }),
            createAssistantMessage(
              "msg-2",
              "Here's a diff ending with deletions at high line numbers:",
              {
                historySequence: 2,
                timestamp: STABLE_TIMESTAMP - 90000,
                toolCalls: [
                  // Diff with 3-digit line numbers ending in deletions
                  // Replicates the alignment issue from code review diffs
                  createFileEditTool(
                    "call-1",
                    "src/ppo/train/config.rs",
                    [
                      "--- src/ppo/train/config.rs",
                      "+++ src/ppo/train/config.rs",
                      "@@ -374,7 +374,3 @@",
                      "             adj = LR_INCREASE_ADJ;",
                      "         }",
                      " ",
                      "-            // Slow down learning rate when we're too stale.",
                      "-            if last_metrics.stop_reason == metrics::StopReason::TooStale {",
                      "-                adj = LR_DECREASE_ADJ;",
                      "-            }",
                    ].join("\n")
                  ),
                ],
              }
            ),
          ],
        })
      }
    />
  ),
  parameters: {
    docs: {
      description: {
        story:
          "Verifies diff padding alignment with 3-digit line numbers. " +
          "The bottom red padding strip should align exactly with the gutter/content boundary. " +
          "Before the fix, the padding strip used ch units without font-monospace, " +
          "causing misalignment that scaled with line number width.",
      },
    },
  },
};

/**
 * Story to verify diff horizontal scrolling with long lines.
 * When code lines exceed container width, the diff should scroll horizontally
 * rather than overflow outside its container. The background colors for
 * additions/deletions should span the full scrollable width.
 */
export const DiffHorizontalScroll: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          workspaceId: "ws-diff-scroll",
          messages: [
            createUserMessage("msg-1", "Show me a diff with very long lines", {
              historySequence: 1,
              timestamp: STABLE_TIMESTAMP - 100000,
            }),
            createAssistantMessage(
              "msg-2",
              "Here's a diff with lines that require horizontal scrolling:",
              {
                historySequence: 2,
                timestamp: STABLE_TIMESTAMP - 90000,
                toolCalls: [
                  createFileEditTool(
                    "call-1",
                    "src/config/longLines.ts",
                    [
                      "--- src/config/longLines.ts",
                      "+++ src/config/longLines.ts",
                      "@@ -1,4 +1,4 @@",
                      " // Short context line",
                      "-export const VERY_LONG_CONFIG_OPTION_NAME_THAT_EXCEEDS_NORMAL_WIDTH = { description: 'This is an extremely long configuration value that should definitely cause horizontal scrolling in the diff viewer component', defaultValue: false };",
                      "+export const VERY_LONG_CONFIG_OPTION_NAME_THAT_EXCEEDS_NORMAL_WIDTH = { description: 'This is an extremely long configuration value that should definitely cause horizontal scrolling in the diff viewer component', defaultValue: true, enabled: true };",
                      " // Another short line",
                      " export const SHORT = 1;",
                    ].join("\n")
                  ),
                ],
              }
            ),
          ],
        })
      }
    />
  ),
  parameters: {
    docs: {
      description: {
        story:
          "Verifies diff container scrolls horizontally for long lines. " +
          "The diff should NOT overflow outside its container. " +
          "Background colors (red for deletions, green for additions) should " +
          "extend to the full scrollable width when scrolling right.",
      },
    },
  },
};

/**
 * Story showing the InitMessage component in success state.
 * Tests the workspace init hook display with completed status.
 */
export const InitHookSuccess: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          workspaceId: "ws-init-success",
          messages: [
            createUserMessage("msg-1", "Start working on the project", {
              historySequence: 1,
              timestamp: STABLE_TIMESTAMP - 100000,
            }),
          ],
          onChat: (_wsId, emit) => {
            // Emit init events to show completed init hook
            setTimeout(() => {
              emit({
                type: "init-start",
                hookPath: "/home/user/projects/my-app/.mux/init.sh",
                timestamp: STABLE_TIMESTAMP - 110000,
              } as WorkspaceChatMessage);
              emit({
                type: "init-output",
                line: "Installing dependencies...",
                timestamp: STABLE_TIMESTAMP - 109000,
              } as WorkspaceChatMessage);
              emit({
                type: "init-output",
                line: "Setting up environment variables...",
                timestamp: STABLE_TIMESTAMP - 108000,
              } as WorkspaceChatMessage);
              emit({
                type: "init-output",
                line: "Starting development server...",
                timestamp: STABLE_TIMESTAMP - 107000,
              } as WorkspaceChatMessage);
              emit({
                type: "init-end",
                exitCode: 0,
                timestamp: STABLE_TIMESTAMP - 106000,
              } as WorkspaceChatMessage);
            }, 100);
          },
        })
      }
    />
  ),
  parameters: {
    docs: {
      description: {
        story:
          "Shows the InitMessage component after a successful init hook execution. " +
          "The message displays with a green checkmark, hook path, and output lines.",
      },
    },
  },
};

/**
 * Story showing the InitMessage component in error state.
 * Tests the workspace init hook display with failed status.
 */
export const InitHookError: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          workspaceId: "ws-init-error",
          messages: [
            createUserMessage("msg-1", "Start working on the project", {
              historySequence: 1,
              timestamp: STABLE_TIMESTAMP - 100000,
            }),
          ],
          onChat: (_wsId, emit) => {
            // Emit init events to show failed init hook
            setTimeout(() => {
              emit({
                type: "init-start",
                hookPath: "/home/user/projects/my-app/.mux/init.sh",
                timestamp: STABLE_TIMESTAMP - 110000,
              } as WorkspaceChatMessage);
              emit({
                type: "init-output",
                line: "Installing dependencies...",
                timestamp: STABLE_TIMESTAMP - 109000,
              } as WorkspaceChatMessage);
              emit({
                type: "init-output",
                line: "Failed to install package 'missing-dep'",
                timestamp: STABLE_TIMESTAMP - 108000,
                isError: true,
              } as WorkspaceChatMessage);
              emit({
                type: "init-output",
                line: "npm ERR! code E404",
                timestamp: STABLE_TIMESTAMP - 107500,
                isError: true,
              } as WorkspaceChatMessage);
              emit({
                type: "init-end",
                exitCode: 1,
                timestamp: STABLE_TIMESTAMP - 107000,
              } as WorkspaceChatMessage);
            }, 100);
          },
        })
      }
    />
  ),
  parameters: {
    docs: {
      description: {
        story:
          "Shows the InitMessage component after a failed init hook execution. " +
          "The message displays with a red alert icon, error styling, and error output.",
      },
    },
  },
};

/**
 * Context meter with high usage and idle compaction enabled.
 * Shows the context usage indicator badge in the chat input area with the
 * hourglass badge indicating idle compaction is configured.
 */
export const ContextMeterWithIdleCompaction: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          workspaceId: "ws-context-meter",
          workspaceName: "feature/auth",
          projectName: "my-app",
          idleCompactionHours: 4,
          messages: [
            createUserMessage("msg-1", "Help me refactor the authentication module", {
              historySequence: 1,
              timestamp: STABLE_TIMESTAMP - 300000,
            }),
            createAssistantMessage(
              "msg-2",
              "I'll help you refactor the authentication module. Let me first review the current implementation.",
              {
                historySequence: 2,
                timestamp: STABLE_TIMESTAMP - 290000,
                // High context usage to show the meter prominently (65% of 200k = 130k tokens)
                contextUsage: { inputTokens: 130000, outputTokens: 2000 },
                toolCalls: [
                  createFileReadTool(
                    "call-1",
                    "src/auth/index.ts",
                    'export { login, logout, verifyToken } from "./handlers";'
                  ),
                ],
              }
            ),
          ],
        })
      }
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // Wait for the context meter to appear (it shows token usage)
    await waitFor(() => {
      // Look for the context meter button which shows token counts
      canvas.getByRole("button", { name: /context/i });
    });
  },
  parameters: {
    docs: {
      description: {
        story:
          "Shows the Context Meter with high usage (~65%) and idle compaction enabled (4h). " +
          "The meter displays an hourglass badge indicating idle compaction is configured.",
      },
    },
  },
};

/**
 * Context meter hover summary tooltip.
 *
 * Captures the non-interactive one-line tooltip shown on hover so the quick
 * compaction stats remain visible even after controls moved to click-to-open.
 */
export const ContextMeterHoverSummaryTooltip: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          workspaceId: "ws-context-meter-hover",
          workspaceName: "feature/context-meter-hover",
          projectName: "my-app",
          idleCompactionHours: 4,
          messages: [
            createUserMessage("msg-1", "Can you keep an eye on context usage?", {
              historySequence: 1,
              timestamp: STABLE_TIMESTAMP - 240000,
            }),
            createAssistantMessage(
              "msg-2",
              "Sure — I’ll keep compaction settings tuned as usage grows.",
              {
                historySequence: 2,
                timestamp: STABLE_TIMESTAMP - 230000,
                contextUsage: { inputTokens: 128000, outputTokens: 2500 },
              }
            ),
          ],
        })
      }
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    const contextButton = await waitFor(
      () => canvas.getByRole("button", { name: /context usage/i }),
      { interval: 50, timeout: 10000 }
    );

    await userEvent.hover(contextButton);

    await waitFor(
      () => {
        const tooltip = document.querySelector('[role="tooltip"]');
        if (!(tooltip instanceof HTMLElement)) {
          throw new Error("Compaction hover summary tooltip not visible");
        }

        const text = tooltip.textContent ?? "";
        if (!text.includes("Context ")) {
          throw new Error("Expected context usage summary in tooltip");
        }
        if (!text.includes("Auto ")) {
          throw new Error("Expected auto-compaction summary in tooltip");
        }
        if (!text.includes("Idle 4h")) {
          throw new Error("Expected idle compaction summary in tooltip");
        }
      },
      { interval: 50, timeout: 5000 }
    );
  },
  parameters: {
    docs: {
      description: {
        story:
          "Captures the context usage hover summary tooltip with one-line stats for context, auto-compaction threshold, and idle timer.",
      },
    },
  },
};

/**
 * Story showing a propose_plan tool call with Plan UI.
 * Tests the plan card rendering with icon action buttons at the bottom.
 */
export const ProposePlan: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          workspaceId: "ws-plan",
          messages: [
            createUserMessage("msg-1", "Help me refactor the authentication module", {
              historySequence: 1,
              timestamp: STABLE_TIMESTAMP - 300000,
            }),
            createAssistantMessage(
              "msg-2",
              "I'll create a plan for refactoring the authentication module.",
              {
                historySequence: 2,
                timestamp: STABLE_TIMESTAMP - 290000,
                toolCalls: [
                  createProposePlanTool(
                    "call-plan-1",
                    `# Authentication Module Refactor

## Overview

Refactor the authentication system to improve security and maintainability.

## Tasks

1. **Extract JWT utilities** - Move token generation and validation to dedicated module
2. **Add refresh token support** - Implement secure refresh token rotation
3. **Improve password hashing** - Upgrade to Argon2id with proper salt rounds
4. **Add rate limiting** - Implement per-IP and per-user rate limits
5. **Session management** - Add Redis-backed session store

## Implementation Order

\`\`\`mermaid
graph TD
    A[Extract JWT utils] --> B[Add refresh tokens]
    B --> C[Improve hashing]
    C --> D[Add rate limiting]
    D --> E[Session management]
\`\`\`

## Success Criteria

- All existing tests pass
- New tests for refresh token flow
- Security audit passes
- Performance benchmarks maintained`
                  ),
                ],
              }
            ),
          ],
        })
      }
    />
  ),
  parameters: {
    docs: {
      description: {
        story:
          "Shows the ProposePlanToolCall component with a completed plan. " +
          "The plan card displays with the title in the header and icon action buttons " +
          "(Copy, Start Here, Show Text) at the bottom, matching the AssistantMessage aesthetic.",
      },
    },
  },
};

/**
 * Captures the handoff pause after a plan is presented and before the executor stream starts.
 *
 * This reproduces the visual state where the sidebar shows "Deciding execution strategy…"
 * while the proposed plan remains visible in the conversation.
 */
export const ProposePlanAutoRoutingDecisionGap: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          workspaceId: "ws-plan-auto-routing-gap",
          workspaceName: "feature/plan-auto-routing",
          messages: [
            createUserMessage(
              "msg-1",
              "Plan and implement a safe migration rollout for auth tokens.",
              {
                historySequence: 1,
                timestamp: STABLE_TIMESTAMP - 240000,
              }
            ),
            createAssistantMessage("msg-2", "Here is the implementation plan.", {
              historySequence: 2,
              timestamp: STABLE_TIMESTAMP - 230000,
              toolCalls: [
                createProposePlanTool(
                  "call-plan-1",
                  `# Auth Token Migration Rollout

## Goals

- Migrate token validation to the new signing service.
- Maintain compatibility during rollout.
- Keep rollback simple and low risk.

## Steps

1. Add dual-read token validation behind a feature flag.
2. Ship telemetry for token verification outcomes.
3. Enable new validator for 10% of traffic.
4. Ramp to 100% after stability checks.
5. Remove legacy validator once metrics stay healthy.

## Rollback

- Disable the rollout flag to return to legacy validation immediately.
- Keep telemetry running to confirm recovery.`
                ),
              ],
            }),
            createAssistantMessage("msg-3", "Selecting the right executor for this plan.", {
              historySequence: 3,
              timestamp: STABLE_TIMESTAMP - 220000,
              toolCalls: [
                createStatusTool(
                  "call-status-1",
                  PLAN_AUTO_ROUTING_STATUS_EMOJI,
                  PLAN_AUTO_ROUTING_STATUS_MESSAGE
                ),
              ],
            }),
          ],
        })
      }
    />
  ),
  parameters: {
    docs: {
      description: {
        story:
          "Chromatic regression story for the plan auto-routing gap: after `propose_plan` succeeds, " +
          "the sidebar stays in a working state with a 'Deciding execution strategy…' status before executor kickoff.",
      },
    },
  },
};

/**
 * Mobile viewport version of ProposePlan.
 *
 * Verifies that on narrow screens the primary plan actions (Implement / Start Orchestrator)
 * render as shortcut icons in the left action row (instead of right-aligned buttons).
 */
export const ProposePlanMobile: AppStory = {
  ...ProposePlan,
  parameters: {
    ...ProposePlan.parameters,
    viewport: { defaultViewport: "mobile1" },
    docs: {
      description: {
        story:
          "Renders ProposePlan at an iPhone-sized viewport to verify that Implement / Start Orchestrator " +
          "appear as shortcut icons in the left action row (preventing right-side overflow on small screens).",
      },
    },
  },
};

/**
 * Story showing a propose_plan with a code block containing long horizontal content.
 * Tests that code blocks wrap correctly instead of overflowing the container.
 */
export const ProposePlanWithLongCodeBlock: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          workspaceId: "ws-plan-overflow",
          messages: [
            createUserMessage("msg-1", "The CI is failing with this error, can you help?", {
              historySequence: 1,
              timestamp: STABLE_TIMESTAMP,
            }),
            createAssistantMessage("msg-2", "I see the issue. Here's my plan to fix it:", {
              historySequence: 2,
              timestamp: STABLE_TIMESTAMP,
              toolCalls: [
                createProposePlanTool(
                  "call-plan-1",
                  `# Fix CI Pipeline Failure

## Problem

The deployment step is failing due to a configuration mismatch:

\`\`\`json
{"error":"ConfigurationError","message":"Environment variable AWS_REGION is required but not set","stack":"at validateConfig (deploy.js:42)","context":{"requiredVars":["AWS_REGION","AWS_ACCESS_KEY_ID","AWS_SECRET_ACCESS_KEY"],"missingVars":["AWS_REGION"]}}
\`\`\`

## Solution

1. Add the missing \`AWS_REGION\` environment variable to the CI configuration
2. Update the deployment script to provide better error messages
3. Add a pre-flight check to catch missing variables earlier`
                ),
              ],
            }),
          ],
        })
      }
    />
  ),
  parameters: {
    docs: {
      description: {
        story:
          "Tests that code blocks within plans wrap correctly instead of overflowing. " +
          "The long JSON error line should wrap within the plan card.",
      },
    },
  },
};

/**
 * Story showing a todo_write tool call with very long todo items.
 * Regression test for todo rows overflowing their container in the chat window.
 */
export const TodoWriteWithLongTodos: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          workspaceId: "ws-todo-overflow",
          messages: [
            createUserMessage("msg-1", "Can you track tasks in a todo list?", {
              historySequence: 1,
              timestamp: STABLE_TIMESTAMP - 100000,
            }),
            createAssistantMessage("msg-2", "Sure — here are the tasks:", {
              historySequence: 2,
              timestamp: STABLE_TIMESTAMP - 90000,
              toolCalls: [
                createGenericTool(
                  "call-todo-1",
                  "todo_write",
                  {
                    todos: [
                      {
                        content:
                          "Create British-themed layout (HTML) matching reference: left nav, hero section, decorative flourishes, and a deliberately overlong description to force truncation in narrow layouts",
                        status: "pending",
                      },
                      {
                        content:
                          "Implement grotesque Great Britain pride styling (Union Jack, red/white/blue palette, overly ornate typography) with enough detail to overflow a single line",
                        status: "in_progress",
                      },
                      {
                        content:
                          "Add small JS for interactions (active nav, mobile drawer, hover effects, focus states, keyboard shortcuts, and more) — again intentionally verbose",
                        status: "pending",
                      },
                      {
                        content:
                          "Run a local server and verify layout + responsiveness across breakpoints; include a comically long note about testing on multiple devices and ensuring no horizontal overflow",
                        status: "pending",
                      },
                    ],
                  },
                  { success: true, count: 4 }
                ),
              ],
            }),
          ],
        })
      }
    />
  ),
  play: async ({ canvasElement }) => {
    const storyRoot = document.getElementById("storybook-root") ?? canvasElement;
    await waitForChatMessagesLoaded(storyRoot);

    const messageWindow = storyRoot.querySelector('[data-testid="message-window"]');
    if (!(messageWindow instanceof HTMLElement)) {
      throw new Error("Message window not found");
    }

    // Expand the tool call (TodoToolCall is collapsed by default).
    const canvas = within(messageWindow);

    if (!canvas.queryByText(/Create British-themed layout \(HTML\)/)) {
      // Wait for the tool header expand icon to appear.
      await waitFor(
        () => {
          canvas.getAllByText("▶");
        },
        { timeout: 8000 }
      );

      await userEvent.click(canvas.getAllByText("▶")[0]);
    }

    // Verify that todo content rows are using truncation.
    await waitFor(() => {
      const firstTodo = canvas.getByText(/Create British-themed layout \(HTML\)/);
      if (!firstTodo.classList.contains("truncate")) {
        throw new Error("Expected todo row to have Tailwind 'truncate' class");
      }
    });

    // Verify chat pane doesn't gain horizontal overflow.
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    if (messageWindow.scrollWidth > messageWindow.clientWidth) {
      throw new Error("Message window has horizontal overflow");
    }
  },
  parameters: {
    docs: {
      description: {
        story:
          "Regression test for long todo text overflowing its container. " +
          "Todo rows should truncate with ellipsis and the message window should not horizontally scroll.",
      },
    },
  },
};

// Message content used in SigningBadgePassphraseWarning story
const SIGNING_WARNING_MESSAGE_CONTENT = "Hello! How can I help you today?";
/**
 * Story showing the signing badge in warning state when key requires passphrase.
 * The signing badge displays yellow when a compatible key exists but is passphrase-protected.
 */
export const SigningBadgePassphraseWarning: AppStory = {
  // Use loaders to pre-warm hash cache before component mounts (fixes race condition)
  loaders: [
    async () => {
      // Warm the hash cache to ensure consistent hashing
      await warmHashCache(SIGNING_WARNING_MESSAGE_CONTENT);
      // Now set share data with the warmed hash
      setShareData(SIGNING_WARNING_MESSAGE_CONTENT, {
        url: "https://mux.md/story-test#fake-key",
        id: "story-share-id",
        mutateKey: "story-mutate-key",
        expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000, // 7 days
        signed: false,
      });
      return {};
    },
  ],
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          workspaceId: "ws-signing-warning",
          messages: [
            createUserMessage("msg-1", "Hello", {
              historySequence: 1,
              timestamp: STABLE_TIMESTAMP - 300000,
            }),
            createAssistantMessage("msg-2", SIGNING_WARNING_MESSAGE_CONTENT, {
              historySequence: 2,
              timestamp: STABLE_TIMESTAMP - 290000,
            }),
          ],
          signingCapabilities: {
            publicKey: null,
            githubUser: null,
            error: {
              message:
                "Signing key requires a passphrase. Create an unencrypted key at ~/.mux/message_signing_key or use ssh-add.",
              hasEncryptedKey: true,
            },
          },
        })
      }
    />
  ),
  play: async ({ canvasElement }) => {
    const storyRoot = document.getElementById("storybook-root") ?? canvasElement;
    const canvas = within(storyRoot);

    // Wait for the assistant message to appear
    await canvas.findByText(SIGNING_WARNING_MESSAGE_CONTENT);

    // Wait for React to finish any pending updates after rendering
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

    // Find and click the Share button (should show "Already shared" due to loader)
    const shareButton = await canvas.findByLabelText("Already shared");

    // Wait a bit for button to be fully interactive
    await new Promise((r) => setTimeout(r, 100));
    await userEvent.click(shareButton);

    // Wait for the popover to open (renders in a portal, so search document)
    await waitFor(() => {
      const popover = document.querySelector('[role="dialog"]');
      if (!popover) throw new Error("Share popover not found");
    });

    // Allow the signing badge to render with its warning state
    await new Promise((r) => setTimeout(r, 200));
  },
  parameters: {
    docs: {
      description: {
        story:
          "Shows the signing badge in warning state (yellow) when a signing key exists but is passphrase-protected.",
      },
    },
  },
};

/** Tool hooks output - shows subtle expandable hook output on tool results */
export const ToolHooksOutput: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          workspaceId: "ws-tool-hooks",
          messages: [
            createUserMessage("msg-1", "Can you fix the lint errors in app.ts?", {
              historySequence: 1,
              timestamp: STABLE_TIMESTAMP - 100000,
            }),
            createAssistantMessage("msg-2", "I'll fix the lint errors.", {
              historySequence: 2,
              timestamp: STABLE_TIMESTAMP - 90000,
              toolCalls: [
                // File edit with lint hook output (formatter ran)
                withHookOutput(
                  createFileEditTool(
                    "call-1",
                    "src/app.ts",
                    [
                      "--- src/app.ts",
                      "+++ src/app.ts",
                      "@@ -1,3 +1,3 @@",
                      "-const x=1",
                      "+const x = 1;",
                      " ",
                      " export default x;",
                    ].join("\n")
                  ),
                  "prettier: reformatted src/app.ts\neslint: auto-fixed 2 issues",
                  145
                ),
                // Bash with failing hook (lint check failed)
                withHookOutput(
                  createBashTool(
                    "call-2",
                    "npm run build",
                    "Build complete.",
                    0,
                    30,
                    1500,
                    "Build"
                  ),
                  "post-build hook: running type check...\n✗ Found 1 type error:\n  src/utils.ts:42 - Type 'string' is not assignable to type 'number'",
                  2340
                ),
              ],
            }),
            createAssistantMessage("msg-3", "Let me also read the config file.", {
              historySequence: 3,
              timestamp: STABLE_TIMESTAMP - 80000,
              toolCalls: [
                // File read with no hook output (normal - hook did nothing)
                createFileReadTool(
                  "call-3",
                  "tsconfig.json",
                  '{\n  "compilerOptions": {\n    "strict": true\n  }\n}'
                ),
              ],
            }),
          ],
        })
      }
    />
  ),
  parameters: {
    docs: {
      description: {
        story:
          "Shows tool hook output as a subtle expandable section below tool results. " +
          "Hook output only appears when a hook produced output (non-empty). " +
          "The first two tools have hook output, the third does not.",
      },
    },
  },
};

/** Tool hooks output expanded - shows hook output in expanded state */
export const ToolHooksOutputExpanded: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          workspaceId: "ws-tool-hooks-expanded",
          messages: [
            createUserMessage("msg-1", "Run the formatter", {
              historySequence: 1,
              timestamp: STABLE_TIMESTAMP - 100000,
            }),
            createAssistantMessage("msg-2", "Running the formatter.", {
              historySequence: 2,
              timestamp: STABLE_TIMESTAMP - 90000,
              toolCalls: [
                withHookOutput(
                  createBashTool(
                    "call-1",
                    "npx prettier --write .",
                    "Formatted 15 files.",
                    0,
                    10,
                    800,
                    "Prettier"
                  ),
                  "post-hook: git status check\nM  src/app.ts\nM  src/utils.ts\nM  src/config.ts\n\n3 files modified by formatter",
                  85
                ),
              ],
            }),
          ],
        })
      }
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // Wait for the tool to render
    await canvas.findByText("npx prettier --write .");

    // Wait for rendering to complete
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

    // Find and click the hook output button to expand it
    const hookButton = await canvas.findByText("hook output");
    await userEvent.click(hookButton);

    // Wait for the expanded content to be visible
    await canvas.findByText(/post-hook: git status check/);
  },
  parameters: {
    docs: {
      description: {
        story:
          "Shows the hook output display in its expanded state, revealing the full hook output.",
      },
    },
  },
};

/**
 * Context switch warning banner - shows when switching to a model that can't fit current context.
 *
 * Scenario: Workspace has ~150K tokens of context. The user switches from Sonnet (200K+ limit)
 * to GPT-4o (128K limit). Since 150K > 90% of 128K, the warning banner appears.
 */
const contextSwitchWorkspaceId = "ws-context-switch";

export const ContextSwitchWarning: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        // Start on Sonnet so the explicit switch to GPT-4o triggers the warning.
        updatePersistedState(getModelKey(contextSwitchWorkspaceId), "anthropic:claude-sonnet-4-5");

        return setupSimpleChatStory({
          workspaceId: contextSwitchWorkspaceId,
          messages: [
            createUserMessage("msg-1", "Help me refactor this large codebase", {
              historySequence: 1,
              timestamp: STABLE_TIMESTAMP - 300000,
            }),
            // Large context usage - 150K tokens from Sonnet (which handles 200K+)
            // Now switching to GPT-4o (128K limit): 150K > 90% of 128K triggers warning
            createAssistantMessage(
              "msg-2",
              "I've analyzed the codebase. Here's my refactoring plan...",
              {
                historySequence: 2,
                timestamp: STABLE_TIMESTAMP - 290000,
                model: "anthropic:claude-sonnet-4-5",
                contextUsage: {
                  inputTokens: 150000,
                  outputTokens: 2000,
                },
              }
            ),
          ],
        });
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    const storyRoot = document.getElementById("storybook-root") ?? canvasElement;
    await waitForChatMessagesLoaded(storyRoot);
    setWorkspaceModelWithOrigin(contextSwitchWorkspaceId, "openai:gpt-4o", "user");
  },
  parameters: {
    docs: {
      description: {
        story:
          "Shows the context switch warning banner. Previous message used Sonnet (150K tokens), " +
          "but workspace is now set to GPT-4o (128K limit). Since 150K exceeds 90% of 128K, " +
          "the warning banner appears offering a one-click compact action.",
      },
    },
  },
};
