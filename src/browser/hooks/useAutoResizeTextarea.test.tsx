import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";
import type { RefObject } from "react";
import { useAutoResizeTextarea } from "./useAutoResizeTextarea";

function createFakeTextarea(initialScrollHeight: number): {
  ref: RefObject<HTMLTextAreaElement>;
  assignments: string[];
  setScrollHeight: (value: number) => void;
} {
  let height = "";
  let scrollHeight = initialScrollHeight;
  const assignments: string[] = [];
  const style = {
    get height() {
      return height;
    },
    set height(value: string) {
      height = value;
      assignments.push(value);
    },
  };

  const textarea = {
    style,
    get scrollHeight() {
      return scrollHeight;
    },
  } as unknown as HTMLTextAreaElement;

  return {
    ref: { current: textarea },
    assignments,
    setScrollHeight: (value) => {
      scrollHeight = value;
    },
  };
}

describe("useAutoResizeTextarea", () => {
  beforeEach(() => {
    const domWindow = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.window = domWindow;
    globalThis.document = domWindow.document;
    Object.defineProperty(globalThis.window, "innerHeight", {
      configurable: true,
      value: 1000,
    });
  });

  afterEach(() => {
    cleanup();
    globalThis.window = undefined as unknown as Window & typeof globalThis;
    globalThis.document = undefined as unknown as Document;
  });

  it("does not reset height to auto for pure typing that does not change composer height", () => {
    const textarea = createFakeTextarea(40);
    const { rerender } = renderHook(({ value }) => useAutoResizeTextarea(textarea.ref, value, 50), {
      initialProps: { value: "" },
    });

    expect(textarea.assignments).toEqual(["auto", "40px"]);
    textarea.assignments.length = 0;

    // This is the hot path for typing in a large chat: keep the existing height when
    // scrollHeight is unchanged so the transcript flex sibling does not get re-laid out.
    rerender({ value: "a" });

    expect(textarea.assignments).toEqual([]);
  });

  it("grows on insertion without the shrink-to-auto reset, but still shrinks on deletion", () => {
    const textarea = createFakeTextarea(40);
    const { rerender } = renderHook(({ value }) => useAutoResizeTextarea(textarea.ref, value, 50), {
      initialProps: { value: "" },
    });
    textarea.assignments.length = 0;

    textarea.setScrollHeight(64);
    rerender({ value: "line one\nline two" });

    expect(textarea.assignments).toEqual(["64px"]);
    textarea.assignments.length = 0;

    textarea.setScrollHeight(40);
    rerender({ value: "line one" });

    expect(textarea.assignments).toEqual(["auto", "40px"]);
  });

  it("shrinks when a longer replacement does not preserve the previous text", () => {
    const textarea = createFakeTextarea(84);
    const { rerender } = renderHook(({ value }) => useAutoResizeTextarea(textarea.ref, value, 50), {
      initialProps: { value: "line one\nline two\nline three" },
    });
    textarea.assignments.length = 0;

    textarea.setScrollHeight(40);
    rerender({ value: "one visually shorter replacement" });

    expect(textarea.assignments).toEqual(["auto", "40px"]);
  });
});
