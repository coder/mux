import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import { RefreshController } from "./RefreshController";

describe("RefreshController", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("rate-limits multiple schedule() calls (doesn't reset timer)", () => {
    const onRefresh = jest.fn<() => void>();
    const controller = new RefreshController({ onRefresh, debounceMs: 100 });

    controller.schedule();
    jest.advanceTimersByTime(50);
    controller.schedule(); // Shouldn't reset timer
    jest.advanceTimersByTime(50);

    // Should fire at 100ms from first call, not 150ms
    expect(onRefresh).toHaveBeenCalledTimes(1);

    controller.dispose();
  });

  it("coalesces calls during rate-limit window", () => {
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

  it("requestImmediate() bypasses rate-limit timer", () => {
    const onRefresh = jest.fn<() => void>();
    const controller = new RefreshController({ onRefresh, debounceMs: 100 });

    controller.schedule();
    expect(onRefresh).not.toHaveBeenCalled();

    controller.requestImmediate();
    expect(onRefresh).toHaveBeenCalledTimes(1);

    // Original timer should be cleared
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

  it("schedule() during in-flight queues refresh for after completion", async () => {
    let resolveRefresh: () => void;
    const onRefresh = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveRefresh = resolve;
        })
    );

    const controller = new RefreshController({ onRefresh, debounceMs: 100 });

    // Start first refresh
    controller.requestImmediate();
    expect(onRefresh).toHaveBeenCalledTimes(1);

    // schedule() while in-flight should queue, not start timer
    controller.schedule();

    // Complete the first refresh and let .finally() run
    resolveRefresh!();
    await Promise.resolve();
    await Promise.resolve(); // Extra tick for .finally()

    // Should trigger follow-up refresh, but never more frequently than the minimum interval.
    // First tick runs the post-flight setTimeout(0), then we wait out the min interval.
    jest.advanceTimersByTime(0);
    jest.advanceTimersByTime(500);
    expect(onRefresh).toHaveBeenCalledTimes(2);

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

  it("requestImmediate() bypasses isPaused check (for manual refresh)", () => {
    const onRefresh = jest.fn<() => void>();
    const paused = true;
    const controller = new RefreshController({
      onRefresh,
      debounceMs: 100,
      isPaused: () => paused,
    });

    // schedule() should be blocked by isPaused
    controller.schedule();
    jest.advanceTimersByTime(100);
    expect(onRefresh).not.toHaveBeenCalled();

    // requestImmediate() should bypass isPaused (manual refresh)
    controller.requestImmediate();
    expect(onRefresh).toHaveBeenCalledTimes(1);

    controller.dispose();
  });

  it("schedule() respects isPaused and flushes on notifyUnpaused", () => {
    const onRefresh = jest.fn<() => void>();
    let paused = true;
    const controller = new RefreshController({
      onRefresh,
      debounceMs: 100,
      isPaused: () => paused,
    });

    // schedule() should queue but not execute while paused
    controller.schedule();
    jest.advanceTimersByTime(100);
    expect(onRefresh).not.toHaveBeenCalled();

    // Unpausing should flush the pending refresh
    paused = false;
    controller.notifyUnpaused();
    expect(onRefresh).toHaveBeenCalledTimes(1);

    controller.dispose();
  });

  it("lastRefreshInfo tracks trigger and timestamp", () => {
    const onRefresh = jest.fn<() => void>();
    const controller = new RefreshController({ onRefresh, debounceMs: 100 });

    expect(controller.lastRefreshInfo).toBeNull();

    // Manual refresh should record "manual" trigger
    const beforeManual = Date.now();
    controller.requestImmediate();
    expect(controller.lastRefreshInfo).not.toBeNull();
    expect(controller.lastRefreshInfo!.trigger).toBe("manual");
    expect(controller.lastRefreshInfo!.timestamp).toBeGreaterThanOrEqual(beforeManual);

    // Scheduled refresh should record "scheduled" trigger
    controller.schedule();
    jest.advanceTimersByTime(500);
    expect(controller.lastRefreshInfo!.trigger).toBe("scheduled");

    // Priority refresh should record "priority" trigger
    controller.schedulePriority();
    jest.advanceTimersByTime(500);
    expect(controller.lastRefreshInfo!.trigger).toBe("priority");

    controller.dispose();
  });

  it("onRefreshComplete callback is called with refresh info", () => {
    const onRefresh = jest.fn<() => void>();
    const onRefreshComplete = jest.fn<(info: { trigger: string; timestamp: number }) => void>();
    const controller = new RefreshController({
      onRefresh,
      onRefreshComplete,
      debounceMs: 100,
    });

    expect(onRefreshComplete).not.toHaveBeenCalled();

    controller.requestImmediate();
    expect(onRefreshComplete).toHaveBeenCalledTimes(1);
    expect(onRefreshComplete).toHaveBeenCalledWith(
      expect.objectContaining({ trigger: "manual", timestamp: expect.any(Number) })
    );

    controller.schedule();
    jest.advanceTimersByTime(500);
    expect(onRefreshComplete).toHaveBeenCalledTimes(2);
    expect(onRefreshComplete).toHaveBeenLastCalledWith(
      expect.objectContaining({ trigger: "scheduled" })
    );

    controller.dispose();
  });
});
