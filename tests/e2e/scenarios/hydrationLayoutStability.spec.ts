import type { Page } from "@playwright/test";
import { electronTest as test, electronExpect as expect } from "../electronTest";
import {
  LAST_VISITED_ROUTE_KEY,
  SELECTED_WORKSPACE_KEY,
} from "../../../src/common/constants/storage";

// Real-browser hydration regression coverage. happy-dom cannot observe the small
// first-paint geometry deltas users reported, so this samples consecutive Chromium
// animation frames and treats sub-pixel noise as OK while catching visible pixel jumps.
test.skip(
  ({ browserName }) => browserName !== "chromium",
  "Electron scenario runs on chromium only"
);

const CREATION_CHAT_INPUT_SECTION =
  '[data-component="ChatInputSection"][data-chat-input-variant="creation"]';
const MESSAGE_WINDOW = '[data-testid="message-window"]';
const COMPOSER_DOCK = '[data-testid="chat-composer-dock"]';
const FIRST_MESSAGE = "[data-message-id]";

const MAX_VISIBLE_VERTICAL_SHIFT_PX = 0.75;
const MAX_STARTUP_FRAMES = 600;
const FRAMES_AFTER_TARGET_VISIBLE = 45;
const SAMPLE_INTERVAL_MS = 25;

interface RectSnapshot {
  top: number;
  bottom: number;
  height: number;
}

interface HydrationFrame {
  frame: number;
  timestamp: number;
  hasMarker: boolean;
  chatInput: RectSnapshot | null;
  messageWindow: RectSnapshot | null;
  composer: RectSnapshot | null;
  firstMessage: RectSnapshot | null;
}

type RectKey = "chatInput" | "messageWindow" | "composer" | "firstMessage";
type RectProperty = keyof RectSnapshot;

function workspaceRoute(workspaceId: string): string {
  return `/workspace/${encodeURIComponent(workspaceId)}`;
}

async function restoreRouteOnReload(page: Page, route: string) {
  await page.evaluate(
    ({ routeKey, selectedWorkspaceKey, value }) => {
      localStorage.setItem(routeKey, JSON.stringify(value));
      if (value.startsWith("/project")) {
        localStorage.removeItem(selectedWorkspaceKey);
      }
    },
    { routeKey: LAST_VISITED_ROUTE_KEY, selectedWorkspaceKey: SELECTED_WORKSPACE_KEY, value: route }
  );
}

async function sampleHydrationFrame(
  page: Page,
  options: { frame: number; marker?: string }
): Promise<HydrationFrame> {
  return await page.evaluate(
    ({ frame, marker, selectors }) => {
      const snapshotRect = (selector: string): RectSnapshot | null => {
        const element = document.querySelector<HTMLElement>(selector);
        if (!element) return null;
        const rect = element.getBoundingClientRect();
        return {
          top: rect.top,
          bottom: rect.bottom,
          height: rect.height,
        };
      };

      const bodyText = document.body.textContent ?? "";
      return {
        frame,
        timestamp: performance.now(),
        hasMarker: marker ? bodyText.includes(marker) : false,
        chatInput: snapshotRect(selectors.chatInput),
        messageWindow: snapshotRect(selectors.messageWindow),
        composer: snapshotRect(selectors.composerDock),
        firstMessage: snapshotRect(selectors.firstMessage),
      };
    },
    {
      frame: options.frame,
      marker: options.marker ?? null,
      selectors: {
        chatInput: CREATION_CHAT_INPUT_SECTION,
        messageWindow: MESSAGE_WINDOW,
        composerDock: COMPOSER_DOCK,
        firstMessage: FIRST_MESSAGE,
      },
    }
  );
}

async function loadRouteForSampling(page: Page, route: string): Promise<void> {
  await restoreRouteOnReload(page, route);

  const currentUrl = new URL(page.url());
  if (currentUrl.protocol === "http:" || currentUrl.protocol === "https:") {
    await page.goto(new URL(route, currentUrl.origin).toString(), {
      waitUntil: "domcontentloaded",
    });
    return;
  }

  await page.reload({ waitUntil: "domcontentloaded" });
}

async function reloadAndSampleHydrationFrames(
  page: Page,
  options: { route?: string; marker?: string; target: RectKey }
): Promise<HydrationFrame[]> {
  if (options.route) {
    await loadRouteForSampling(page, options.route);
  }

  // Match the composer layout stability test: Playwright drives sampling because
  // renderer requestAnimationFrame can be throttled under headless xvfb.
  const frames: HydrationFrame[] = [];
  let visibleTargetFrameCount = 0;
  for (let frame = 0; frame < MAX_STARTUP_FRAMES; frame += 1) {
    const sample = await sampleHydrationFrame(page, { frame, marker: options.marker });
    frames.push(sample);

    if (sample[options.target] !== null && (!options.marker || sample.hasMarker)) {
      visibleTargetFrameCount += 1;
      if (visibleTargetFrameCount >= FRAMES_AFTER_TARGET_VISIBLE) {
        break;
      }
    }

    await page.waitForTimeout(SAMPLE_INTERVAL_MS);
  }

  return frames;
}

function firstFrameIndex(
  frames: readonly HydrationFrame[],
  predicate: (frame: HydrationFrame) => boolean
): number {
  const index = frames.findIndex(predicate);
  if (index === -1) {
    throw new Error("Expected hydration frame was never observed");
  }
  return index;
}

function maxRectDelta(
  frames: readonly HydrationFrame[],
  key: RectKey,
  property: RectProperty,
  fromIndex: number
): number {
  const visible = frames
    .slice(fromIndex)
    .map((frame) => frame[key])
    .filter(Boolean) as RectSnapshot[];
  if (visible.length < 2) {
    throw new Error(`Need at least two visible ${key} frames to measure layout stability`);
  }

  const values = visible.map((rect) => rect[property]);
  return Math.max(...values) - Math.min(...values);
}

async function waitForCompletedMockResponse(page: Page, marker: string): Promise<void> {
  await page.waitForFunction(
    (expectedMarker: string) => {
      const messages = document.querySelectorAll("[data-message-block]");
      const lastMessage = messages.length > 0 ? messages[messages.length - 1] : null;
      const lastMessageText = lastMessage?.textContent ?? "";
      const actionButtonCount =
        lastMessage?.querySelectorAll("[data-message-meta-actions] button").length ?? 0;
      return lastMessageText.includes(`Mock response: ${expectedMarker}`) && actionButtonCount > 1;
    },
    marker,
    { timeout: 60_000 }
  );
}

test.describe("Hydration layout stability", () => {
  test("keeps an existing chat shell vertically stable while a routed transcript opens", async ({
    page,
    ui,
    workspace,
  }) => {
    await ui.projects.openFirstWorkspace();
    const marker = "[[hydration-layout-stability-existing-chat]]";
    await ui.chat.sendMessage(`${marker} seed a completed transcript before reload`);
    await waitForCompletedMockResponse(page, marker);

    const frames = await reloadAndSampleHydrationFrames(page, {
      route: workspaceRoute(workspace.demoProject.workspaceId),
      marker,
      target: "messageWindow",
    });
    const firstWindowFrame = firstFrameIndex(frames, (frame) => frame.messageWindow !== null);
    const firstTranscriptFrame = firstFrameIndex(
      frames,
      (frame) => frame.hasMarker && frame.firstMessage !== null
    );

    expect(maxRectDelta(frames, "messageWindow", "top", firstWindowFrame)).toBeLessThanOrEqual(
      MAX_VISIBLE_VERTICAL_SHIFT_PX
    );
    expect(maxRectDelta(frames, "messageWindow", "height", firstWindowFrame)).toBeLessThanOrEqual(
      MAX_VISIBLE_VERTICAL_SHIFT_PX
    );
    expect(maxRectDelta(frames, "composer", "top", firstWindowFrame)).toBeLessThanOrEqual(
      MAX_VISIBLE_VERTICAL_SHIFT_PX
    );
    expect(maxRectDelta(frames, "firstMessage", "top", firstTranscriptFrame)).toBeLessThanOrEqual(
      MAX_VISIBLE_VERTICAL_SHIFT_PX
    );
  });
});
