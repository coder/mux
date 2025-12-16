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
} from "./mockFactory";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import { getModelKey } from "@/common/constants/storage";
import { setupSimpleChatStory, setupStreamingChatStory, setWorkspaceInput } from "./storyHelpers";
import { within, userEvent, waitFor } from "@storybook/test";

export default {
  ...appMeta,
  title: "App/Chat",
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
              "I'll help you add authentication. Let me check the current implementation.",
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
            createUserMessage("msg-3", "Yes, add JWT token validation", {
              historySequence: 3,
              timestamp: STABLE_TIMESTAMP - 280000,
            }),
            createAssistantMessage("msg-4", "I'll add JWT validation. Here's the update:", {
              historySequence: 4,
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

/** Voice input button shows user education when OpenAI API key is not set */
export const VoiceInputNoApiKey: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          messages: [],
          // No OpenAI key configured - voice button should be disabled with tooltip
          providersConfig: {
            anthropic: { apiKeySet: true },
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
            toolName: "read_file",
            args: { target_file: "src/db/connection.ts" },
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

    const getSectionButton = (prefix: string): HTMLElement => {
      const buttons = canvas.getAllByRole("button");
      const btn = buttons.find(
        (el) => el.tagName === "BUTTON" && (el.textContent ?? "").startsWith(prefix)
      );
      if (!btn) throw new Error(`${prefix} section button not found`);
      return btn;
    };

    // Ensure we're on the first question.
    await userEvent.click(getSectionButton("Approach"));

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
    await userEvent.click(canvas.getByText("Approach A"));
    await canvas.findByText("Which platforms do we need to support?", {}, { timeout: 2000 });

    // Regression: you must be able to jump back to a previous section after answering it.
    await userEvent.click(getSectionButton("Approach"));

    await canvas.findByText("Which approach should we take?", {}, { timeout: 2000 });

    // Give React a tick to run any pending effects; we should still be on question 1.
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (canvas.queryByText("Which platforms do we need to support?")) {
      throw new Error("Unexpected auto-advance when navigating back to a previous question");
    }

    // Changing the answer should still auto-advance.
    await userEvent.click(canvas.getByText("Approach B"));
    await canvas.findByText("Which platforms do we need to support?", {}, { timeout: 2000 });
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
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          messages: [],
        })
      }
    />
  ),
  play: async ({ canvasElement }) => {
    const storyRoot = document.getElementById("storybook-root") ?? canvasElement;
    const canvas = within(storyRoot);

    // Wait for app to fully load - the chat input with mode selector should be present
    await canvas.findAllByText("Exec", {}, { timeout: 10000 });

    // Find the help indicator "?" - should be a span with cursor-help styling
    const helpIndicators = canvas.getAllByText("?");
    const helpIndicator = helpIndicators.find(
      (el) => el.tagName === "SPAN" && el.className.includes("cursor-help")
    );
    if (!helpIndicator) throw new Error("HelpIndicator not found");

    // Hover to open the tooltip and leave it visible for the visual snapshot
    await userEvent.hover(helpIndicator);

    // Wait for tooltip to fully appear (Radix has 200ms delay)
    await waitFor(
      () => {
        const tooltip = document.querySelector('[role="tooltip"]');
        if (!tooltip) throw new Error("Tooltip not visible");
      },
      { timeout: 2000, interval: 50 }
    );
  },
  parameters: {
    docs: {
      description: {
        story:
          "Verifies the HelpIndicator tooltip works by focusing the ? icon. The tooltip should appear with Exec/Plan mode explanations.",
      },
    },
  },
};

/**
 * Model selector pretty display with mux-gateway enabled.
 *
 * Regression test: when gateway is enabled, `useSendMessageOptions().model` becomes
 * `mux-gateway:provider/model`, but the UI should still display the canonical
 * provider:model form (e.g. GPT-4o, not \"Openai/gpt 4o\").
 */
export const ModelSelectorPrettyWithGateway: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        const workspaceId = "ws-gateway-model";
        const baseModel = "openai:gpt-4o";

        // Ensure the gateway transform actually kicks in (so the regression would reproduce).
        updatePersistedState(getModelKey(workspaceId), baseModel);
        updatePersistedState("gateway-enabled", true);
        updatePersistedState("gateway-available", true);
        updatePersistedState("gateway-models", [baseModel]);

        return setupSimpleChatStory({
          workspaceId,
          messages: [],
          providersConfig: {
            "mux-gateway": { apiKeySet: false, couponCodeSet: true },
          },
        });
      }}
    />
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    const canvas = within(canvasElement);

    // Wait for chat input to mount.
    await canvas.findAllByText("Exec", {}, { timeout: 10000 });

    // With gateway enabled, we should still display the *pretty* model name.
    await waitFor(() => {
      canvas.getByText("GPT-4o");
    });

    // The buggy rendering (mux-gateway:openai/gpt-4o) shows up as "Openai/gpt 4o".
    const ugly = canvas.queryByText("Openai/gpt 4o");
    if (ugly) {
      throw new Error(`Unexpected gateway-formatted model label: ${ugly.textContent ?? "(empty)"}`);
    }

    // Sanity check that the gateway indicator exists.
    const gatewayIndicator = canvasElement.querySelector('[aria-label="Using Mux Gateway"]');
    if (!gatewayIndicator) throw new Error("Gateway indicator not found");

    // Hover to prove the gateway tooltip is wired up (and keep it visible for snapshot).
    await userEvent.hover(gatewayIndicator);
    await waitFor(
      () => {
        const tooltip = document.querySelector('[role="tooltip"]');
        if (!tooltip) throw new Error("Tooltip not visible");
      },
      { timeout: 2000, interval: 50 }
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
    await waitFor(
      () => {
        const textarea = canvas.getByLabelText("Edit your last message");
        if (!textarea.className.includes("border-editing-mode")) {
          throw new Error("Textarea not in editing state");
        }
      },
      { timeout: 2000 }
    );

    // Verify the edit cutoff barrier appears
    await canvas.findByText(
      "Messages below will be removed when you submit",
      {},
      { timeout: 2000 }
    );
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
