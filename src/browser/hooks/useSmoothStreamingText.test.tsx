import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";
import {
  useSmoothStreamingText,
  type UseSmoothStreamingTextOptions,
} from "./useSmoothStreamingText";

const FRAME_MS = 16;

describe("useSmoothStreamingText", () => {
  let originalRequestAnimationFrame: typeof globalThis.requestAnimationFrame;
  let originalCancelAnimationFrame: typeof globalThis.cancelAnimationFrame;
  let rafHandleCounter = 0;
  let currentTimeMs = 0;
  const rafCallbacks = new Map<number, FrameRequestCallback>();

  beforeEach(() => {
    const domWindow = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.window = domWindow;
    globalThis.document = domWindow.document;

    originalRequestAnimationFrame = globalThis.requestAnimationFrame;
    originalCancelAnimationFrame = globalThis.cancelAnimationFrame;

    vi.useFakeTimers();

    rafHandleCounter = 0;
    currentTimeMs = 0;
    rafCallbacks.clear();

    const requestAnimationFrameMock: typeof requestAnimationFrame = (callback) => {
      rafHandleCounter += 1;
      rafCallbacks.set(rafHandleCounter, callback);
      return rafHandleCounter;
    };

    const cancelAnimationFrameMock: typeof cancelAnimationFrame = (handle) => {
      rafCallbacks.delete(handle);
    };

    globalThis.requestAnimationFrame = requestAnimationFrameMock;
    globalThis.cancelAnimationFrame = cancelAnimationFrameMock;
    globalThis.window.requestAnimationFrame = requestAnimationFrameMock;
    globalThis.window.cancelAnimationFrame = cancelAnimationFrameMock;
  });

  afterEach(() => {
    cleanup();

    rafCallbacks.clear();

    vi.useRealTimers();

    globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    globalThis.cancelAnimationFrame = originalCancelAnimationFrame;

    if (globalThis.window) {
      globalThis.window.requestAnimationFrame = originalRequestAnimationFrame;
      globalThis.window.cancelAnimationFrame = originalCancelAnimationFrame;
    }

    globalThis.window = undefined as unknown as Window & typeof globalThis;
    globalThis.document = undefined as unknown as Document;
  });

  function advanceFrames(frameCount: number): void {
    act(() => {
      for (let i = 0; i < frameCount; i++) {
        currentTimeMs += FRAME_MS;

        const callbacks = Array.from(rafCallbacks.values());
        rafCallbacks.clear();

        for (const callback of callbacks) {
          callback(currentTimeMs);
        }
      }
    });
  }

  it("returns full text when not streaming", () => {
    const { result } = renderHook(() =>
      useSmoothStreamingText({
        fullText: "hello",
        isStreaming: false,
        bypassSmoothing: false,
        streamKey: "1",
      })
    );

    expect(result.current.visibleText).toBe("hello");
    expect(result.current.isCaughtUp).toBe(true);
  });

  it("returns full text when bypass smoothing is enabled", () => {
    const fullText = "hello from smooth streaming";

    const { result } = renderHook(() =>
      useSmoothStreamingText({
        fullText,
        isStreaming: true,
        bypassSmoothing: true,
        streamKey: "1",
      })
    );

    expect(result.current.visibleText).toBe(fullText);
    expect(result.current.isCaughtUp).toBe(true);
  });

  it("reveals text progressively while streaming", () => {
    const initialProps: UseSmoothStreamingTextOptions = {
      fullText: "x".repeat(220),
      isStreaming: true,
      bypassSmoothing: false,
      streamKey: "stream-1",
    };

    const { result } = renderHook((hookProps: UseSmoothStreamingTextOptions) =>
      useSmoothStreamingText(hookProps), {
      initialProps,
    });

    const initialLength = result.current.visibleText.length;
    expect(initialLength).toBeLessThan(initialProps.fullText.length);

    advanceFrames(8);

    const progressedLength = result.current.visibleText.length;
    expect(progressedLength).toBeGreaterThan(initialLength);
    expect(progressedLength).toBeLessThan(initialProps.fullText.length);
  });

  it("flushes immediately when streaming completes", () => {
    const fullText = "y".repeat(180);

    const { result, rerender } = renderHook((hookProps: UseSmoothStreamingTextOptions) =>
      useSmoothStreamingText(hookProps), {
      initialProps: {
        fullText,
        isStreaming: true,
        bypassSmoothing: false,
        streamKey: "stream-1",
      },
    });

    advanceFrames(10);
    expect(result.current.visibleText.length).toBeLessThan(fullText.length);

    act(() => {
      rerender({
        fullText,
        isStreaming: false,
        bypassSmoothing: false,
        streamKey: "stream-1",
      });
    });

    expect(result.current.visibleText).toBe(fullText);
    expect(result.current.isCaughtUp).toBe(true);
  });

  it("resets reveal progress when stream key changes", () => {
    const firstStreamText = "a".repeat(200);
    const secondStreamText = "b".repeat(140);

    const { result, rerender } = renderHook((hookProps: UseSmoothStreamingTextOptions) =>
      useSmoothStreamingText(hookProps), {
      initialProps: {
        fullText: firstStreamText,
        isStreaming: true,
        bypassSmoothing: false,
        streamKey: "stream-1",
      },
    });

    advanceFrames(12);

    const firstStreamProgress = result.current.visibleText.length;
    expect(firstStreamProgress).toBeGreaterThan(0);

    act(() => {
      rerender({
        fullText: secondStreamText,
        isStreaming: true,
        bypassSmoothing: false,
        streamKey: "stream-2",
      });
    });

    const resetLength = result.current.visibleText.length;
    expect(resetLength).toBeLessThan(firstStreamProgress);
    expect(resetLength).toBeLessThan(secondStreamText.length);

    advanceFrames(6);

    expect(result.current.visibleText.length).toBeGreaterThan(resetLength);
  });
});
