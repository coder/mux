import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";
import type { BrowserSession } from "@/common/types/browserSession";

const sendInputMock = mock(() => Promise.resolve({ success: true }));

void mock.module("@/browser/contexts/API", () => ({
  useAPI: () => ({
    api: {
      browserSession: {
        sendInput: sendInputMock,
      },
    },
    status: "connected" as const,
    error: null,
    authenticate: () => undefined,
    retry: () => undefined,
  }),
}));

import { BrowserViewport, mapDomPointToViewport } from "./BrowserViewport";

const FRAME_METADATA = {
  deviceWidth: 100,
  deviceHeight: 100,
  pageScaleFactor: 1,
  offsetTop: 0,
  scrollOffsetX: 0,
  scrollOffsetY: 0,
} as const;

function createSession(overrides: Partial<BrowserSession> = {}): BrowserSession {
  return {
    id: "session-1",
    workspaceId: "workspace-1",
    status: "live",
    currentUrl: "https://example.com",
    title: "Example",
    lastScreenshotBase64: "frame-data",
    lastError: null,
    streamState: "live",
    lastFrameMetadata: { ...FRAME_METADATA },
    streamErrorMessage: null,
    endReason: null,
    startedAt: "2026-03-16T00:00:00.000Z",
    updatedAt: "2026-03-16T00:00:00.000Z",
    ...overrides,
  };
}

function renderViewport(
  session: BrowserSession,
  overrides?: {
    onRestart?: () => void;
    screenshotSrc?: string | null;
    visibleError?: string | null;
    visibleInfoNotice?: string | null;
  }
) {
  return render(
    <BrowserViewport
      workspaceId="workspace-1"
      session={session}
      screenshotSrc={
        overrides?.screenshotSrc === undefined
          ? "data:image/jpeg;base64,frame-data"
          : overrides.screenshotSrc
      }
      visibleError={overrides?.visibleError ?? null}
      visibleInfoNotice={overrides?.visibleInfoNotice ?? null}
      placeholder={<div>placeholder</div>}
      onRestart={overrides?.onRestart}
    />
  );
}

describe("BrowserViewport", () => {
  let originalWindow: typeof globalThis.window;
  let originalDocument: typeof globalThis.document;

  beforeEach(() => {
    originalWindow = globalThis.window;
    originalDocument = globalThis.document;

    globalThis.window = new GlobalWindow({ url: "http://localhost" }) as unknown as Window &
      typeof globalThis;
    globalThis.document = globalThis.window.document;
    sendInputMock.mockClear();
  });

  afterEach(() => {
    cleanup();
    mock.restore();
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
  });

  test("maps object-contain coordinates and ignores letterboxed gutters", () => {
    expect(
      mapDomPointToViewport(150, 100, { left: 0, top: 0, width: 300, height: 200 }, FRAME_METADATA)
    ).toEqual({ x: 50, y: 50 });
    expect(
      mapDomPointToViewport(10, 100, { left: 0, top: 0, width: 300, height: 200 }, FRAME_METADATA)
    ).toBeNull();
    expect(
      mapDomPointToViewport(
        -10,
        100,
        { left: 0, top: 0, width: 300, height: 200 },
        FRAME_METADATA,
        { clampOutsideContent: true }
      )
    ).toEqual({ x: 0, y: 50 });
  });

  test("forwards mapped click and wheel input for interactive sessions", () => {
    const view = renderViewport(createSession());
    const viewport = view.getByRole("region", { name: "Browser viewport" });

    Object.assign(viewport, {
      setPointerCapture: () => undefined,
      releasePointerCapture: () => undefined,
      hasPointerCapture: () => true,
    });
    Object.defineProperty(viewport, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        left: 0,
        top: 0,
        width: 300,
        height: 200,
        right: 300,
        bottom: 200,
        x: 0,
        y: 0,
        toJSON: () => undefined,
      }),
    });

    fireEvent.pointerDown(viewport, {
      pointerId: 7,
      button: 0,
      buttons: 1,
      clientX: 150,
      clientY: 100,
      detail: 1,
    });
    fireEvent.pointerUp(viewport, {
      pointerId: 7,
      button: 0,
      buttons: 0,
      clientX: 150,
      clientY: 100,
      detail: 1,
    });
    const wheelEvent = new globalThis.window.WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaX: 4,
      deltaY: 12,
      shiftKey: true,
    });
    Object.defineProperties(wheelEvent, {
      clientX: { configurable: true, value: 150 },
      clientY: { configurable: true, value: 100 },
    });
    fireEvent(viewport, wheelEvent);

    expect(sendInputMock).toHaveBeenCalledTimes(3);
    expect(sendInputMock).toHaveBeenNthCalledWith(1, {
      workspaceId: "workspace-1",
      input: {
        kind: "mouse",
        eventType: "mousePressed",
        x: 50,
        y: 50,
        button: "left",
        clickCount: 1,
        modifiers: 0,
      },
    });
    expect(sendInputMock).toHaveBeenNthCalledWith(2, {
      workspaceId: "workspace-1",
      input: {
        kind: "mouse",
        eventType: "mouseReleased",
        x: 50,
        y: 50,
        button: "left",
        clickCount: 1,
        modifiers: 0,
      },
    });
    expect(sendInputMock).toHaveBeenNthCalledWith(3, {
      workspaceId: "workspace-1",
      input: {
        kind: "mouse",
        eventType: "mouseWheel",
        x: 50,
        y: 50,
        deltaX: 4,
        deltaY: 12,
        modifiers: 0,
      },
    });
  });

  test("continues to emit char events for printable typing", () => {
    const view = renderViewport(createSession());
    const viewport = view.getByRole("region", { name: "Browser viewport" });

    fireEvent.focus(viewport);
    fireEvent.keyDown(viewport, { key: "a", code: "KeyA" });
    fireEvent.keyUp(viewport, { key: "a", code: "KeyA" });

    expect(sendInputMock).toHaveBeenCalledTimes(3);
    expect(sendInputMock).toHaveBeenNthCalledWith(1, {
      workspaceId: "workspace-1",
      input: {
        kind: "keyboard",
        eventType: "keyDown",
        key: "a",
        code: "KeyA",
        text: "a",
        modifiers: 0,
      },
    });
    expect(sendInputMock).toHaveBeenNthCalledWith(2, {
      workspaceId: "workspace-1",
      input: {
        kind: "keyboard",
        eventType: "char",
        key: "a",
        code: "KeyA",
        text: "a",
        modifiers: 0,
      },
    });
    expect(sendInputMock).toHaveBeenNthCalledWith(3, {
      workspaceId: "workspace-1",
      input: {
        kind: "keyboard",
        eventType: "keyUp",
        key: "a",
        code: "KeyA",
        text: "a",
        modifiers: 0,
      },
    });
  });

  test("does not attach text to unrelated modified shortcuts", () => {
    const view = renderViewport(createSession());
    const viewport = view.getByRole("region", { name: "Browser viewport" });

    fireEvent.focus(viewport);
    fireEvent.keyDown(viewport, { key: "v", code: "KeyV", ctrlKey: true });
    fireEvent.keyUp(viewport, { key: "v", code: "KeyV", ctrlKey: true });

    expect(sendInputMock).toHaveBeenCalledTimes(2);
    expect(sendInputMock).toHaveBeenNthCalledWith(1, {
      workspaceId: "workspace-1",
      input: {
        kind: "keyboard",
        eventType: "keyDown",
        key: "v",
        code: "KeyV",
        modifiers: 2,
      },
    });
    expect(sendInputMock).toHaveBeenNthCalledWith(2, {
      workspaceId: "workspace-1",
      input: {
        kind: "keyboard",
        eventType: "keyUp",
        key: "v",
        code: "KeyV",
        modifiers: 2,
      },
    });
  });

  test("forwards Enter and Ctrl+C while leaving Escape and Tab untouched", () => {
    const view = renderViewport(createSession());
    const viewport = view.getByRole("region", { name: "Browser viewport" });

    fireEvent.focus(viewport);
    fireEvent.keyDown(viewport, { key: "Enter", code: "Enter" });
    fireEvent.keyUp(viewport, { key: "Enter", code: "Enter" });
    fireEvent.keyDown(viewport, { key: "c", code: "KeyC", ctrlKey: true });
    fireEvent.keyUp(viewport, { key: "c", code: "KeyC", ctrlKey: true });
    fireEvent.keyDown(viewport, { key: "Escape", code: "Escape" });
    fireEvent.keyDown(viewport, { key: "Tab", code: "Tab" });

    expect(sendInputMock).toHaveBeenCalledTimes(4);
    expect(sendInputMock).toHaveBeenNthCalledWith(1, {
      workspaceId: "workspace-1",
      input: {
        kind: "keyboard",
        eventType: "keyDown",
        key: "Enter",
        code: "Enter",
        text: "\r",
        modifiers: 0,
      },
    });
    expect(sendInputMock).toHaveBeenNthCalledWith(2, {
      workspaceId: "workspace-1",
      input: {
        kind: "keyboard",
        eventType: "keyUp",
        key: "Enter",
        code: "Enter",
        text: "\r",
        modifiers: 0,
      },
    });
    expect(sendInputMock).toHaveBeenNthCalledWith(3, {
      workspaceId: "workspace-1",
      input: {
        kind: "keyboard",
        eventType: "keyDown",
        key: "c",
        code: "KeyC",
        text: "c",
        modifiers: 2,
      },
    });
    expect(sendInputMock).toHaveBeenNthCalledWith(4, {
      workspaceId: "workspace-1",
      input: {
        kind: "keyboard",
        eventType: "keyUp",
        key: "c",
        code: "KeyC",
        text: "c",
        modifiers: 2,
      },
    });
  });

  test("only marks the viewport as browser-focused while interaction is enabled", () => {
    const interactiveView = renderViewport(createSession());
    const interactiveViewport = interactiveView.getByRole("region", { name: "Browser viewport" });
    expect(interactiveViewport.getAttribute("data-browser-viewport")).toBe("true");
    interactiveView.unmount();

    const nonInteractiveView = renderViewport(
      createSession({
        streamState: "restart_required",
        lastFrameMetadata: null,
      })
    );
    const nonInteractiveViewport = nonInteractiveView.getByRole("region", {
      name: "Browser viewport",
    });
    expect(nonInteractiveViewport.hasAttribute("data-browser-viewport")).toBe(false);
  });

  test("shows restart-required stream overlay", () => {
    const restartMock = mock(() => undefined);
    const restartView = renderViewport(
      createSession({
        streamState: "restart_required",
        lastFrameMetadata: null,
      }),
      { onRestart: restartMock }
    );

    expect(restartView.getByText("Restart browser to enable live control")).toBeTruthy();
    fireEvent.click(restartView.getByRole("button", { name: "Restart" }));
    expect(restartMock).toHaveBeenCalledTimes(1);
  });

  test("shows restart controls before the first screenshot arrives", () => {
    const restartMock = mock(() => undefined);
    const view = renderViewport(
      createSession({
        streamState: "restart_required",
        lastScreenshotBase64: null,
        lastFrameMetadata: null,
      }),
      {
        onRestart: restartMock,
        screenshotSrc: null,
      }
    );

    expect(view.getByText("placeholder")).toBeTruthy();
    expect(view.getByText("Restart browser to enable live control")).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Restart" }));
    expect(restartMock).toHaveBeenCalledTimes(1);
  });

  test("renders a neutral closed notice over the last screenshot", () => {
    const view = renderViewport(
      createSession({
        status: "ended",
        streamState: null,
        endReason: "external_closed",
        lastFrameMetadata: null,
      }),
      { visibleInfoNotice: "Browser session was closed outside Mux" }
    );

    expect(view.getByRole("status").textContent).toContain(
      "Browser session was closed outside Mux"
    );
    expect(view.queryByRole("alert")).toBeNull();
  });

  test("renders destructive error banners separately from closed notices", () => {
    const view = renderViewport(
      createSession({
        status: "error",
        streamState: "error",
        streamErrorMessage: "socket closed",
        lastFrameMetadata: null,
      }),
      { visibleError: "socket closed" }
    );

    expect(view.getByRole("alert").textContent).toContain("socket closed");
    expect(view.queryByRole("status")).toBeNull();
  });

  test("shows stream-specific non-interactive messages while the stream is unavailable", () => {
    const connectingView = renderViewport(
      createSession({
        streamState: "connecting",
        lastFrameMetadata: null,
      })
    );
    expect(connectingView.getByText("Connecting to browser stream...")).toBeTruthy();
    connectingView.unmount();

    const errorView = renderViewport(
      createSession({
        streamState: "error",
        streamErrorMessage: "socket closed",
        lastFrameMetadata: null,
      })
    );
    expect(errorView.getByText("Stream error: socket closed")).toBeTruthy();
    errorView.unmount();

    const waitingView = renderViewport(
      createSession({
        streamState: "live",
        lastFrameMetadata: null,
      })
    );
    expect(waitingView.getByText("Waiting for first frame...")).toBeTruthy();
  });
});
