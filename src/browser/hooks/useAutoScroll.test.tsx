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
});
