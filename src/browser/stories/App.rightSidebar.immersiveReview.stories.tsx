import { within, waitFor } from "@storybook/test";
import type { ComponentType } from "react";

import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import {
  RIGHT_SIDEBAR_TAB_KEY,
  RIGHT_SIDEBAR_WIDTH_KEY,
  getReviewImmersiveKey,
  getRightSidebarLayoutKey,
} from "@/common/constants/storage";

import { appMeta, AppWithMocks, type AppStory } from "./meta.js";
import { createAssistantMessage, createUserMessage } from "./mockFactory";
import { expandRightSidebar, setupSimpleChatStory } from "./storyHelpers";

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
