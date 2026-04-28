import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { MutableRefObject, UIEvent } from "react";
import { GlobalWindow } from "happy-dom";

import { useAutoScroll } from "./useAutoScroll";

function createScrollEvent(element: HTMLDivElement): UIEvent<HTMLDivElement> {
  return { currentTarget: element } as unknown as UIEvent<HTMLDivElement>;
}

function attachScrollMetrics(
  element: HTMLDivElement,
  options: { initialScrollTop?: number; scrollHeight?: number; clientHeight?: number } = {}
) {
  let scrollTop = options.initialScrollTop ?? 900;
  let scrollHeight = options.scrollHeight ?? 1300;
  let clientHeight = options.clientHeight ?? 400;
  Object.defineProperty(element, "scrollTop", {
    configurable: true,
    get: () => scrollTop,
    set: (nextValue: number) => {
      scrollTop = nextValue;
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
    get scrollTop() {
      return scrollTop;
    },
    setScrollTop(nextValue: number) {
      scrollTop = nextValue;
    },
    setScrollHeight(nextValue: number) {
      scrollHeight = nextValue;
    },
    setClientHeight(nextValue: number) {
      clientHeight = nextValue;
    },
  };
}

let originalResizeObserver: typeof ResizeObserver | undefined;
const resizeCallbacks = new Map<Element, ResizeObserverCallback[]>();

class ResizeObserverMock implements ResizeObserver {
  public readonly callback: ResizeObserverCallback;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
  }

  observe(target: Element): void {
    const callbacks = resizeCallbacks.get(target) ?? [];
    callbacks.push(this.callback);
    resizeCallbacks.set(target, callbacks);
  }

  unobserve(target: Element): void {
    const callbacks = resizeCallbacks.get(target);
    if (!callbacks) return;
    resizeCallbacks.set(
      target,
      callbacks.filter((callback) => callback !== this.callback)
    );
  }

  disconnect(): void {
    for (const [target, callbacks] of resizeCallbacks.entries()) {
      const remaining = callbacks.filter((callback) => callback !== this.callback);
      if (remaining.length === 0) {
        resizeCallbacks.delete(target);
      } else {
        resizeCallbacks.set(target, remaining);
      }
    }
  }

  takeRecords(): ResizeObserverEntry[] {
    return [];
  }
}

function emitResize(target: Element): void {
  const entry: ResizeObserverEntry = {
    target,
    contentRect: target.getBoundingClientRect(),
    borderBoxSize: [],
    contentBoxSize: [],
    devicePixelContentBoxSize: [],
  };
  for (const callback of resizeCallbacks.get(target) ?? []) {
    callback([entry], {} as ResizeObserver);
  }
}

function installAnimationFrameMock() {
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
  const callbacks = new Map<number, FrameRequestCallback>();
  let nextFrameId = 1;

  globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    const frameId = nextFrameId;
    nextFrameId += 1;
    callbacks.set(frameId, callback);
    return frameId;
  }) as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = ((frameId: number) => {
    callbacks.delete(frameId);
  }) as typeof cancelAnimationFrame;

  return {
    flushNextFrame() {
      const next = callbacks.entries().next();
      if (next.done) return;
      const [frameId, callback] = next.value;
      callbacks.delete(frameId);
      callback(16);
    },
    flushAllFrames() {
      for (let i = 0; i < 10 && callbacks.size > 0; i++) {
        this.flushNextFrame();
      }
    },
    restore() {
      callbacks.clear();
      const globalWithFrames = globalThis as {
        requestAnimationFrame?: typeof requestAnimationFrame;
        cancelAnimationFrame?: typeof cancelAnimationFrame;
      };
      if (originalRequestAnimationFrame === undefined) {
        delete globalWithFrames.requestAnimationFrame;
      } else {
        globalThis.requestAnimationFrame = originalRequestAnimationFrame;
      }
      if (originalCancelAnimationFrame === undefined) {
        delete globalWithFrames.cancelAnimationFrame;
      } else {
        globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
      }
    },
  };
}

describe("useAutoScroll", () => {
  let originalWindow: typeof globalThis.window;
  let originalDocument: typeof globalThis.document;

  beforeEach(() => {
    originalWindow = globalThis.window;
    originalDocument = globalThis.document;
    originalResizeObserver = globalThis.ResizeObserver;
    resizeCallbacks.clear();

    const domWindow = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.window = domWindow;
    globalThis.document = domWindow.document;
    globalThis.ResizeObserver = ResizeObserverMock as unknown as typeof ResizeObserver;
  });

  afterEach(() => {
    cleanup();
    resizeCallbacks.clear();
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
    if (originalResizeObserver === undefined) {
      delete (globalThis as Partial<typeof globalThis>).ResizeObserver;
    } else {
      globalThis.ResizeObserver = originalResizeObserver;
    }
    originalResizeObserver = undefined;
  });

  test("ignores upward scrolls without recent user interaction", () => {
    const { result } = renderHook(() => useAutoScroll());
    const element = document.createElement("div");
    const scrollMetrics = attachScrollMetrics(element);

    act(() => {
      (result.current.contentRef as MutableRefObject<HTMLDivElement | null>).current = element;
      result.current.handleScroll(createScrollEvent(element));
    });

    scrollMetrics.setScrollTop(600);
    act(() => {
      result.current.handleScroll(createScrollEvent(element));
    });

    expect(result.current.autoScroll).toBe(true);
  });

  test("disables auto-scroll after a recent user-owned upward scroll", () => {
    const { result } = renderHook(() => useAutoScroll());
    const element = document.createElement("div");
    const scrollMetrics = attachScrollMetrics(element);

    act(() => {
      (result.current.contentRef as MutableRefObject<HTMLDivElement | null>).current = element;
      result.current.handleScroll(createScrollEvent(element));
    });

    const dateNowSpy = spyOn(Date, "now");
    try {
      let now = 1_000_000;
      dateNowSpy.mockImplementation(() => now);
      scrollMetrics.setScrollTop(600);

      act(() => {
        result.current.markUserInteraction();
        now += 1;
        result.current.handleScroll(createScrollEvent(element));
      });
    } finally {
      dateNowSpy.mockRestore();
    }

    expect(result.current.autoScroll).toBe(false);
  });

  test("pins inner content resizes synchronously while auto-scroll is enabled", () => {
    const { result } = renderHook(() => useAutoScroll());
    const scrollContainer = document.createElement("div");
    const inner = document.createElement("div");
    const scrollMetrics = attachScrollMetrics(scrollContainer, {
      initialScrollTop: 900,
      scrollHeight: 1300,
      clientHeight: 400,
    });

    act(() => {
      (result.current.contentRef as MutableRefObject<HTMLDivElement | null>).current =
        scrollContainer;
      result.current.innerRef(inner);
    });

    scrollMetrics.setScrollHeight(1500);
    act(() => {
      emitResize(inner);
    });

    expect(scrollMetrics.scrollTop).toBe(1500);
  });

  test("does not pin inner content resizes after auto-scroll is disabled", () => {
    const { result } = renderHook(() => useAutoScroll());
    const scrollContainer = document.createElement("div");
    const inner = document.createElement("div");
    const scrollMetrics = attachScrollMetrics(scrollContainer, {
      initialScrollTop: 900,
      scrollHeight: 1300,
      clientHeight: 400,
    });

    act(() => {
      (result.current.contentRef as MutableRefObject<HTMLDivElement | null>).current =
        scrollContainer;
      result.current.innerRef(inner);
      result.current.disableAutoScroll();
    });

    scrollMetrics.setScrollHeight(1500);
    act(() => {
      emitResize(inner);
    });

    expect(scrollMetrics.scrollTop).toBe(900);
  });

  test("ref-guarded stick callback only pins while auto-scroll owns the transcript", () => {
    const animationFrames = installAnimationFrameMock();
    const { result } = renderHook(() => useAutoScroll());
    const scrollContainer = document.createElement("div");
    const scrollMetrics = attachScrollMetrics(scrollContainer, {
      initialScrollTop: 900,
      scrollHeight: 1300,
      clientHeight: 400,
    });

    try {
      act(() => {
        (result.current.contentRef as MutableRefObject<HTMLDivElement | null>).current =
          scrollContainer;
        result.current.disableAutoScroll();
      });

      scrollMetrics.setScrollHeight(1500);
      act(() => {
        result.current.stickToBottomIfAutoScroll();
      });
      expect(scrollMetrics.scrollTop).toBe(900);

      act(() => {
        result.current.jumpToBottom();
      });
      scrollMetrics.setScrollHeight(1800);
      act(() => {
        result.current.stickToBottomIfAutoScroll();
      });
      expect(scrollMetrics.scrollTop).toBe(1800);
    } finally {
      animationFrames.restore();
    }
  });

  test("jumpToBottom keeps ownership through late chat-open layout", () => {
    const animationFrames = installAnimationFrameMock();
    const { result } = renderHook(() => useAutoScroll());
    const scrollContainer = document.createElement("div");
    const scrollMetrics = attachScrollMetrics(scrollContainer, {
      initialScrollTop: 100,
      scrollHeight: 900,
      clientHeight: 400,
    });

    try {
      act(() => {
        (result.current.contentRef as MutableRefObject<HTMLDivElement | null>).current =
          scrollContainer;
        result.current.jumpToBottom();
      });

      expect(scrollMetrics.scrollTop).toBe(900);

      // Opening a chat can commit before the transcript reaches its final measured
      // height. The explicit jump owns a short follow-up window so late hydration
      // layout still lands at the tail without restoring the old per-delta RAF loop.
      scrollMetrics.setScrollHeight(1500);
      act(() => {
        animationFrames.flushNextFrame();
      });
      expect(scrollMetrics.scrollTop).toBe(1500);

      scrollMetrics.setScrollHeight(1800);
      act(() => {
        animationFrames.flushNextFrame();
      });
      expect(scrollMetrics.scrollTop).toBe(1800);
    } finally {
      animationFrames.restore();
    }
  });

  test("disableAutoScroll cancels pending jump follow-up pins", () => {
    const animationFrames = installAnimationFrameMock();
    const { result } = renderHook(() => useAutoScroll());
    const scrollContainer = document.createElement("div");
    const scrollMetrics = attachScrollMetrics(scrollContainer, {
      initialScrollTop: 100,
      scrollHeight: 900,
      clientHeight: 400,
    });

    try {
      act(() => {
        (result.current.contentRef as MutableRefObject<HTMLDivElement | null>).current =
          scrollContainer;
        result.current.jumpToBottom();
        result.current.disableAutoScroll();
      });

      scrollMetrics.setScrollHeight(1500);
      act(() => {
        animationFrames.flushAllFrames();
      });

      expect(scrollMetrics.scrollTop).toBe(900);
      expect(result.current.autoScroll).toBe(false);
    } finally {
      animationFrames.restore();
    }
  });

  test("jumpToBottom ignores stale user-scroll telemetry from the previous transcript", () => {
    const animationFrames = installAnimationFrameMock();
    const { result } = renderHook(() => useAutoScroll());
    const scrollContainer = document.createElement("div");
    const scrollMetrics = attachScrollMetrics(scrollContainer, {
      initialScrollTop: 1000,
      scrollHeight: 1600,
      clientHeight: 400,
    });
    const dateNowSpy = spyOn(Date, "now");

    try {
      dateNowSpy.mockImplementation(() => 1_000_000);
      act(() => {
        (result.current.contentRef as MutableRefObject<HTMLDivElement | null>).current =
          scrollContainer;
        result.current.handleScroll(createScrollEvent(scrollContainer));
        result.current.markUserInteraction();
        result.current.jumpToBottom();
      });

      // Browser anchoring/layout can emit a programmatic scroll event after the jump.
      // It must not inherit the previous transcript's recent user interaction and
      // disable auto-scroll before hydration follow-up pins run.
      scrollMetrics.setScrollTop(700);
      act(() => {
        result.current.handleScroll(createScrollEvent(scrollContainer));
      });

      expect(result.current.autoScroll).toBe(true);
    } finally {
      dateNowSpy.mockRestore();
      animationFrames.restore();
    }
  });
});
