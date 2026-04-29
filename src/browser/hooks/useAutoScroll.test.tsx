import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { KeyboardEvent, MouseEvent, MutableRefObject, UIEvent } from "react";
import { GlobalWindow } from "happy-dom";

import { useAutoScroll } from "./useAutoScroll";

function createScrollEvent(element: HTMLDivElement): UIEvent<HTMLDivElement> {
  return { currentTarget: element } as unknown as UIEvent<HTMLDivElement>;
}

function createMouseEvent(
  element: HTMLDivElement,
  target: EventTarget = element
): MouseEvent<HTMLDivElement> {
  return { currentTarget: element, target } as unknown as MouseEvent<HTMLDivElement>;
}

function attachScrollMetrics(
  element: HTMLDivElement,
  options: { initialScrollTop?: number; scrollHeight?: number; clientHeight?: number } = {}
) {
  let scrollHeight = options.scrollHeight ?? 1300;
  let clientHeight = options.clientHeight ?? 400;
  const maxScrollTop = () => Math.max(0, scrollHeight - clientHeight);
  const clampScrollTop = (nextValue: number) => Math.min(maxScrollTop(), Math.max(0, nextValue));
  let scrollTop = clampScrollTop(options.initialScrollTop ?? 900);

  Object.defineProperty(element, "scrollTop", {
    configurable: true,
    get: () => scrollTop,
    set: (nextValue: number) => {
      scrollTop = clampScrollTop(nextValue);
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
    get maxScrollTop() {
      return maxScrollTop();
    },
    get scrollTop() {
      return scrollTop;
    },
    setScrollTop(nextValue: number) {
      scrollTop = clampScrollTop(nextValue);
    },
    setScrollHeight(nextValue: number) {
      scrollHeight = nextValue;
      scrollTop = clampScrollTop(scrollTop);
    },
    setClientHeight(nextValue: number) {
      clientHeight = nextValue;
      scrollTop = clampScrollTop(scrollTop);
    },
  };
}

let originalRequestAnimationFrame: typeof globalThis.requestAnimationFrame | undefined;
let originalCancelAnimationFrame: typeof globalThis.cancelAnimationFrame | undefined;
let scheduledFrames: Array<{ id: number; callback: FrameRequestCallback }> = [];
let nextFrameId = 1;

function flushOneFrame(): void {
  const next = scheduledFrames.shift();
  if (!next) return;
  next.callback(performance.now());
}

function flushFrames(count: number): void {
  for (let index = 0; index < count; index += 1) {
    flushOneFrame();
  }
}

describe("useAutoScroll", () => {
  let originalWindow: typeof globalThis.window;
  let originalDocument: typeof globalThis.document;

  beforeEach(() => {
    originalWindow = globalThis.window;
    originalDocument = globalThis.document;
    originalRequestAnimationFrame = globalThis.requestAnimationFrame;
    originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
    scheduledFrames = [];
    nextFrameId = 1;

    const domWindow = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.window = domWindow;
    globalThis.document = domWindow.document;

    globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      const id = nextFrameId++;
      scheduledFrames.push({ id, callback });
      return id;
    }) as typeof globalThis.requestAnimationFrame;
    globalThis.cancelAnimationFrame = ((id: number) => {
      scheduledFrames = scheduledFrames.filter((frame) => frame.id !== id);
    }) as typeof globalThis.cancelAnimationFrame;
  });

  afterEach(() => {
    cleanup();
    scheduledFrames = [];
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
    // Always restore the rAF/cancel pair, including the case where the original
    // was `undefined` (bun test environments don't always provide these globals
    // before our mock runs). Skipping restoration leaks the deterministic mock
    // into unrelated test files that expect real animation-frame timing.
    if (originalRequestAnimationFrame === undefined) {
      delete (globalThis as Partial<typeof globalThis>).requestAnimationFrame;
    } else {
      globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    }
    if (originalCancelAnimationFrame === undefined) {
      delete (globalThis as Partial<typeof globalThis>).cancelAnimationFrame;
    } else {
      globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
    }
  });

  test("rAF tick pins to bottom whenever layout grows under bottom lock", () => {
    const { result } = renderHook(() => useAutoScroll());
    const element = document.createElement("div");
    const metrics = attachScrollMetrics(element, {
      scrollHeight: 1000,
      clientHeight: 400,
      initialScrollTop: 600,
    });

    act(() => {
      (result.current.contentRef as MutableRefObject<HTMLDivElement | null>).current = element;
    });

    expect(metrics.scrollTop).toBe(metrics.maxScrollTop);

    metrics.setScrollHeight(1500);
    // Browser would normally emit a paint frame; the rAF tick pins before paint.
    act(() => {
      flushOneFrame();
    });

    expect(metrics.scrollTop).toBe(metrics.maxScrollTop);
  });

  test("rAF tick is a no-op when auto-scroll is off", () => {
    const { result } = renderHook(() => useAutoScroll());
    const element = document.createElement("div");
    const metrics = attachScrollMetrics(element, {
      scrollHeight: 1000,
      clientHeight: 400,
      initialScrollTop: 200,
    });

    act(() => {
      (result.current.contentRef as MutableRefObject<HTMLDivElement | null>).current = element;
      result.current.disableAutoScroll();
    });

    metrics.setScrollHeight(1500);
    act(() => {
      flushFrames(3);
    });

    expect(metrics.scrollTop).toBe(200);
    expect(result.current.autoScroll).toBe(false);
  });

  test("rAF tick continues pinning across multiple frames during a CSS transition", () => {
    const { result } = renderHook(() => useAutoScroll());
    const element = document.createElement("div");
    const metrics = attachScrollMetrics(element, {
      scrollHeight: 1000,
      clientHeight: 400,
    });

    act(() => {
      (result.current.contentRef as MutableRefObject<HTMLDivElement | null>).current = element;
    });

    for (const next of [1100, 1180, 1240, 1300]) {
      metrics.setScrollHeight(next);
      act(() => {
        flushOneFrame();
      });
      expect(metrics.scrollTop).toBe(metrics.maxScrollTop);
    }
  });

  test("user-owned scroll up disables the lock and survives subsequent rAF ticks", () => {
    const { result } = renderHook(() => useAutoScroll());
    const element = document.createElement("div");
    const metrics = attachScrollMetrics(element, {
      scrollHeight: 1300,
      clientHeight: 400,
      initialScrollTop: 900,
    });

    const dateNowSpy = spyOn(Date, "now");
    try {
      let now = 1_000_000;
      dateNowSpy.mockImplementation(() => now);
      act(() => {
        (result.current.contentRef as MutableRefObject<HTMLDivElement | null>).current = element;
      });

      metrics.setScrollTop(600);
      act(() => {
        result.current.markUserScrollIntent();
        now += 1;
        result.current.handleScroll(createScrollEvent(element));
      });
      expect(result.current.autoScroll).toBe(false);

      act(() => {
        flushFrames(5);
      });
      expect(metrics.scrollTop).toBe(600);
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  test("returning to bottom geometry re-acquires the lock and rAF resumes pinning", () => {
    const { result } = renderHook(() => useAutoScroll());
    const element = document.createElement("div");
    const metrics = attachScrollMetrics(element, {
      scrollHeight: 1300,
      clientHeight: 400,
      initialScrollTop: 900,
    });

    const dateNowSpy = spyOn(Date, "now");
    try {
      let now = 1_000_000;
      dateNowSpy.mockImplementation(() => now);

      act(() => {
        (result.current.contentRef as MutableRefObject<HTMLDivElement | null>).current = element;
      });

      // User scrolls up: lock releases.
      metrics.setScrollTop(500);
      act(() => {
        result.current.markUserScrollIntent();
        now += 1;
        result.current.handleScroll(createScrollEvent(element));
      });
      expect(result.current.autoScroll).toBe(false);

      // User scrolls back to within 8px of bottom; intent expires.
      now += 1_000;
      metrics.setScrollTop(metrics.maxScrollTop - 4);
      act(() => {
        result.current.handleScroll(createScrollEvent(element));
      });
      expect(result.current.autoScroll).toBe(true);

      // New layout growth lands; rAF tick pins it.
      metrics.setScrollHeight(1500);
      act(() => {
        flushOneFrame();
      });
      expect(metrics.scrollTop).toBe(metrics.maxScrollTop);
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  test("content-targeted mousedown does not release the lock", () => {
    const { result } = renderHook(() => useAutoScroll());
    const element = document.createElement("div");
    const child = document.createElement("button");
    element.append(child);
    const metrics = attachScrollMetrics(element, {
      scrollHeight: 1000,
      clientHeight: 400,
    });

    act(() => {
      (result.current.contentRef as MutableRefObject<HTMLDivElement | null>).current = element;
      result.current.handleScrollContainerMouseDown(createMouseEvent(element, child));
    });

    metrics.setScrollHeight(1500);
    act(() => {
      flushOneFrame();
    });

    expect(metrics.scrollTop).toBe(metrics.maxScrollTop);
    expect(result.current.autoScroll).toBe(true);
  });

  test("scroll keys mark intent even when focus is on a transcript descendant", () => {
    const { result } = renderHook(() => useAutoScroll());
    const element = document.createElement("div");
    const child = document.createElement("button");
    element.append(child);
    const metrics = attachScrollMetrics(element, {
      scrollHeight: 1300,
      clientHeight: 400,
      initialScrollTop: 900,
    });

    const dateNowSpy = spyOn(Date, "now");
    try {
      let now = 1_000_000;
      dateNowSpy.mockImplementation(() => now);

      act(() => {
        (result.current.contentRef as MutableRefObject<HTMLDivElement | null>).current = element;
      });

      // PageUp pressed while focus is on a transcript-internal button. Browsers
      // still scroll the scrollport in that case, so the lock must release.
      act(() => {
        result.current.handleScrollContainerKeyDown({
          target: child,
          currentTarget: element,
          key: "PageUp",
        } as unknown as KeyboardEvent<HTMLDivElement>);
        now += 1;
        metrics.setScrollTop(500);
        result.current.handleScroll(createScrollEvent(element));
      });

      expect(result.current.autoScroll).toBe(false);
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  test("non-scroll keys do not affect lock state", () => {
    const { result } = renderHook(() => useAutoScroll());
    const element = document.createElement("div");
    const metrics = attachScrollMetrics(element, {
      scrollHeight: 1300,
      clientHeight: 400,
    });

    act(() => {
      (result.current.contentRef as MutableRefObject<HTMLDivElement | null>).current = element;
      result.current.handleScrollContainerKeyDown({
        target: element,
        currentTarget: element,
        key: "Tab",
      } as unknown as KeyboardEvent<HTMLDivElement>);
    });

    metrics.setScrollHeight(1600);
    act(() => {
      flushOneFrame();
    });
    expect(metrics.scrollTop).toBe(metrics.maxScrollTop);
    expect(result.current.autoScroll).toBe(true);
  });

  test("scrollport mousedown marks scroll intent (scrollbar drag)", () => {
    const { result } = renderHook(() => useAutoScroll());
    const element = document.createElement("div");
    const metrics = attachScrollMetrics(element, {
      scrollHeight: 1000,
      clientHeight: 400,
    });

    act(() => {
      (result.current.contentRef as MutableRefObject<HTMLDivElement | null>).current = element;
      result.current.handleScrollContainerMouseDown(createMouseEvent(element));
    });

    metrics.setScrollTop(500);
    act(() => {
      result.current.handleScroll(createScrollEvent(element));
    });

    expect(metrics.scrollTop).toBe(500);
    expect(result.current.autoScroll).toBe(false);
  });

  test("handleScroll corrects non-user drift while the lock is held", () => {
    const { result } = renderHook(() => useAutoScroll());
    const element = document.createElement("div");
    const metrics = attachScrollMetrics(element, {
      scrollHeight: 1000,
      clientHeight: 400,
    });

    act(() => {
      (result.current.contentRef as MutableRefObject<HTMLDivElement | null>).current = element;
    });

    // Browser anchoring or programmatic scroll moves us off-bottom without user
    // intent. The next scroll event should return us to the bottom synchronously.
    metrics.setScrollTop(300);
    act(() => {
      result.current.handleScroll(createScrollEvent(element));
    });

    expect(metrics.scrollTop).toBe(metrics.maxScrollTop);
    expect(result.current.autoScroll).toBe(true);
  });

  test("jumpToBottom re-arms the lock and ignores stale user telemetry", () => {
    const { result } = renderHook(() => useAutoScroll());
    const element = document.createElement("div");
    const metrics = attachScrollMetrics(element, {
      scrollHeight: 1600,
      clientHeight: 400,
      initialScrollTop: 1000,
    });

    const dateNowSpy = spyOn(Date, "now");
    try {
      dateNowSpy.mockImplementation(() => 1_000_000);

      act(() => {
        (result.current.contentRef as MutableRefObject<HTMLDivElement | null>).current = element;
        result.current.markUserScrollIntent();
        result.current.jumpToBottom();
      });

      expect(metrics.scrollTop).toBe(metrics.maxScrollTop);
      expect(result.current.autoScroll).toBe(true);

      // Even if the browser emits a synthetic scroll event right after the jump
      // (e.g. composer resize), the stale intent must not relock the user state.
      metrics.setScrollTop(800);
      act(() => {
        result.current.handleScroll(createScrollEvent(element));
      });
      expect(metrics.scrollTop).toBe(metrics.maxScrollTop);
      expect(result.current.autoScroll).toBe(true);
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  test("disableAutoScroll keeps later layout user-owned across rAF ticks", () => {
    const { result } = renderHook(() => useAutoScroll());
    const element = document.createElement("div");
    const metrics = attachScrollMetrics(element, {
      scrollHeight: 900,
      clientHeight: 400,
      initialScrollTop: 100,
    });

    act(() => {
      (result.current.contentRef as MutableRefObject<HTMLDivElement | null>).current = element;
      result.current.jumpToBottom();
      result.current.disableAutoScroll();
    });

    metrics.setScrollHeight(1500);
    act(() => {
      flushFrames(4);
    });

    expect(metrics.scrollTop).toBe(500);
    expect(result.current.autoScroll).toBe(false);
  });

  test("programmatic disable stays unlocked even when geometry is at bottom", () => {
    const { result } = renderHook(() => useAutoScroll());
    const element = document.createElement("div");
    const metrics = attachScrollMetrics(element, {
      scrollHeight: 1300,
      clientHeight: 400,
      initialScrollTop: 900,
    });

    act(() => {
      (result.current.contentRef as MutableRefObject<HTMLDivElement | null>).current = element;
      result.current.disableAutoScroll();
    });

    metrics.setScrollTop(metrics.maxScrollTop);
    act(() => {
      result.current.handleScroll(createScrollEvent(element));
    });

    expect(result.current.autoScroll).toBe(false);
  });

  test("rAF loop only runs while bottom-lock is held", () => {
    const { result } = renderHook(() => useAutoScroll());
    const element = document.createElement("div");
    const metrics = attachScrollMetrics(element, {
      scrollHeight: 1000,
      clientHeight: 400,
    });

    act(() => {
      (result.current.contentRef as MutableRefObject<HTMLDivElement | null>).current = element;
    });

    // Initial render: autoScroll = true, the loop is scheduling.
    expect(scheduledFrames.length).toBeGreaterThan(0);

    // User scrolls up — disable lock. The loop must stop entirely so manual
    // reading sessions don't pay a per-frame cost.
    act(() => {
      result.current.disableAutoScroll();
    });
    while (scheduledFrames.length > 0) {
      flushOneFrame();
    }
    expect(scheduledFrames.length).toBe(0);

    metrics.setScrollHeight(1500);
    metrics.setScrollTop(0);
    act(() => {
      flushFrames(3);
    });
    expect(metrics.scrollTop).toBe(0);

    // Reacquiring the lock (e.g., jumpToBottom) restarts the loop.
    act(() => {
      result.current.jumpToBottom();
    });
    expect(scheduledFrames.length).toBeGreaterThan(0);
  });

  test("rAF loop is torn down on unmount and stops scheduling new frames", () => {
    const { result, unmount } = renderHook(() => useAutoScroll());
    const element = document.createElement("div");
    const metrics = attachScrollMetrics(element, {
      scrollHeight: 1000,
      clientHeight: 400,
    });

    act(() => {
      (result.current.contentRef as MutableRefObject<HTMLDivElement | null>).current = element;
    });

    expect(scheduledFrames.length).toBeGreaterThan(0);

    unmount();

    // After unmount the loop should not schedule any further frames.
    metrics.setScrollHeight(1500);
    metrics.setScrollTop(0);

    while (scheduledFrames.length > 0) {
      flushOneFrame();
    }

    // No infinite re-scheduling happened.
    expect(scheduledFrames.length).toBe(0);
    // And the unmounted loop did not write to scrollTop after disposal.
    expect(metrics.scrollTop).toBe(0);
  });
});
