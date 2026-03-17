import { within, waitFor } from "@storybook/test";
import type { ComponentType } from "react";

import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import {
  RIGHT_SIDEBAR_TAB_KEY,
  RIGHT_SIDEBAR_WIDTH_KEY,
  getReviewImmersiveKey,
  getRightSidebarLayoutKey,
} from "@/common/constants/storage";
import { extractAllHunks, parseDiff } from "@/common/utils/git/diffParser";

import { appMeta, AppWithMocks, type AppStory } from "./meta.js";
import { createAssistantMessage, createUserMessage } from "./mockFactory";
import {
  createReview,
  expandRightSidebar,
  setReadHunks,
  setReviews,
  setupSimpleChatStory,
} from "./storyHelpers";

const LINE_HEIGHT_DEBUG_WORKSPACE_ID = "ws-review-immersive-line-height";

// Includes highlighted TypeScript lines and neutral/context lines so row-height
// differences are easy to compare while debugging immersive review rendering.
const IMMERSIVE_LINE_HEIGHT_DIFF = `diff --git a/src/utils/formatPrice.ts b/src/utils/formatPrice.ts
index 1111111..2222222 100644
--- a/src/utils/formatPrice.ts
+++ b/src/utils/formatPrice.ts
@@ -1,10 +1,15 @@
 export function formatPrice(amount: number, currency = "USD"): string {
+  const formatter = new Intl.NumberFormat("en-US", {
+    style: "currency",
+    currency,
+  });
+
   if (!Number.isFinite(amount)) {
-    return "$0.00";
+    return formatter.format(0);
   }
 
-  return amount.toFixed(2);
+  return formatter.format(amount);
 }
 
 // Keep this context line unchanged for neutral-row comparison.
 export const DEFAULT_LOCALE = "en-US";
`;

const IMMERSIVE_LINE_HEIGHT_NUMSTAT = "7\t2\tsrc/utils/formatPrice.ts";

const IMMERSIVE_REVIEW_COMPLETE_WORKSPACE_ID = "ws-review-immersive-complete";

function getDiffHunkIds(diffOutput: string): string[] {
  return extractAllHunks(parseDiff(diffOutput)).map((hunk) => hunk.id);
}

const IMMERSIVE_NOTES_PREVIEW_WORKSPACE_ID = "ws-review-immersive-notes-preview";
const IMMERSIVE_NOTES_PREVIEW_BASE_TIME = 1700000000000;

const HIGHLIGHT_VS_PLAIN_WORKSPACE_ID = "ws-review-immersive-highlight-vs-plain";
const HIGHLIGHT_FALLBACK_THRESHOLD_BYTES = 32 * 1024;
const HIGHLIGHT_FALLBACK_BUFFER_BYTES = 1024;
const HIGHLIGHT_VS_PLAIN_NUMSTAT = "3\t2\tsrc/review/lineHeightProbe.ts";

const IMMERSIVE_MINIMAP_WORKSPACE_ID = "ws-review-immersive-minimap";
const IMMERSIVE_MINIMAP_NUMSTAT = "5\t5\tsrc/review/minimapProbe.ts";

function buildMinimapDiffOutput(): string {
  const hunkLines: string[] = [];

  for (let lineNumber = 1; lineNumber <= 55; lineNumber += 1) {
    if (lineNumber % 11 === 0) {
      hunkLines.push(`-const previousLine${lineNumber} = createProbe(${lineNumber}, "old");`);
      hunkLines.push(`+const nextLine${lineNumber} = createProbe(${lineNumber}, "new");`);
      continue;
    }

    hunkLines.push(` const sharedLine${lineNumber} = createProbe(${lineNumber}, "context");`);
  }

  return [
    "diff --git a/src/review/minimapProbe.ts b/src/review/minimapProbe.ts",
    "index 9999999..aaaaaaa 100644",
    "--- a/src/review/minimapProbe.ts",
    "+++ b/src/review/minimapProbe.ts",
    "@@ -1,55 +1,55 @@",
    ...hunkLines,
    "",
  ].join("\n");
}

function buildHighlightVsPlainDiffOutput(): string {
  const oversizedContextLines: string[] = [];
  let contextBytes = 0;
  let lineIndex = 0;

  // Keep adding context lines until this single context chunk exceeds the
  // 32kb highlight limit, forcing plain/fallback rendering for those rows.
  while (contextBytes <= HIGHLIGHT_FALLBACK_THRESHOLD_BYTES + HIGHLIGHT_FALLBACK_BUFFER_BYTES) {
    const contextLine =
      `const fallbackProbe${lineIndex.toString().padStart(4, "0")} = createProbeEntry(` +
      `"fallback-${lineIndex}", { index: ${lineIndex}, mode: "plain-context-chunk" });`;
    oversizedContextLines.push(` ${contextLine}`);
    contextBytes += contextLine.length + 1;
    lineIndex += 1;
  }

  return [
    "diff --git a/src/review/lineHeightProbe.ts b/src/review/lineHeightProbe.ts",
    "index abcdef1..1234567 100644",
    "--- a/src/review/lineHeightProbe.ts",
    "+++ b/src/review/lineHeightProbe.ts",
    "@@ -1,8 +1,9 @@",
    "-export const BASE_ROW_HEIGHT = 20;",
    "+export const BASE_ROW_HEIGHT = 22;",
    '+export const ROW_HEIGHT_MODE = "immersive";',
    " export function resolveRowHeight(scale = 1): number {",
    "   return BASE_ROW_HEIGHT * scale;",
    " }",
    ...oversizedContextLines,
    '-export const ROW_HEIGHT_LABEL = "compact";',
    '+export const ROW_HEIGHT_LABEL = "immersive";',
    "",
  ].join("\n");
}

export default {
  ...appMeta,
  title: "App/RightSidebar",
  decorators: [
    (Story: ComponentType) => (
      <div style={{ width: 1600, height: "100dvh" }}>
        <Story />
      </div>
    ),
  ],
  parameters: {
    ...appMeta.parameters,
    chromatic: {
      ...(appMeta.parameters?.chromatic ?? {}),
      modes: {
        dark: { theme: "dark", viewport: 1600 },
        light: { theme: "light", viewport: 1600 },
      },
    },
  },
};

export const ReviewTabImmersiveLineHeightDebug: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        localStorage.setItem(RIGHT_SIDEBAR_TAB_KEY, JSON.stringify("review"));
        localStorage.setItem(RIGHT_SIDEBAR_WIDTH_KEY, "760");
        localStorage.removeItem(getRightSidebarLayoutKey(LINE_HEIGHT_DEBUG_WORKSPACE_ID));
        updatePersistedState(getReviewImmersiveKey(LINE_HEIGHT_DEBUG_WORKSPACE_ID), true);

        const client = setupSimpleChatStory({
          workspaceId: LINE_HEIGHT_DEBUG_WORKSPACE_ID,
          workspaceName: "feature/immersive-line-height",
          projectName: "my-app",
          messages: [
            createUserMessage("msg-1", "Please review this formatter cleanup.", {
              historySequence: 1,
            }),
            createAssistantMessage("msg-2", "Added Intl formatter and cleanup.", {
              historySequence: 2,
            }),
          ],
          gitDiff: {
            diffOutput: IMMERSIVE_LINE_HEIGHT_DIFF,
            numstatOutput: IMMERSIVE_LINE_HEIGHT_NUMSTAT,
          },
        });

        expandRightSidebar();
        return client;
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await waitFor(
      () => {
        canvas.getByTestId("immersive-review-view");
        canvas.getByRole("button", { name: /exit immersive review/i });
      },
      { timeout: 10_000 }
    );
  },
};

export const ImmersiveReviewComplete: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        localStorage.setItem(RIGHT_SIDEBAR_TAB_KEY, JSON.stringify("review"));
        localStorage.setItem(RIGHT_SIDEBAR_WIDTH_KEY, "760");
        localStorage.setItem("review-show-read", JSON.stringify(false));
        localStorage.removeItem(getRightSidebarLayoutKey(IMMERSIVE_REVIEW_COMPLETE_WORKSPACE_ID));
        updatePersistedState(getReviewImmersiveKey(IMMERSIVE_REVIEW_COMPLETE_WORKSPACE_ID), true);
        setReadHunks(
          IMMERSIVE_REVIEW_COMPLETE_WORKSPACE_ID,
          getDiffHunkIds(IMMERSIVE_LINE_HEIGHT_DIFF)
        );

        const client = setupSimpleChatStory({
          workspaceId: IMMERSIVE_REVIEW_COMPLETE_WORKSPACE_ID,
          workspaceName: "feature/immersive-review-complete",
          projectName: "my-app",
          messages: [
            createUserMessage("msg-1", "Finish this immersive review walkthrough.", {
              historySequence: 1,
            }),
            createAssistantMessage("msg-2", "All hunks are already reviewed.", {
              historySequence: 2,
            }),
          ],
          gitDiff: {
            diffOutput: IMMERSIVE_LINE_HEIGHT_DIFF,
            numstatOutput: IMMERSIVE_LINE_HEIGHT_NUMSTAT,
          },
        });

        expandRightSidebar();
        return client;
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await waitFor(
      () => {
        canvas.getByTestId("immersive-review-complete");
        canvas.getByRole("heading", { name: /Review complete/i });
        canvas.getByRole("button", { name: /Return to chat/i });
        if (canvas.queryByText(/No hunks for this file/i)) {
          throw new Error(
            "Expected the immersive review completion state instead of the empty-file copy."
          );
        }
      },
      { timeout: 10_000 }
    );
  },
};

export const ImmersiveNotesSidebarActionFooter: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        localStorage.setItem(RIGHT_SIDEBAR_TAB_KEY, JSON.stringify("review"));
        localStorage.setItem(RIGHT_SIDEBAR_WIDTH_KEY, "760");
        localStorage.removeItem(getRightSidebarLayoutKey(IMMERSIVE_NOTES_PREVIEW_WORKSPACE_ID));
        updatePersistedState(getReviewImmersiveKey(IMMERSIVE_NOTES_PREVIEW_WORKSPACE_ID), true);
        setReviews(IMMERSIVE_NOTES_PREVIEW_WORKSPACE_ID, [
          createReview(
            "review-footer-1",
            "src/utils/formatPrice.ts",
            "1-4",
            "Keep the formatter instance shared so the fallback and regular output stay aligned when the currency changes.",
            "pending",
            IMMERSIVE_NOTES_PREVIEW_BASE_TIME + 1
          ),
          createReview(
            "review-footer-2",
            "src/utils/formatPrice.ts",
            "6-8",
            "The shorter note makes it easier to compare where each card footer lands.",
            "checked",
            IMMERSIVE_NOTES_PREVIEW_BASE_TIME + 2
          ),
        ]);

        const client = setupSimpleChatStory({
          workspaceId: IMMERSIVE_NOTES_PREVIEW_WORKSPACE_ID,
          workspaceName: "feature/immersive-note-preview-footer",
          projectName: "my-app",
          messages: [
            createUserMessage("msg-1", "Please review this pricing formatter update.", {
              historySequence: 1,
            }),
            createAssistantMessage(
              "msg-2",
              "I opened immersive review with a couple of sidebar notes.",
              {
                historySequence: 2,
              }
            ),
          ],
          gitDiff: {
            diffOutput: IMMERSIVE_LINE_HEIGHT_DIFF,
            numstatOutput: IMMERSIVE_LINE_HEIGHT_NUMSTAT,
          },
        });

        expandRightSidebar();
        return client;
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await waitFor(
      () => {
        canvas.getByTestId("immersive-review-view");
        canvas.getByText(/Keep the formatter instance shared/i);
      },
      { timeout: 10_000 }
    );

    const noteCard = canvasElement.querySelector<HTMLElement>('[data-note-index="0"]');
    if (!noteCard) {
      throw new Error("Expected the first immersive review note card to render.");
    }

    // Focus the first card so Storybook captures the reserved footer state that prevents
    // the note preview layout from shifting when review actions appear. Focus is more
    // deterministic than hover in the CI interaction runner while exercising the same UI.
    noteCard.focus();

    await waitFor(() => {
      const deleteButton = noteCard.querySelector<HTMLButtonElement>(
        'button[aria-label="Delete review note"]'
      );
      if (!deleteButton) {
        throw new Error("Expected the focused note card to include a delete action.");
      }

      const computedStyle = window.getComputedStyle(deleteButton);
      if (computedStyle.visibility !== "visible" || computedStyle.opacity !== "1") {
        throw new Error("Expected the note footer action to be visible after focusing the card.");
      }
    });
  },
};

export const ReviewTabImmersiveHighlightVsPlainHeight: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        localStorage.setItem(RIGHT_SIDEBAR_TAB_KEY, JSON.stringify("review"));
        localStorage.setItem(RIGHT_SIDEBAR_WIDTH_KEY, "760");
        localStorage.removeItem(getRightSidebarLayoutKey(HIGHLIGHT_VS_PLAIN_WORKSPACE_ID));
        updatePersistedState(getReviewImmersiveKey(HIGHLIGHT_VS_PLAIN_WORKSPACE_ID), true);

        const diffOutput = buildHighlightVsPlainDiffOutput();
        const client = setupSimpleChatStory({
          workspaceId: HIGHLIGHT_VS_PLAIN_WORKSPACE_ID,
          workspaceName: "feature/immersive-highlight-vs-plain",
          projectName: "my-app",
          messages: [
            createUserMessage("msg-1", "Can you compare highlight and plain line heights?", {
              historySequence: 1,
            }),
            createAssistantMessage(
              "msg-2",
              "I generated a mixed diff where one oversized context chunk falls back to plain text.",
              {
                historySequence: 2,
              }
            ),
          ],
          gitDiff: {
            diffOutput,
            numstatOutput: HIGHLIGHT_VS_PLAIN_NUMSTAT,
          },
        });

        expandRightSidebar();
        return client;
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await waitFor(
      () => {
        canvas.getByTestId("immersive-review-view");
        canvas.getByRole("button", { name: /exit immersive review/i });
      },
      { timeout: 10_000 }
    );
  },
};

export const ImmersiveWithMinimap: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        localStorage.setItem(RIGHT_SIDEBAR_TAB_KEY, JSON.stringify("review"));
        localStorage.setItem(RIGHT_SIDEBAR_WIDTH_KEY, "760");
        localStorage.removeItem(getRightSidebarLayoutKey(IMMERSIVE_MINIMAP_WORKSPACE_ID));
        updatePersistedState(getReviewImmersiveKey(IMMERSIVE_MINIMAP_WORKSPACE_ID), true);

        const diffOutput = buildMinimapDiffOutput();
        const client = setupSimpleChatStory({
          workspaceId: IMMERSIVE_MINIMAP_WORKSPACE_ID,
          workspaceName: "feature/immersive-minimap",
          projectName: "my-app",
          messages: [
            createUserMessage("msg-1", "Show immersive review with a minimap.", {
              historySequence: 1,
            }),
            createAssistantMessage("msg-2", "Opened immersive review with a dense diff.", {
              historySequence: 2,
            }),
          ],
          gitDiff: {
            diffOutput,
            numstatOutput: IMMERSIVE_MINIMAP_NUMSTAT,
          },
        });

        expandRightSidebar();
        return client;
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await waitFor(
      () => {
        canvas.getByTestId("immersive-review-view");
        canvas.getByRole("button", { name: /exit immersive review/i });
      },
      { timeout: 10_000 }
    );
  },
};
