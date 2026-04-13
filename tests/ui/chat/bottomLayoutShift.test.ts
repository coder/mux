import "../dom";

import { waitFor } from "@testing-library/react";

// App-level UI tests render the loader shell first, so stub Lottie before importing the
// harness to keep happy-dom from tripping over lottie-web's canvas bootstrap.
jest.mock("lottie-react", () => ({
  __esModule: true,
  default: () => null,
}));

import { preloadTestModules } from "../../ipc/setup";
import { createAppHarness } from "../harness";
import { workspaceStore } from "@/browser/stores/WorkspaceStore";

function getMessageWindow(container: HTMLElement): HTMLDivElement {
  const element = container.querySelector('[data-testid="message-window"]');
  if (!element || element.tagName !== "DIV") {
    throw new Error("Message window not found");
  }
  return element as HTMLDivElement;
}

describe("Chat bottom layout stability", () => {
  beforeAll(async () => {
    await preloadTestModules();
  });

  test("keeps the transcript pinned when the composer resize changes the viewport", async () => {
    const originalResizeObserver = globalThis.ResizeObserver;
    const resizeCallbacks = new Map<Element, ResizeObserverCallback[]>();

    class ResizeObserverMock {
      private readonly callback: ResizeObserverCallback;

      constructor(callback: ResizeObserverCallback) {
        this.callback = callback;
      }

      observe(target: Element) {
        resizeCallbacks.set(target, [...(resizeCallbacks.get(target) ?? []), this.callback]);
      }

      unobserve(target: Element) {
        const remainingCallbacks = (resizeCallbacks.get(target) ?? []).filter(
          (callback) => callback !== this.callback
        );
        if (remainingCallbacks.length === 0) {
          resizeCallbacks.delete(target);
          return;
        }
        resizeCallbacks.set(target, remainingCallbacks);
      }

      disconnect() {
        for (const [target, callbacks] of resizeCallbacks) {
          const remainingCallbacks = callbacks.filter((callback) => callback !== this.callback);
          if (remainingCallbacks.length === 0) {
            resizeCallbacks.delete(target);
            continue;
          }
          resizeCallbacks.set(target, remainingCallbacks);
        }
      }

      takeRecords(): ResizeObserverEntry[] {
        return [];
      }
    }

    (globalThis as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver =
      ResizeObserverMock as unknown as typeof ResizeObserver;

    const app = await createAppHarness({ branchPrefix: "viewport-resize-pin" });

    try {
      await app.chat.send("Seed transcript before testing viewport resize pinning");
      await app.chat.expectStreamComplete();
      const messageWindow = getMessageWindow(app.view.container);
      let scrollTop = 920;
      let scrollHeight = 1120;
      let clientHeight = 400;

      Object.defineProperty(messageWindow, "scrollTop", {
        configurable: true,
        get: () => scrollTop,
        set: (nextValue: number) => {
          scrollTop = nextValue;
        },
      });
      Object.defineProperty(messageWindow, "scrollHeight", {
        configurable: true,
        get: () => scrollHeight,
      });
      Object.defineProperty(messageWindow, "clientHeight", {
        configurable: true,
        get: () => clientHeight,
      });

      await waitFor(() => {
        const callbacks = resizeCallbacks.get(messageWindow);
        if (!callbacks || callbacks.length === 0) {
          throw new Error("Transcript viewport resize observer is not attached yet");
        }
      });

      clientHeight = 520;
      for (const callback of resizeCallbacks.get(messageWindow) ?? []) {
        callback(
          [
            {
              target: messageWindow,
              contentRect: { height: clientHeight } as DOMRectReadOnly,
            } as unknown as ResizeObserverEntry,
          ],
          {} as ResizeObserver
        );
      }

      expect(scrollTop).toBe(scrollHeight);
    } finally {
      (globalThis as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver =
        originalResizeObserver;
      await app.dispose();
    }
  }, 60_000);

  test("keeps the transcript pinned when send-time footer UI appears", async () => {
    const app = await createAppHarness({ branchPrefix: "bottom-layout-shift" });

    const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
    const originalWindowRequestAnimationFrame = window.requestAnimationFrame;
    const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
    const originalWindowCancelAnimationFrame = window.cancelAnimationFrame;
    const queuedAnimationFrames: FrameRequestCallback[] = [];

    try {
      await app.chat.send("Seed transcript before testing bottom pinning");
      await app.chat.expectStreamComplete();
      await app.chat.expectTranscriptContains(
        "Mock response: Seed transcript before testing bottom pinning"
      );

      // Let the previous turn's queued auto-scroll frames settle before we freeze the async path.
      await new Promise<void>((resolve) => originalRequestAnimationFrame(() => resolve()));
      await new Promise<void>((resolve) => originalRequestAnimationFrame(() => resolve()));

      const messageWindow = getMessageWindow(app.view.container);
      let scrollTop = 1000;
      let scrollHeight = 1000;

      Object.defineProperty(messageWindow, "scrollTop", {
        configurable: true,
        get: () => scrollTop,
        set: (nextValue: number) => {
          scrollTop = nextValue;
        },
      });
      Object.defineProperty(messageWindow, "scrollHeight", {
        configurable: true,
        get: () => scrollHeight,
      });
      Object.defineProperty(messageWindow, "clientHeight", {
        configurable: true,
        get: () => 400,
      });

      const requestAnimationFrameMock: typeof requestAnimationFrame = (callback) => {
        queuedAnimationFrames.push(callback);
        return queuedAnimationFrames.length;
      };
      const cancelAnimationFrameMock: typeof cancelAnimationFrame = () => undefined;

      globalThis.requestAnimationFrame = requestAnimationFrameMock;
      window.requestAnimationFrame = requestAnimationFrameMock;
      globalThis.cancelAnimationFrame = cancelAnimationFrameMock;
      window.cancelAnimationFrame = cancelAnimationFrameMock;

      // Simulate the extra tail height added by the send-time user row + starting barrier.
      scrollHeight = 1120;
      await app.chat.send("[mock:wait-start] Hold stream-start so the footer stays visible");

      await waitFor(
        () => {
          const state = workspaceStore.getWorkspaceSidebarState(app.workspaceId);
          if (!state.isStarting) {
            throw new Error("Workspace is not in starting state yet");
          }
        },
        { timeout: 10_000 }
      );

      // The layout-fix path should pin the transcript immediately, even while async RAF-based
      // auto-scroll work is still queued.
      expect(scrollTop).toBe(scrollHeight);
      expect(queuedAnimationFrames.length).toBeGreaterThan(0);

      app.env.services.aiService.releaseMockStreamStartGate(app.workspaceId);
      await app.chat.expectStreamComplete();
    } finally {
      globalThis.requestAnimationFrame = originalRequestAnimationFrame;
      window.requestAnimationFrame = originalWindowRequestAnimationFrame;
      globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
      window.cancelAnimationFrame = originalWindowCancelAnimationFrame;
      await app.dispose();
    }
  }, 60_000);
});
