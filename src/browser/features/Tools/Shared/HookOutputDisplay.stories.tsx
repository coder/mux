import type { AppStory } from "@/browser/stories/meta.js";
import { appMeta, AppWithMocks } from "@/browser/stories/meta.js";
import {
  STABLE_TIMESTAMP,
  createAssistantMessage,
  createBashTool,
  createFileEditTool,
  createFileReadTool,
  createUserMessage,
  withHookOutput,
} from "@/browser/stories/mockFactory";
import { setupSimpleChatStory } from "@/browser/stories/storyHelpers.js";
import { userEvent, within } from "@storybook/test";

const meta = { ...appMeta, title: "App/Chat/Tools/HookOutput" };
export default meta;

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
