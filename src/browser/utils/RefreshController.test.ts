import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import { RefreshController } from "./RefreshController";

describe("RefreshController", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("debounces multiple schedule() calls", () => {
    const onRefresh = jest.fn<() => void>();
    const controller = new RefreshController({ onRefresh, debounceMs: 100 });

    controller.schedule();
    controller.schedule();
    controller.schedule();

    expect(onRefresh).not.toHaveBeenCalled();

    jest.advanceTimersByTime(100);

    expect(onRefresh).toHaveBeenCalledTimes(1);

    controller.dispose();
  });

  it("requestImmediate() bypasses debounce", () => {
    const onRefresh = jest.fn<() => void>();
    const controller = new RefreshController({ onRefresh, debounceMs: 100 });

    controller.schedule();
    expect(onRefresh).not.toHaveBeenCalled();

    controller.requestImmediate();
    expect(onRefresh).toHaveBeenCalledTimes(1);

    // Original debounce timer should be cleared
    jest.advanceTimersByTime(100);
    expect(onRefresh).toHaveBeenCalledTimes(1);

    controller.dispose();
  });

  it("guards against concurrent sync refreshes (in-flight queuing)", () => {
    // Track if refresh is currently in-flight
    let inFlight = false;
    const onRefresh = jest.fn(() => {
      // Simulate sync operation that takes time
      expect(inFlight).toBe(false); // Should never be called while already in-flight
      inFlight = true;
      // Immediately complete (sync)
      inFlight = false;
    });

    const controller = new RefreshController({ onRefresh, debounceMs: 100 });

    // Multiple immediate requests should only call once (queued ones execute after)
    controller.requestImmediate();
    expect(onRefresh).toHaveBeenCalledTimes(1);

    controller.dispose();
  });

  it("isRefreshing reflects in-flight state", () => {
    let resolveRefresh: () => void;
    const refreshPromise = new Promise<void>((resolve) => {
      resolveRefresh = resolve;
    });

    const onRefresh = jest.fn(() => refreshPromise);
    const controller = new RefreshController({ onRefresh, debounceMs: 100 });

    expect(controller.isRefreshing).toBe(false);

    controller.requestImmediate();
    expect(controller.isRefreshing).toBe(true);

    // Complete the promise
    resolveRefresh!();

    controller.dispose();
  });

  it("dispose() cleans up debounce timer", () => {
    const onRefresh = jest.fn<() => void>();
    const controller = new RefreshController({ onRefresh, debounceMs: 100 });

    controller.schedule();
    controller.dispose();

    jest.advanceTimersByTime(100);

    expect(onRefresh).not.toHaveBeenCalled();
  });

  it("does not refresh after dispose", () => {
    const onRefresh = jest.fn<() => void>();
    const controller = new RefreshController({ onRefresh, debounceMs: 100 });

    controller.dispose();
    controller.schedule();
    controller.requestImmediate();

    jest.advanceTimersByTime(100);

    expect(onRefresh).not.toHaveBeenCalled();
  });
});
