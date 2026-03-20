import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";
import type { BrowserSession } from "./browserBridgeTypes";
import { BrowserViewport, mapDomPointToViewport } from "./BrowserViewport";

const sendInputMock = mock();

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
    sessionName: "alpha",
    status: "live",
    frameBase64: "frame-data",
    lastError: null,
    streamState: "live",
    frameMetadata: { ...FRAME_METADATA },
    streamErrorMessage: null,
    ...overrides,
  };
}

function renderViewport(session: BrowserSession, overrides?: { screenshotSrc?: string | null }) {
  return render(
    <BrowserViewport
      workspaceId="workspace-1"
      session={session}
      screenshotSrc={overrides?.screenshotSrc ?? "data:image/jpeg;base64,frame-data"}
      visibleError={null}
      placeholder={<div>placeholder</div>}
      sendInput={sendInputMock}
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
    sendInputMock.mockReset();
  });

  afterEach(() => {
    cleanup();
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
      type: "input_mouse",
      eventType: "mousePressed",
      x: 50,
      y: 50,
      button: "left",
      clickCount: 1,
      modifiers: 0,
    });
    expect(sendInputMock).toHaveBeenNthCalledWith(2, {
      type: "input_mouse",
      eventType: "mouseReleased",
      x: 50,
      y: 50,
      button: "left",
      clickCount: 1,
      modifiers: 0,
    });
    expect(sendInputMock).toHaveBeenNthCalledWith(3, {
      type: "input_mouse",
      eventType: "mouseWheel",
      x: 50,
      y: 50,
      deltaX: 4,
      deltaY: 12,
      modifiers: 0,
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
      type: "input_keyboard",
      eventType: "keyDown",
      key: "a",
      code: "KeyA",
      text: "a",
      modifiers: 0,
    });
    expect(sendInputMock).toHaveBeenNthCalledWith(2, {
      type: "input_keyboard",
      eventType: "char",
      key: "a",
      code: "KeyA",
      text: "a",
      modifiers: 0,
    });
    expect(sendInputMock).toHaveBeenNthCalledWith(3, {
      type: "input_keyboard",
      eventType: "keyUp",
      key: "a",
      code: "KeyA",
      text: "a",
      modifiers: 0,
    });
  });
});
