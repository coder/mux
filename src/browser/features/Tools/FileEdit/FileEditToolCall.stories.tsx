import type { AppStory } from "@/browser/stories/meta.js";
import { appMeta, AppWithMocks } from "@/browser/stories/meta.js";
import { setupSimpleChatStory } from "@/browser/stories/storyHelpers.js";
import {
  STABLE_TIMESTAMP,
  createUserMessage,
  createAssistantMessage,
  createFileEditTool,
} from "@/browser/stories/mockFactory";

const meta = { ...appMeta, title: "App/Chat/Tools/FileEdit" };
export default meta;

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
