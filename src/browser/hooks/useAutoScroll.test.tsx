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

  test("corrects non-user scroll drift while bottom lock is enabled", () => {
    const { result } = renderHook(() => useAutoScroll());
    const element = document.createElement("div");
    const scrollMetrics = attachScrollMetrics(element);

    act(() => {
      (result.current.contentRef as MutableRefObject<HTMLDivElement | null>).current = element;
    });

    scrollMetrics.setScrollTop(600);
    act(() => {
      result.current.handleScroll(createScrollEvent(element));
    });

    expect(scrollMetrics.scrollTop).toBe(scrollMetrics.maxScrollTop);
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

    expect(scrollMetrics.scrollTop).toBe(scrollMetrics.maxScrollTop);
  });

  test("does not pin non-user scroll or layout drift after auto-scroll is disabled", () => {
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

    scrollMetrics.setScrollTop(600);
    act(() => {
      result.current.handleScroll(createScrollEvent(scrollContainer));
    });
    expect(scrollMetrics.scrollTop).toBe(600);

    scrollMetrics.setScrollHeight(1500);
    act(() => {
      emitResize(inner);
    });

    expect(scrollMetrics.scrollTop).toBe(600);
  });

  test("jumpToBottom pins the committed chat and observed layout owns later height", () => {
    const { result } = renderHook(() => useAutoScroll());
    const scrollContainer = document.createElement("div");
    const inner = document.createElement("div");
    const scrollMetrics = attachScrollMetrics(scrollContainer, {
      initialScrollTop: 100,
      scrollHeight: 900,
      clientHeight: 400,
    });

    act(() => {
      (result.current.contentRef as MutableRefObject<HTMLDivElement | null>).current =
        scrollContainer;
      result.current.innerRef(inner);
      result.current.jumpToBottom();
    });

    expect(scrollMetrics.scrollTop).toBe(scrollMetrics.maxScrollTop);

    // Chat-open hydration should be proven by the bottom-lock invariant: if the
    // committed transcript grows while the lock is held, ResizeObserver pins to
    // the new maximum scroll position without a timer/RAF patch.
    scrollMetrics.setScrollHeight(1500);
    act(() => {
      emitResize(inner);
    });
    expect(scrollMetrics.scrollTop).toBe(scrollMetrics.maxScrollTop);
  });

  test("user-owned scroll releases and reacquires the bottom lock by geometry", () => {
    const { result } = renderHook(() => useAutoScroll());
    const scrollContainer = document.createElement("div");
    const inner = document.createElement("div");
    const scrollMetrics = attachScrollMetrics(scrollContainer, {
      initialScrollTop: 900,
      scrollHeight: 1300,
      clientHeight: 400,
    });
    const dateNowSpy = spyOn(Date, "now");

    try {
      let now = 1_000_000;
      dateNowSpy.mockImplementation(() => now);

      act(() => {
        (result.current.contentRef as MutableRefObject<HTMLDivElement | null>).current =
          scrollContainer;
        result.current.innerRef(inner);
      });

      scrollMetrics.setScrollTop(600);
      act(() => {
        result.current.markUserInteraction();
        now += 1;
        result.current.handleScroll(createScrollEvent(scrollContainer));
      });
      expect(result.current.autoScroll).toBe(false);

      scrollMetrics.setScrollTop(scrollMetrics.maxScrollTop - 4);
      act(() => {
        result.current.markUserInteraction();
        now += 1;
        result.current.handleScroll(createScrollEvent(scrollContainer));
      });
      expect(scrollMetrics.scrollTop).toBe(scrollMetrics.maxScrollTop - 4);
      expect(result.current.autoScroll).toBe(true);

      scrollMetrics.setScrollHeight(1500);
      act(() => {
        emitResize(inner);
      });
      expect(scrollMetrics.scrollTop).toBe(scrollMetrics.maxScrollTop);
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  test("disableAutoScroll keeps later observed layout user-owned", () => {
    const { result } = renderHook(() => useAutoScroll());
    const scrollContainer = document.createElement("div");
    const inner = document.createElement("div");
    const scrollMetrics = attachScrollMetrics(scrollContainer, {
      initialScrollTop: 100,
      scrollHeight: 900,
      clientHeight: 400,
    });

    act(() => {
      (result.current.contentRef as MutableRefObject<HTMLDivElement | null>).current =
        scrollContainer;
      result.current.innerRef(inner);
      result.current.jumpToBottom();
      result.current.disableAutoScroll();
    });

    scrollMetrics.setScrollHeight(1500);
    act(() => {
      emitResize(inner);
    });

    expect(scrollMetrics.scrollTop).toBe(500);
    expect(result.current.autoScroll).toBe(false);
  });

  test("jumpToBottom ignores stale user-scroll telemetry from the previous transcript", () => {
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
      // disable auto-scroll before observed layout can pin.
      scrollMetrics.setScrollTop(700);
      act(() => {
        result.current.handleScroll(createScrollEvent(scrollContainer));
      });

      expect(result.current.autoScroll).toBe(true);
    } finally {
      dateNowSpy.mockRestore();
    }
  });
});
