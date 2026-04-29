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
import { MOCK_TOOL_FLOW_PROMPTS } from "../../e2e/mockAiPrompts";

interface MockedScrollPort {
  setScrollHeight: (height: number) => void;
  setClientHeight: (height: number) => void;
  setScrollTop: (top: number) => void;
  getScrollTop: () => number;
  getMaxScrollTop: () => number;
}

function mockScrollportMetrics(
  element: HTMLElement,
  initial: { scrollHeight: number; clientHeight: number; scrollTop?: number }
): MockedScrollPort {
  let scrollHeight = initial.scrollHeight;
  let clientHeight = initial.clientHeight;
  const maxScrollTop = () => Math.max(0, scrollHeight - clientHeight);
  const clamp = (value: number) => Math.min(maxScrollTop(), Math.max(0, value));
  let scrollTop = clamp(initial.scrollTop ?? maxScrollTop());

  Object.defineProperty(element, "scrollTop", {
    configurable: true,
    get: () => scrollTop,
    set: (next: number) => {
      scrollTop = clamp(next);
    },
  });
  Object.defineProperty(element, "scrollHeight", {
    configurable: true,
    get: () => scrollHeight,
  });
  Object.defineProperty(element, "clientHeight", {
    configurable: true,
    get: () => clientHeight,
  });

  return {
    setScrollHeight(next) {
      scrollHeight = next;
      scrollTop = clamp(scrollTop);
    },
    setClientHeight(next) {
      clientHeight = next;
      scrollTop = clamp(scrollTop);
    },
    setScrollTop(next) {
      scrollTop = clamp(next);
    },
    getScrollTop() {
      return scrollTop;
    },
    getMaxScrollTop: maxScrollTop,
  };
}

async function waitForBashScriptSpan(
  container: HTMLElement,
  script: string
): Promise<HTMLSpanElement> {
  return waitFor(
    () => {
      const matches = Array.from(container.querySelectorAll("span")).filter(
        (span) => span.textContent?.trim() === script
      );
      const span = matches[matches.length - 1];
      if (!span) throw new Error(`Bash script span "${script}" not found yet`);
      return span as HTMLSpanElement;
    },
    { timeout: 10_000 }
  );
}

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
    const app = await createAppHarness({ branchPrefix: "viewport-resize-pin" });

    try {
      await app.chat.send("Seed transcript before testing viewport resize pinning");
      await app.chat.expectStreamComplete();
      const messageWindow = getMessageWindow(app.view.container);
      const port = mockScrollportMetrics(messageWindow, {
        scrollHeight: 1120,
        clientHeight: 400,
      });

      // Composer grows (e.g. multi-line input), shrinking the transcript viewport.
      // The bottom-lock invariant must produce scrollTop = scrollHeight - clientHeight
      // before the next paint, regardless of whether ResizeObserver fires. Our rAF
      // loop in `useAutoScroll` is responsible for that and runs in happy-dom too.
      port.setClientHeight(520);

      await waitFor(() => {
        expect(port.getScrollTop()).toBe(port.getMaxScrollTop());
      });
    } finally {
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

      // Workspace switching + transcript hydration + the layout-effect chain can
      // take several seconds on slow CI runners, so wait long enough for the
      // workspaceId-keyed layout effect inside ChatPane to invoke jumpToBottom.
      await waitFor(
        () => {
          expect(scrollTop).toBe(maxScrollTop());
        },
        { timeout: 10_000 }
      );

      // Expanding the last tool/details row starts with a mousedown inside transcript
      // content and can make the browser pick a new scroll anchor. The click is not
      // transcript scroll intent, so the follow-up drift must still be corrected.
      const transcriptChild = messageWindow.firstElementChild as HTMLElement | null;
      if (!transcriptChild) {
        throw new Error("Transcript child not rendered");
      }
      fireEvent.mouseDown(transcriptChild);
      scrollTop = maxScrollTop() - 24;
      fireEvent.scroll(messageWindow);

      await waitFor(
        () => {
          expect(scrollTop).toBe(maxScrollTop());
        },
        { timeout: 10_000 }
      );
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

  test("keeps the transcript pinned when the last bash tool call is expanded", async () => {
    const app = await createAppHarness({ branchPrefix: "expand-bash-bottom" });

    try {
      await app.chat.send(MOCK_TOOL_FLOW_PROMPTS.LIST_DIRECTORY);
      await app.chat.expectStreamComplete();
      // Mock streaming finishes faster than the 300ms bash auto-expand timer, so the
      // bash row settles collapsed. Clicking it is the user's "open the last bash"
      // gesture and is the exact case the user reports as drifting above bottom.
      await app.chat.expectTranscriptContains("Directory listing:");

      const messageWindow = getMessageWindow(app.view.container);
      const port = mockScrollportMetrics(messageWindow, {
        scrollHeight: 1000,
        clientHeight: 400,
      });
      expect(port.getScrollTop()).toBe(port.getMaxScrollTop());

      const scriptSpan = await waitForBashScriptSpan(messageWindow, "ls -1");
      const bashHeader = scriptSpan.parentElement;
      if (!bashHeader) throw new Error("Bash tool header missing");

      // Expand: real Chromium dispatches mousedown then click. The mousedown
      // targets a child of the scrollport, so the bottom lock is NOT released; the
      // click triggers React state and the transcript grows. The rAF loop must
      // pin to the new max regardless of whether ResizeObserver fires.
      fireEvent.mouseDown(bashHeader);
      fireEvent.click(bashHeader);

      port.setScrollHeight(1300);
      await waitFor(() => {
        expect(port.getScrollTop()).toBe(port.getMaxScrollTop());
      });

      // CSS transitions on the tool container animate padding over ~200ms, producing
      // multiple sub-frame layout changes. Each must keep us pinned.
      for (const next of [1304, 1308, 1320]) {
        port.setScrollHeight(next);
        await waitFor(() => {
          expect(port.getScrollTop()).toBe(port.getMaxScrollTop());
        });
      }
    } finally {
      await app.dispose();
    }
  }, 60_000);

  test("keeps the transcript pinned when async layout growth lands after settle", async () => {
    const app = await createAppHarness({ branchPrefix: "async-growth-bottom" });

    try {
      // Drive any non-trivial response — the goal is to settle the chat at the bottom,
      // then simulate late async layout (Shiki/Mermaid/font-swap) growing the transcript.
      await app.chat.send("Seed transcript before testing async layout growth");
      await app.chat.expectStreamComplete();

      const messageWindow = getMessageWindow(app.view.container);
      const port = mockScrollportMetrics(messageWindow, {
        scrollHeight: 900,
        clientHeight: 400,
      });

      // Late async layout shifts (Shiki finishing highlight, fonts/images settling)
      // push scrollHeight up after the initial pin. The bottom lock must produce
      // scrollTop = max for each step, even when no React re-render or RO fires.
      for (const newHeight of [950, 1010, 1080, 1180]) {
        port.setScrollHeight(newHeight);
        await waitFor(() => {
          expect(port.getScrollTop()).toBe(port.getMaxScrollTop());
        });
      }
    } finally {
      await app.dispose();
    }
  }, 60_000);
});
