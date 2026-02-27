/**
 * Phone viewport stories - catch responsive/layout regressions.
 *
 * These are full-app stories rendered inside fixed iPhone-sized containers, and
 * Chromatic is configured to snapshot both light and dark themes.
 */

import { within, waitFor } from "@storybook/test";
import type { ComponentType } from "react";

import { CUSTOM_EVENTS, createCustomEvent } from "@/common/constants/events";

import { LEFT_SIDEBAR_COLLAPSED_KEY } from "@/common/constants/storage";

import { appMeta, AppWithMocks, type AppStory } from "./meta.js";
import {
  createAssistantMessage,
  createUserMessage,
  createWorkspace,
  groupWorkspacesByProject,
  STABLE_TIMESTAMP,
} from "./mockFactory";
import {
  clearWorkspaceSelection,
  collapseRightSidebar,
  expandProjects,
  setupSimpleChatStory,
} from "./storyHelpers";
import { createMockORPCClient } from "./mocks/orpc";
import {
  blurActiveElement,
  waitForChatInputAutofocusDone,
  waitForScrollStabilization,
} from "./storyPlayHelpers.js";

const IPHONE_16E = {
  // Source: https://ios-resolution.info/ (logical resolution)
  width: 390,
  height: 844,
} as const;

// NOTE: Mux's mobile UI tweaks are gated on `@media (max-width: 768px) and (pointer: coarse)`.
// Chromatic can emulate touch via `hasTouch: true` in modes, which ensures the
// right sidebar is hidden and the mobile header/sidebar affordances are visible.

const IPHONE_17_PRO_MAX = {
  // Source: https://ios-resolution.info/ (logical resolution)
  width: 440,
  height: 956,
} as const;

function IPhone16eDecorator(Story: ComponentType) {
  return (
    <div style={{ width: IPHONE_16E.width, height: IPHONE_16E.height, overflow: "hidden" }}>
      <Story />
    </div>
  );
}

function IPhone17ProMaxDecorator(Story: ComponentType) {
  return (
    <div
      style={{
        width: IPHONE_17_PRO_MAX.width,
        height: IPHONE_17_PRO_MAX.height,
        overflow: "hidden",
      }}
    >
      <Story />
    </div>
  );
}

const MESSAGES = [
  createUserMessage(
    "msg-1",
    "Smoke-test the UI at phone widths (sidebar, chat, overflow wrapping).",
    { historySequence: 1, timestamp: STABLE_TIMESTAMP - 120_000 }
  ),
  createAssistantMessage(
    "msg-2",
    "Done. Pay extra attention to long paths like `src/browser/components/WorkspaceSidebar/WorkspaceSidebar.tsx` and whether they wrap without horizontal scrolling.",
    { historySequence: 2, timestamp: STABLE_TIMESTAMP - 110_000 }
  ),
  createUserMessage(
    "msg-3",
    "Also check that buttons are still clickable and text isn’t clipped in light mode.",
    { historySequence: 3, timestamp: STABLE_TIMESTAMP - 100_000 }
  ),
] as const;

const TOUCH_REVIEW_IMMERSIVE_WORKSPACE_ID = "ws-iphone-17-pro-max-touch-review";
const TOUCH_REVIEW_IMMERSIVE_DIFF = `diff --git a/src/mobile/review.tsx b/src/mobile/review.tsx
index 1111111..2222222 100644
--- a/src/mobile/review.tsx
+++ b/src/mobile/review.tsx
@@ -10,6 +10,10 @@ export function ReviewPanel() {
   return (
     <section>
+      <h2 className="sr-only">Touch review</h2>
       <p>Review hunk interactions on mobile.</p>
+      <p>Tap any changed line to add a note immediately.</p>
     </section>
   );
 }
`;
const TOUCH_REVIEW_IMMERSIVE_NUMSTAT = "2\t0\tsrc/mobile/review.tsx";

export default {
  ...appMeta,
  title: "App/PhoneViewports",
};

async function stabilizePhoneViewportStory(canvasElement: HTMLElement) {
  const storyRoot = document.getElementById("storybook-root") ?? canvasElement;
  await waitForChatInputAutofocusDone(storyRoot);
  await waitForScrollStabilization(storyRoot);
  blurActiveElement();
}

export const IPhone16e: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          workspaceId: "ws-iphone-16e",
          workspaceName: "mobile",
          projectName: "mux",
          messages: [...MESSAGES],
        })
      }
    />
  ),
  decorators: [IPhone16eDecorator],
  parameters: {
    ...appMeta.parameters,
    chromatic: {
      ...(appMeta.parameters?.chromatic ?? {}),
      cropToViewport: true,
      modes: {
        dark: { theme: "dark", viewport: IPHONE_16E, hasTouch: true },
        light: { theme: "light", viewport: IPHONE_16E, hasTouch: true },
      },
    },
  },
  play: async ({ canvasElement }) => {
    await stabilizePhoneViewportStory(canvasElement);
  },
};

export const IPhone17ProMax: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          workspaceId: "ws-iphone-17-pro-max",
          workspaceName: "mobile",
          projectName: "mux",
          messages: [...MESSAGES],
        })
      }
    />
  ),
  decorators: [IPhone17ProMaxDecorator],
  parameters: {
    ...appMeta.parameters,
    chromatic: {
      ...(appMeta.parameters?.chromatic ?? {}),
      cropToViewport: true,
      modes: {
        dark: { theme: "dark", viewport: IPHONE_17_PRO_MAX, hasTouch: true },
        light: { theme: "light", viewport: IPHONE_17_PRO_MAX, hasTouch: true },
      },
    },
  },
  play: async ({ canvasElement }) => {
    await stabilizePhoneViewportStory(canvasElement);
  },
};

export const IPhone17ProMaxTouchReviewImmersive: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          workspaceId: TOUCH_REVIEW_IMMERSIVE_WORKSPACE_ID,
          workspaceName: "mobile-review",
          projectName: "mux",
          messages: [...MESSAGES],
          gitDiff: {
            diffOutput: TOUCH_REVIEW_IMMERSIVE_DIFF,
            numstatOutput: TOUCH_REVIEW_IMMERSIVE_NUMSTAT,
          },
        })
      }
    />
  ),
  decorators: [IPhone17ProMaxDecorator],
  parameters: {
    ...appMeta.parameters,
    chromatic: {
      ...(appMeta.parameters?.chromatic ?? {}),
      cropToViewport: true,
      modes: {
        dark: { theme: "dark", viewport: IPHONE_17_PRO_MAX, hasTouch: true },
        light: { theme: "light", viewport: IPHONE_17_PRO_MAX, hasTouch: true },
      },
    },
  },
  play: async ({ canvasElement }) => {
    await stabilizePhoneViewportStory(canvasElement);

    window.dispatchEvent(
      createCustomEvent(CUSTOM_EVENTS.OPEN_TOUCH_REVIEW_IMMERSIVE, {
        workspaceId: TOUCH_REVIEW_IMMERSIVE_WORKSPACE_ID,
      })
    );

    const canvas = within(canvasElement);
    await waitFor(
      () => {
        canvas.getByTestId("immersive-review-view");
      },
      { timeout: 10_000 }
    );

    await waitFor(
      () => {
        const immersiveView = canvas.getByTestId("immersive-review-view");
        within(immersiveView).getByText(/Tap any changed line to add a note immediately\./i);
        if (canvas.queryByRole("heading", { name: "Notes" })) {
          throw new Error("Touch immersive mode should hide the desktop notes sidebar.");
        }
      },
      { timeout: 10_000 }
    );

    blurActiveElement();
  },
};

/**
 * Mobile sidebar with a project containing a custom section.
 * Verifies section header action buttons (+, color, rename, delete) are visible
 * on touch devices where hover state doesn't exist.
 */
export const IPhone16eSidebarWithSections: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        const projectPath = "/home/user/projects/my-app";
        const sectionId = "sec00001";

        const workspaces = [
          createWorkspace({
            id: "ws-unsectioned",
            name: "main",
            projectName: "my-app",
            projectPath,
          }),
          {
            ...createWorkspace({
              id: "ws-in-section-1",
              name: "feature/auth",
              projectName: "my-app",
              projectPath,
            }),
            sectionId,
          },
          {
            ...createWorkspace({
              id: "ws-in-section-2",
              name: "feature/payments",
              projectName: "my-app",
              projectPath,
            }),
            sectionId,
          },
        ];

        // Build project config with a custom section
        const projects = groupWorkspacesByProject(workspaces);
        const projectConfig = projects.get(projectPath)!;
        projects.set(projectPath, {
          ...projectConfig,
          sections: [{ id: sectionId, name: "Features", color: "#6366f1", nextId: null }],
        });

        // Sidebar open with no workspace selected so the sidebar content is visible
        clearWorkspaceSelection();
        collapseRightSidebar();
        expandProjects([projectPath]);
        window.localStorage.setItem(LEFT_SIDEBAR_COLLAPSED_KEY, JSON.stringify(false));

        return createMockORPCClient({ projects, workspaces });
      }}
    />
  ),
  decorators: [IPhone16eDecorator],
  parameters: {
    ...appMeta.parameters,
    chromatic: {
      ...(appMeta.parameters?.chromatic ?? {}),
      cropToViewport: true,
      modes: {
        dark: { theme: "dark", viewport: IPHONE_16E, hasTouch: true },
        light: { theme: "light", viewport: IPHONE_16E, hasTouch: true },
      },
    },
  },
  play: async ({ canvasElement }) => {
    // No workspace is selected so there's no ChatInput to wait for;
    // skip stabilizePhoneViewportStory and wait for the section directly.
    await waitFor(
      () => {
        const sectionHeader = canvasElement.querySelector('[data-section-id="sec00001"]');
        if (!sectionHeader) throw new Error("Section header not found");
        // Verify the section header action buttons are in the DOM.
        // The actual visibility assertion (opacity via CSS media query) is
        // validated by the Chromatic snapshot in touch mode — the Storybook
        // test runner doesn't emulate pointer:coarse media queries.
        within(sectionHeader as HTMLElement).getByLabelText("New workspace in section");
      },
      { timeout: 10_000 }
    );

    blurActiveElement();
  },
};
