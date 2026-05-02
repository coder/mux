import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { KeyboardEvent, MouseEvent, MutableRefObject, UIEvent, WheelEvent } from "react";

import { installDom } from "../../../tests/ui/dom";
import { mockScrollMetrics as attachScrollMetrics } from "../../../tests/ui/scrollMetrics";
import { useAutoScroll } from "./useAutoScroll";

function createScrollEvent(element: HTMLDivElement): UIEvent<HTMLDivElement> {
  return { currentTarget: element } as unknown as UIEvent<HTMLDivElement>;
}

function createMouseEvent(
  element: HTMLDivElement,
  target: EventTarget = element,
  options: { buttons?: number } = {}
): MouseEvent<HTMLDivElement> {
  return {
    currentTarget: element,
    target,
    buttons: options.buttons ?? 0,
  } as unknown as MouseEvent<HTMLDivElement>;
}

function createWheelEvent(
  element: HTMLDivElement,
  options: { deltaX?: number; deltaY?: number } = {}
): WheelEvent<HTMLDivElement> {
  return {
    currentTarget: element,
    target: element,
    deltaX: options.deltaX ?? 0,
    deltaY: options.deltaY ?? 0,
  } as unknown as WheelEvent<HTMLDivElement>;
}

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
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
    scheduledFrames = [];
    nextFrameId = 1;

    // Install the deterministic scheduler on the per-test `window` rather than
    // `globalThis` so this mock never leaks into downstream test files. The
    // hook resolves rAF/cAF from `window` for exactly this reason.
    window.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      const id = nextFrameId++;
      scheduledFrames.push({ id, callback });
      return id;
    }) as typeof window.requestAnimationFrame;
    window.cancelAnimationFrame = ((id: number) => {
      scheduledFrames = scheduledFrames.filter((frame) => frame.id !== id);
    }) as typeof window.cancelAnimationFrame;
  });

  afterEach(() => {
    cleanup();
    scheduledFrames = [];
    cleanupDom?.();
    cleanupDom = null;
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

  test("small wheel-up tick releases the lock on the first event without snap-back", () => {
    // Regression: a slow wheel-up gesture from the very bottom (~3-7 px per
    // notch) used to keep the lock engaged because the user-intent branch
    // treated "still ≤ USER_BOTTOM_RELOCK_THRESHOLD_PX from bottom" as
    // "relock". The rAF settle tick then wrote scrollTop = max on the next
    // frame, snapping the user back to the bottom mid-gesture.
    const { result } = renderHook(() => useAutoScroll());
    const element = document.createElement("div");
    const metrics = attachScrollMetrics(element, {
      scrollHeight: 1000,
      clientHeight: 400,
      initialScrollTop: 600,
    });

    const dateNowSpy = spyOn(Date, "now");
    try {
      let now = 1_000_000;
      dateNowSpy.mockImplementation(() => now);

      act(() => {
        (result.current.contentRef as MutableRefObject<HTMLDivElement | null>).current = element;
      });
      expect(metrics.scrollTop).toBe(metrics.maxScrollTop);

      // Single small wheel notch: scrollTop drops 5 px, well within the 8 px
      // relock threshold. Lock must release on the first event.
      metrics.setScrollTop(metrics.maxScrollTop - 5);
      act(() => {
        result.current.markUserScrollIntent();
        now += 1;
        result.current.handleScroll(createScrollEvent(element));
      });
      expect(result.current.autoScroll).toBe(false);

      // Subsequent rAF ticks must not snap the user back to the bottom.
      act(() => {
        flushFrames(5);
      });
      expect(metrics.scrollTop).toBe(595);
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  test("continued slow wheel-up does not relock while still moving away from bottom", () => {
    // Even after the lock releases, geometry alone (≤ 8 px from bottom) must
    // not relock while the user is still scrolling upward in the same intent
    // window. Direction matters: the second tick lands at 6 px from bottom
    // but the user is moving away, so the lock must stay off.
    const { result } = renderHook(() => useAutoScroll());
    const element = document.createElement("div");
    const metrics = attachScrollMetrics(element, {
      scrollHeight: 1000,
      clientHeight: 400,
      initialScrollTop: 600,
    });

    const dateNowSpy = spyOn(Date, "now");
    try {
      let now = 1_000_000;
      dateNowSpy.mockImplementation(() => now);

      act(() => {
        (result.current.contentRef as MutableRefObject<HTMLDivElement | null>).current = element;
      });

      // First tick: 3 px up. Releases the lock.
      metrics.setScrollTop(metrics.maxScrollTop - 3);
      act(() => {
        result.current.markUserScrollIntent();
        now += 1;
        result.current.handleScroll(createScrollEvent(element));
      });
      expect(result.current.autoScroll).toBe(false);

      // Second tick: 3 px further up (still within 8 px of bottom, but moving
      // away). Lock must remain released.
      metrics.setScrollTop(metrics.maxScrollTop - 6);
      act(() => {
        result.current.markUserScrollIntent();
        now += 1;
        result.current.handleScroll(createScrollEvent(element));
      });
      expect(result.current.autoScroll).toBe(false);

      act(() => {
        flushFrames(5);
      });
      expect(metrics.scrollTop).toBe(594);
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  test("scrolling back toward bottom within user intent re-engages the lock", () => {
    // The release path must not regress the "scroll back to bottom and the
    // lock re-engages immediately" behavior. After the user scrolls up, a
    // direction reversal toward the bottom that lands within 8 px must relock
    // without waiting for the intent window to expire.
    const { result } = renderHook(() => useAutoScroll());
    const element = document.createElement("div");
    const metrics = attachScrollMetrics(element, {
      scrollHeight: 1000,
      clientHeight: 400,
      initialScrollTop: 600,
    });

    const dateNowSpy = spyOn(Date, "now");
    try {
      let now = 1_000_000;
      dateNowSpy.mockImplementation(() => now);

      act(() => {
        (result.current.contentRef as MutableRefObject<HTMLDivElement | null>).current = element;
      });

      // User scrolls up far enough to release.
      metrics.setScrollTop(400);
      act(() => {
        result.current.markUserScrollIntent();
        now += 1;
        result.current.handleScroll(createScrollEvent(element));
      });
      expect(result.current.autoScroll).toBe(false);

      // User reverses direction and scrolls back within 8 px of the bottom
      // while the intent window is still open.
      metrics.setScrollTop(metrics.maxScrollTop - 4);
      act(() => {
        result.current.markUserScrollIntent();
        now += 1;
        result.current.handleScroll(createScrollEvent(element));
      });
      expect(result.current.autoScroll).toBe(true);
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  test("disableAutoScroll seeds direction baseline so a later wheel-up does not relock", () => {
    // Regression: without seeding lastScrollTopRef inside disableAutoScroll,
    // the released-branch user-intent direction check compared the next
    // user-driven scroll event against a stale value (often 0 from cold-start
    // or the previous workspace's residue). A small wheel-up notch (~5 px)
    // landing within 8 px of the new bottom would then look like "moving
    // toward bottom" (e.g. 895 > 0) and spuriously relock the lock that the
    // explicit programmatic disable just turned off.
    const { result } = renderHook(() => useAutoScroll());
    const element = document.createElement("div");
    const metrics = attachScrollMetrics(element, {
      scrollHeight: 1000,
      clientHeight: 400,
      initialScrollTop: 600,
    });

    const dateNowSpy = spyOn(Date, "now");
    try {
      let now = 1_000_000;
      dateNowSpy.mockImplementation(() => now);

      act(() => {
        (result.current.contentRef as MutableRefObject<HTMLDivElement | null>).current = element;
      });
      // Pin lastScrollTopRef to 0 by skipping any prior handleScroll calls,
      // mimicking the pre-mount or workspace-switch cold-start path. Then
      // disableAutoScroll is invoked from a hypothetical "edit last user
      // message" or "navigate to message" flow.
      act(() => {
        result.current.disableAutoScroll();
      });
      expect(result.current.autoScroll).toBe(false);

      // User then bumps the trackpad: wheel handler primes intent (which
      // also clears programmaticDisableRef), and a small wheel-up notch
      // brings scrollTop to 595 — still within 8 px of the new bottom but
      // strictly moving away from it.
      metrics.setScrollTop(metrics.maxScrollTop - 5);
      act(() => {
        result.current.markUserScrollIntent();
        now += 1;
        result.current.handleScroll(createScrollEvent(element));
      });
      // The released branch must read previousScrollTop = 600 (the seeded
      // value), see currentScrollTop = 595, and conclude the user is moving
      // away from bottom — no relock.
      expect(result.current.autoScroll).toBe(false);
      expect(metrics.scrollTop).toBe(595);
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  test("delta-0 wheel events do not open a user-intent window", () => {
    // Modifier-key wheel (Cmd-wheel zoom on macOS), Shift-wheel for horizontal
    // scroll, and Bluetooth-mouse jitter all dispatch wheel events with
    // deltaY === 0 (and often deltaX === 0). These must not clear
    // programmaticDisableRef or refresh the 750 ms intent window — otherwise
    // any layout drift that follows takes the wrong branch in handleScroll.
    const { result } = renderHook(() => useAutoScroll());
    const element = document.createElement("div");
    const metrics = attachScrollMetrics(element, {
      scrollHeight: 1000,
      clientHeight: 400,
    });

    act(() => {
      (result.current.contentRef as MutableRefObject<HTMLDivElement | null>).current = element;
      // Phantom wheel: zero deltas. Must be a no-op for the intent window.
      result.current.handleScrollContainerWheel(createWheelEvent(element, { deltaY: 0 }));
    });

    // Now produce a layout drift. With no intent window open, handleScroll
    // takes the no-intent locked branch and snaps back to bottom — proving
    // the wheel did not open an intent window (otherwise we'd see the
    // user-intent locked branch release the lock instead).
    metrics.setScrollTop(metrics.maxScrollTop - 5);
    act(() => {
      result.current.handleScroll(createScrollEvent(element));
    });

    expect(metrics.scrollTop).toBe(metrics.maxScrollTop);
    expect(result.current.autoScroll).toBe(true);
  });

  test("non-zero wheel events do open a user-intent window", () => {
    // Sanity-check that the wheel filter doesn't over-block. A real wheel
    // event with deltaY != 0 must still mark intent and let the next scroll
    // event release the lock.
    const { result } = renderHook(() => useAutoScroll());
    const element = document.createElement("div");
    const metrics = attachScrollMetrics(element, {
      scrollHeight: 1000,
      clientHeight: 400,
    });

    const dateNowSpy = spyOn(Date, "now");
    try {
      let now = 1_000_000;
      dateNowSpy.mockImplementation(() => now);

      act(() => {
        (result.current.contentRef as MutableRefObject<HTMLDivElement | null>).current = element;
        result.current.handleScrollContainerWheel(createWheelEvent(element, { deltaY: -100 }));
      });

      metrics.setScrollTop(metrics.maxScrollTop - 5);
      act(() => {
        now += 1;
        result.current.handleScroll(createScrollEvent(element));
      });

      expect(result.current.autoScroll).toBe(false);
      expect(metrics.scrollTop).toBe(metrics.maxScrollTop - 5);
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

  test("interactive content mousedown does not release the lock", () => {
    const { result } = renderHook(() => useAutoScroll());
    const element = document.createElement("div");
    const child = document.createElement("div");
    child.dataset.scrollIntent = "ignore";
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

  test("non-interactive content click does not release the lock without drag", () => {
    const { result } = renderHook(() => useAutoScroll());
    const element = document.createElement("div");
    const child = document.createElement("span");
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
        result.current.handleScrollContainerMouseDown(createMouseEvent(element, child));
      });

      metrics.setScrollTop(500);
      act(() => {
        now += 1;
        result.current.handleScroll(createScrollEvent(element));
      });

      expect(metrics.scrollTop).toBe(metrics.maxScrollTop);
      expect(result.current.autoScroll).toBe(true);
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  test("non-interactive content drag preserves selection autoscroll intent", () => {
    const { result } = renderHook(() => useAutoScroll());
    const element = document.createElement("div");
    const child = document.createElement("span");
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
        result.current.handleScrollContainerMouseDown(createMouseEvent(element, child));
        result.current.handleScrollContainerMouseMove(
          createMouseEvent(element, child, { buttons: 1 })
        );
      });

      metrics.setScrollTop(500);
      act(() => {
        now += 1;
        result.current.handleScroll(createScrollEvent(element));
      });

      expect(metrics.scrollTop).toBe(500);
      expect(result.current.autoScroll).toBe(false);
    } finally {
      dateNowSpy.mockRestore();
    }
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

  test("scroll keys inside editable transcript controls do not mark intent", () => {
    const { result } = renderHook(() => useAutoScroll());
    const element = document.createElement("div");
    const textarea = document.createElement("textarea");
    element.append(textarea);
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
        result.current.handleScrollContainerKeyDown({
          target: textarea,
          currentTarget: element,
          key: "PageUp",
        } as unknown as KeyboardEvent<HTMLDivElement>);
      });

      metrics.setScrollTop(500);
      act(() => {
        now += 1;
        result.current.handleScroll(createScrollEvent(element));
      });

      expect(metrics.scrollTop).toBe(metrics.maxScrollTop);
      expect(result.current.autoScroll).toBe(true);
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

  test("rAF settle loop stops after the idle frame budget", () => {
    const { result } = renderHook(() => useAutoScroll());
    const element = document.createElement("div");
    attachScrollMetrics(element, {
      scrollHeight: 1000,
      clientHeight: 400,
    });

    act(() => {
      (result.current.contentRef as MutableRefObject<HTMLDivElement | null>).current = element;
    });

    expect(scheduledFrames.length).toBeGreaterThan(0);

    act(() => {
      flushFrames(100);
    });

    expect(result.current.autoScroll).toBe(true);
    expect(scheduledFrames.length).toBe(0);
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
