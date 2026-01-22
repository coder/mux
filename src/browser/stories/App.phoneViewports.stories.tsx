/**
 * Phone viewport stories - catch responsive/layout regressions.
 *
 * These are full-app stories rendered inside fixed iPhone-sized containers, and
 * Chromatic is configured to snapshot both light and dark themes.
 */

import { appMeta, AppWithMocks, type AppStory } from "./meta.js";
import { createAssistantMessage, createUserMessage, STABLE_TIMESTAMP } from "./mockFactory";
import { setupSimpleChatStory } from "./storyHelpers";
import type { ComponentType } from "react";
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
