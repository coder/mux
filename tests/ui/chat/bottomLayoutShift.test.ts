import "../dom";

import { fireEvent, waitFor } from "@testing-library/react";

// App-level UI tests render the loader shell first, so stub Lottie before importing the
// harness to keep happy-dom from tripping over lottie-web's canvas bootstrap.
jest.mock("lottie-react", () => ({
  __esModule: true,
  default: () => null,
}));

import { preloadTestModules } from "../../ipc/setup";
import { generateBranchName } from "../../ipc/helpers";
import { createAppHarness, ChatHarness } from "../harness";
import { workspaceStore } from "@/browser/stores/WorkspaceStore";
import { detectDefaultTrunkBranch } from "@/node/git";

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
      let scrollHeight = 1120;
      let clientHeight = 400;
      const maxScrollTop = () => scrollHeight - clientHeight;
      let scrollTop = maxScrollTop();

      Object.defineProperty(messageWindow, "scrollTop", {
        configurable: true,
        get: () => scrollTop,
        set: (nextValue: number) => {
          scrollTop = Math.min(maxScrollTop(), Math.max(0, nextValue));
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

      expect(scrollTop).toBe(maxScrollTop());
    } finally {
      (globalThis as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver =
        originalResizeObserver;
      await app.dispose();
    }
  }, 60_000);

  test("opens an idle chat at the transcript bottom after user-owned scroll", async () => {
    const app = await createAppHarness({ branchPrefix: "idle-chat-bottom" });
    let idleWorkspaceId: string | null = null;

    try {
      await app.chat.send("Seed source before switching to idle chat");
      await app.chat.expectStreamComplete();

      const trunkBranch = await detectDefaultTrunkBranch(app.repoPath);
      const idleResult = await app.env.orpc.workspace.create({
        projectPath: app.repoPath,
        branchName: generateBranchName("idle-chat-bottom-target"),
        trunkBranch,
      });
      if (!idleResult.success) {
        throw new Error(`Failed to create idle workspace: ${idleResult.error}`);
      }
      idleWorkspaceId = idleResult.metadata.id;
      workspaceStore.addWorkspace(idleResult.metadata);

      const idleRow = await waitFor(
        () => {
          const row = app.view.container.querySelector(
            `[data-workspace-id="${idleWorkspaceId}"]`
          ) as HTMLElement | null;
          if (!row) {
            throw new Error("Idle workspace row not rendered");
          }
          if (row.getAttribute("aria-disabled") === "true") {
            throw new Error("Idle workspace row is disabled");
          }
          return row;
        },
        { timeout: 10_000 }
      );
      fireEvent.click(idleRow);

      const idleChat = new ChatHarness(app.view.container, idleWorkspaceId);
      await idleChat.send("Seed idle target transcript");
      await idleChat.expectStreamComplete();

      const sourceRow = await waitFor(
        () => {
          const row = app.view.container.querySelector(
            `[data-workspace-id="${app.workspaceId}"]`
          ) as HTMLElement | null;
          if (!row) {
            throw new Error("Source workspace row not rendered");
          }
          return row;
        },
        { timeout: 10_000 }
      );
      fireEvent.click(sourceRow);

      const messageWindow = getMessageWindow(app.view.container);
      let scrollTop = 900;
      let scrollHeight = 1800;
      const clientHeight = 500;
      const maxScrollTop = () => scrollHeight - clientHeight;

      Object.defineProperty(messageWindow, "scrollTop", {
        configurable: true,
        get: () => scrollTop,
        set: (nextValue: number) => {
          scrollTop = Math.min(maxScrollTop(), Math.max(0, nextValue));
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

      // Prove workspace-open reacquires the tail from a user-owned source scroll.
      fireEvent.wheel(messageWindow);
      scrollTop = 250;
      fireEvent.scroll(messageWindow);

      scrollHeight = 2200;
      fireEvent.click(idleRow);

      await waitFor(() => {
        expect(scrollTop).toBe(maxScrollTop());
      });

      // Expanded tool/details panes can become the browser's preferred scroll anchor
      // during a chat switch. Bottom-lock owns the transcript, so any non-user drift
      // after open must be corrected instead of leaving the tail slightly hidden.
      scrollTop = maxScrollTop() - 24;
      fireEvent.scroll(messageWindow);

      await waitFor(() => {
        expect(scrollTop).toBe(maxScrollTop());
      });
    } finally {
      if (idleWorkspaceId) {
        await app.env.orpc.workspace
          .remove({ workspaceId: idleWorkspaceId, options: { force: true } })
          .catch(() => {});
      }
      await app.dispose();
    }
  }, 60_000);

  test("keeps the transcript pinned when send-time footer UI appears", async () => {
    const app = await createAppHarness({ branchPrefix: "bottom-layout-shift" });

    try {
      await app.chat.send("Seed transcript before testing bottom pinning");
      await app.chat.expectStreamComplete();
      await app.chat.expectTranscriptContains(
        "Mock response: Seed transcript before testing bottom pinning"
      );

      const messageWindow = getMessageWindow(app.view.container);
      let scrollHeight = 1000;
      const clientHeight = 400;
      const maxScrollTop = () => scrollHeight - clientHeight;
      let scrollTop = maxScrollTop();

      Object.defineProperty(messageWindow, "scrollTop", {
        configurable: true,
        get: () => scrollTop,
        set: (nextValue: number) => {
          scrollTop = Math.min(maxScrollTop(), Math.max(0, nextValue));
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

      // The bottom-lock path pins the transcript immediately via layout/resize
      // signals; there is no timer/RAF path to race a frame at the wrong scrollTop.
      expect(scrollTop).toBe(maxScrollTop());

      app.env.services.aiService.releaseMockStreamStartGate(app.workspaceId);
      await app.chat.expectStreamComplete();
    } finally {
      await app.dispose();
    }
  }, 60_000);
});
