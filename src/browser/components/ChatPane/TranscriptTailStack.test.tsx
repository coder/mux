import React from "react";
import { cleanup, render, waitFor } from "@testing-library/react";
import { installDom } from "../../../../tests/ui/dom";

import { TranscriptTailStack } from "./TranscriptTailStack";
import type { LayoutStackItem } from "./layoutStack";

let cleanupDom: (() => void) | null = null;
let originalResizeObserver: typeof ResizeObserver | undefined;
const resizeCallbacks = new Map<Element, ResizeObserverCallback[]>();

class ResizeObserverMock implements ResizeObserver {
  public readonly callback: ResizeObserverCallback;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
  }

  observe(target: Element) {
    resizeCallbacks.set(target, [...(resizeCallbacks.get(target) ?? []), this.callback]);
  }

  unobserve(target: Element) {
    const callbacks = (resizeCallbacks.get(target) ?? []).filter(
      (callback) => callback !== this.callback
    );
    if (callbacks.length === 0) {
      resizeCallbacks.delete(target);
      return;
    }
    resizeCallbacks.set(target, callbacks);
  }

  disconnect() {
    for (const [target, callbacks] of resizeCallbacks.entries()) {
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

function emitResize(target: Element, height: number) {
  const callbacks = resizeCallbacks.get(target) ?? [];
  const contentRect: DOMRectReadOnly = {
    x: 0,
    y: 0,
    width: 0,
    height,
    top: 0,
    right: 0,
    bottom: height,
    left: 0,
    toJSON: () => ({}),
  };
  const entry: ResizeObserverEntry = {
    target,
    contentRect,
    borderBoxSize: [],
    contentBoxSize: [],
    devicePixelContentBoxSize: [],
  };
  for (const callback of callbacks) {
    callback([entry], {} as ResizeObserver);
  }
}

function createTranscriptViewportRef(): React.RefObject<HTMLDivElement | null> {
  return { current: document.createElement("div") };
}

function defineScrollProperties(
  transcriptViewport: HTMLDivElement,
  options?: { scrollHeight?: number }
) {
  let scrollTop = 0;
  const scrollHeight = options?.scrollHeight ?? 320;

  Object.defineProperty(transcriptViewport, "scrollTop", {
    configurable: true,
    get: () => scrollTop,
    set: (value: number) => {
      scrollTop = value;
    },
  });
  Object.defineProperty(transcriptViewport, "scrollHeight", {
    configurable: true,
    get: () => scrollHeight,
  });

  return {
    getScrollTop: () => scrollTop,
    resetScrollTop() {
      scrollTop = 0;
    },
    getScrollHeight: () => scrollHeight,
  };
}

function getRenderedStack(container: HTMLElement): HTMLDivElement {
  const stack = container.querySelector('[data-component="stable-tail"]');
  expect(stack).toBeTruthy();
  if (stack?.tagName !== "DIV") {
    throw new Error("Expected tail stack to exist");
  }
  return stack as HTMLDivElement;
}

function getStackContent(container: HTMLElement): HTMLDivElement {
  const content = getRenderedStack(container).firstElementChild;
  expect(content).toBeTruthy();
  if (content?.tagName !== "DIV") {
    throw new Error("Expected tail content wrapper to exist");
  }
  return content as HTMLDivElement;
}

async function waitForResizeObservation(target: Element): Promise<void> {
  await waitFor(() => {
    const callbacks = resizeCallbacks.get(target);
    if (!callbacks || callbacks.length === 0) {
      throw new Error("Resize observer is not attached yet");
    }
  });
}

describe("TranscriptTailStack", () => {
  beforeEach(() => {
    cleanupDom = installDom();
    originalResizeObserver = globalThis.ResizeObserver;
    resizeCallbacks.clear();
    (globalThis as typeof globalThis & { ResizeObserver: typeof ResizeObserver }).ResizeObserver =
      ResizeObserverMock as unknown as typeof ResizeObserver;
  });

  afterEach(() => {
    cleanup();
    resizeCallbacks.clear();
    cleanupDom?.();
    cleanupDom = null;
    if (originalResizeObserver) {
      (
        globalThis as typeof globalThis & {
          ResizeObserver: typeof ResizeObserver;
        }
      ).ResizeObserver = originalResizeObserver;
    }
    originalResizeObserver = undefined;
  });

  it("holds the last measured tail height while switching to a hydrating workspace", async () => {
    const transcriptViewportRef = createTranscriptViewportRef();
    const view = render(
      <TranscriptTailStack
        workspaceId="workspace-a"
        isHydrating={false}
        autoScroll={false}
        transcriptViewportRef={transcriptViewportRef}
        dataComponent="stable-tail"
        items={[{ key: "workspace-a", node: <div>workspace A</div> }]}
      />
    );

    const content = getStackContent(view.container);
    await waitForResizeObservation(content);
    emitResize(content, 184);

    view.rerender(
      <TranscriptTailStack
        workspaceId="workspace-b"
        isHydrating={true}
        autoScroll={false}
        transcriptViewportRef={transcriptViewportRef}
        dataComponent="stable-tail"
        items={[]}
      />
    );

    await waitFor(() => {
      expect(getRenderedStack(view.container).style.minHeight).toBe("184px");
    });

    view.rerender(
      <TranscriptTailStack
        workspaceId="workspace-b"
        isHydrating={false}
        autoScroll={false}
        transcriptViewportRef={transcriptViewportRef}
        dataComponent="stable-tail"
        items={[{ key: "workspace-b", node: <div>workspace B</div> }]}
      />
    );

    await waitFor(() => {
      expect(getRenderedStack(view.container).style.minHeight).toBe("");
    });
  });

  it("pins the transcript when a mounted tail item changes from hidden to visible", () => {
    const transcriptViewportRef = createTranscriptViewportRef();
    const scrollState = defineScrollProperties(transcriptViewportRef.current!, {
      scrollHeight: 480,
    });
    const hiddenRetryItem: LayoutStackItem = {
      key: "retry-barrier",
      layoutKey: "retry-barrier:hidden",
      node: null,
    };
    const visibleRetryItem: LayoutStackItem = {
      key: "retry-barrier",
      layoutKey: "retry-barrier:visible",
      node: <div>Retry</div>,
    };

    const view = render(
      <TranscriptTailStack
        workspaceId="workspace-a"
        isHydrating={false}
        autoScroll={true}
        transcriptViewportRef={transcriptViewportRef}
        dataComponent="stable-tail"
        items={[hiddenRetryItem]}
      />
    );

    expect(scrollState.getScrollTop()).toBe(scrollState.getScrollHeight());
    scrollState.resetScrollTop();

    view.rerender(
      <TranscriptTailStack
        workspaceId="workspace-a"
        isHydrating={false}
        autoScroll={true}
        transcriptViewportRef={transcriptViewportRef}
        dataComponent="stable-tail"
        items={[visibleRetryItem]}
      />
    );

    expect(scrollState.getScrollTop()).toBe(scrollState.getScrollHeight());
  });

  it("pins the transcript when visible tail content changes height after mount", async () => {
    const transcriptViewportRef = createTranscriptViewportRef();
    const scrollState = defineScrollProperties(transcriptViewportRef.current!, {
      scrollHeight: 640,
    });
    const view = render(
      <TranscriptTailStack
        workspaceId="workspace-a"
        isHydrating={false}
        autoScroll={true}
        transcriptViewportRef={transcriptViewportRef}
        dataComponent="stable-tail"
        items={[{ key: "streaming-barrier", node: <div>Streaming</div> }]}
      />
    );

    const content = getStackContent(view.container);
    await waitForResizeObservation(content);
    emitResize(content, 40);

    scrollState.resetScrollTop();
    emitResize(content, 88);

    expect(scrollState.getScrollTop()).toBe(scrollState.getScrollHeight());
  });
});
