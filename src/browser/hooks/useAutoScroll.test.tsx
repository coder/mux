import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { MutableRefObject, UIEvent } from "react";
import { GlobalWindow } from "happy-dom";

import { useAutoScroll } from "./useAutoScroll";

function createScrollEvent(element: HTMLDivElement): UIEvent<HTMLDivElement> {
  return { currentTarget: element } as unknown as UIEvent<HTMLDivElement>;
}

function attachScrollMetrics(element: HTMLDivElement, initialScrollTop = 900) {
  let scrollTop = initialScrollTop;
  Object.defineProperty(element, "scrollTop", {
    configurable: true,
    get: () => scrollTop,
    set: (nextValue: number) => {
      scrollTop = nextValue;
    },
  });
  Object.defineProperty(element, "scrollHeight", {
    configurable: true,
    get: () => 1300,
  });
  Object.defineProperty(element, "clientHeight", {
    configurable: true,
    get: () => 400,
  });

  return {
    setScrollTop(nextValue: number) {
      scrollTop = nextValue;
    },
  };
}

describe("useAutoScroll", () => {
  let originalWindow: typeof globalThis.window;
  let originalDocument: typeof globalThis.document;

  beforeEach(() => {
    originalWindow = globalThis.window;
    originalDocument = globalThis.document;

    const domWindow = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.window = domWindow;
    globalThis.document = domWindow.document;
  });

  afterEach(() => {
    cleanup();
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
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
});
