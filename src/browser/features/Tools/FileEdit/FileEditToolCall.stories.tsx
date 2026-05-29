import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ReactNode } from "react";
import { FileEditToolCall } from "@/browser/features/Tools/FileEditToolCall";
import { lightweightMeta } from "@/browser/stories/meta.js";

const meta = {
  ...lightweightMeta,
  title: "App/Chat/Tools/FileEdit",
  component: FileEditToolCall,
} satisfies Meta<typeof FileEditToolCall>;

export default meta;

type Story = StoryObj<typeof meta>;

const ADDITION_FIRST_DIFF = [
  "--- src/addition-first.ts",
  "+++ src/addition-first.ts",
  "@@ -1,3 +1,5 @@",
  "+import { newModule } from './new';",
  "+import { anotherNew } from './another';",
  " export function existing() {",
  "   return 'unchanged';",
  " }",
].join("\n");

const DELETION_LAST_DIFF = [
  "--- src/deletion-last.ts",
  "+++ src/deletion-last.ts",
  "@@ -1,6 +1,3 @@",
  " export function keep() {",
  "   return 'still here';",
  " }",
  "-export function remove() {",
  "-  return 'goodbye';",
  "-}",
].join("\n");

const CONTEXT_BOTH_DIFF = [
  "--- src/context-both.ts",
  "+++ src/context-both.ts",
  "@@ -1,4 +1,4 @@",
  " function before() {",
  "+  console.log('added');",
  "-  console.log('removed');",
  " }",
].join("\n");

const ALIGNMENT_DIFF = [
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
].join("\n");

const LONG_LINE_DIFF = [
  "--- src/config/longLines.ts",
  "+++ src/config/longLines.ts",
  "@@ -1,4 +1,4 @@",
  " // Short context line",
  "-export const VERY_LONG_CONFIG_OPTION_NAME_THAT_EXCEEDS_NORMAL_WIDTH = { description: 'This is an extremely long configuration value that should definitely cause horizontal scrolling in the diff viewer component', defaultValue: false };",
  "+export const VERY_LONG_CONFIG_OPTION_NAME_THAT_EXCEEDS_NORMAL_WIDTH = { description: 'This is an extremely long configuration value that should definitely cause horizontal scrolling in the diff viewer component', defaultValue: true, enabled: true };",
  " // Another short line",
  " export const SHORT = 1;",
].join("\n");

function FileEditStoryShell(props: { children: ReactNode }) {
  return (
    <div className="bg-background flex min-h-screen items-start p-6">
      <div className="w-full max-w-4xl space-y-4">{props.children}</div>
    </div>
  );
}

function FileEditCard(props: { path: string; diff: string }) {
  return (
    <FileEditToolCall
      toolName="file_edit_replace_string"
      args={{ path: props.path, old_string: "...", new_string: "..." }}
      result={{ success: true, diff: props.diff, edits_applied: 1 }}
      status="completed"
    />
  );
}

/**
 * Diff padding colors - verifies that the top/bottom padding of diff blocks
 * matches the first/last line type (addition=green, deletion=red, context=default).
 *
 * This story shows three diffs:
 * 1. Diff starting with addition (green top padding)
 * 2. Diff ending with deletion (red bottom padding)
 * 3. Diff with context lines at both ends (default padding)
 */
export const DiffPaddingColors: Story = {
  render: () => (
    <FileEditStoryShell>
      <FileEditCard path="src/addition-first.ts" diff={ADDITION_FIRST_DIFF} />
      <FileEditCard path="src/deletion-last.ts" diff={DELETION_LAST_DIFF} />
      <FileEditCard path="src/context-both.ts" diff={CONTEXT_BOTH_DIFF} />
    </FileEditStoryShell>
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
export const DiffPaddingAlignment: Story = {
  render: () => (
    <FileEditStoryShell>
      <FileEditCard path="src/ppo/train/config.rs" diff={ALIGNMENT_DIFF} />
    </FileEditStoryShell>
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
export const DiffHorizontalScroll: Story = {
  render: () => (
    <FileEditStoryShell>
      <FileEditCard path="src/config/longLines.ts" diff={LONG_LINE_DIFF} />
    </FileEditStoryShell>
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
