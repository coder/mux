import { describe, it, expect, mock } from "bun:test";

import { RefreshController, type LastRefreshInfo } from "./RefreshController";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// NOTE: Bun's Jest-compat layer does not currently expose timer controls like
// jest.advanceTimersByTime(), so these tests use real timers.

describe("RefreshController", () => {
  it("rate-limits multiple schedule() calls (doesn't reset timer)", async () => {
    const onRefresh = mock<() => void>(() => undefined);
    const controller = new RefreshController({ onRefresh, debounceMs: 20 });

    controller.schedule();
    await sleep(10);
    controller.schedule(); // Shouldn't reset timer

    await sleep(40);

    // Should fire ~20ms after first call, not ~30ms after second.
    expect(onRefresh).toHaveBeenCalledTimes(1);

    controller.dispose();
  });

  it("coalesces calls during rate-limit window", async () => {
    const onRefresh = mock<() => void>(() => undefined);
    const controller = new RefreshController({ onRefresh, debounceMs: 20 });

    controller.schedule();
    controller.schedule();
    controller.schedule();

    expect(onRefresh).not.toHaveBeenCalled();

    await sleep(60);

    expect(onRefresh).toHaveBeenCalledTimes(1);

    controller.dispose();
  });

  it("requestImmediate() bypasses rate-limit timer", async () => {
    const onRefresh = mock<() => void>(() => undefined);
    const controller = new RefreshController({ onRefresh, debounceMs: 50 });

    controller.schedule();
    expect(onRefresh).not.toHaveBeenCalled();

    controller.requestImmediate();
    expect(onRefresh).toHaveBeenCalledTimes(1);

    // Original timer should be cleared
    await sleep(80);
    expect(onRefresh).toHaveBeenCalledTimes(1);

    controller.dispose();
  });

  it("guards against concurrent sync refreshes (in-flight queuing)", () => {
    // Track if refresh is currently in-flight
    let inFlight = false;
    const onRefresh = mock(() => {
      expect(inFlight).toBe(false); // Should never be called while already in-flight
      inFlight = true;
      inFlight = false;
    });

    const controller = new RefreshController({ onRefresh, debounceMs: 20 });

    controller.requestImmediate();
    expect(onRefresh).toHaveBeenCalledTimes(1);

    controller.dispose();
  });

  it("schedule() during in-flight queues refresh for after completion", async () => {
    let resolveRefresh: () => void;
    const onRefresh = mock(
      () =>
        new Promise<void>((resolve) => {
          resolveRefresh = resolve;
        })
    );

    const controller = new RefreshController({ onRefresh, debounceMs: 20 });

    controller.requestImmediate();
    expect(onRefresh).toHaveBeenCalledTimes(1);

    // schedule() while in-flight should queue for after completion.
    controller.schedule();

    resolveRefresh!();
    await Promise.resolve();

    // Follow-up refresh is subject to MIN_REFRESH_INTERVAL_MS (500ms).
    await sleep(650);

    expect(onRefresh).toHaveBeenCalledTimes(2);

    controller.dispose();
  });

  it("isRefreshing reflects in-flight state", async () => {
    let resolveRefresh: () => void;
    const refreshPromise = new Promise<void>((resolve) => {
      resolveRefresh = resolve;
    });

    const onRefresh = mock(() => refreshPromise);
    const controller = new RefreshController({ onRefresh, debounceMs: 20 });

    expect(controller.isRefreshing).toBe(false);

    controller.requestImmediate();
    expect(controller.isRefreshing).toBe(true);

    resolveRefresh!();
    await Promise.resolve();

    expect(controller.isRefreshing).toBe(false);

    controller.dispose();
  });

  it("dispose() cleans up debounce timer", async () => {
    const onRefresh = mock<() => void>(() => undefined);
    const controller = new RefreshController({ onRefresh, debounceMs: 20 });

    controller.schedule();
    controller.dispose();

    await sleep(80);

    expect(onRefresh).not.toHaveBeenCalled();
  });

  it("does not refresh after dispose", async () => {
    const onRefresh = mock<() => void>(() => undefined);
    const controller = new RefreshController({ onRefresh, debounceMs: 20 });

    controller.dispose();
    controller.schedule();
    controller.requestImmediate();

    await sleep(80);

    expect(onRefresh).not.toHaveBeenCalled();
  });

  it("requestImmediate() bypasses isPaused check (for manual refresh)", async () => {
    const onRefresh = mock<() => void>(() => undefined);
    const paused = true;
    const controller = new RefreshController({
      onRefresh,
      debounceMs: 20,
      isPaused: () => paused,
    });

    controller.schedule();
    await sleep(80);
    expect(onRefresh).not.toHaveBeenCalled();

    controller.requestImmediate();
    expect(onRefresh).toHaveBeenCalledTimes(1);

    controller.dispose();
  });

  it("schedule() respects isPaused and flushes on notifyUnpaused", async () => {
    const onRefresh = mock<() => void>(() => undefined);
    let paused = true;
    const controller = new RefreshController({
      onRefresh,
      debounceMs: 20,
      isPaused: () => paused,
    });

    controller.schedule();
    await sleep(80);
    expect(onRefresh).not.toHaveBeenCalled();

    paused = false;
    controller.notifyUnpaused();

    expect(onRefresh).toHaveBeenCalledTimes(1);

    controller.dispose();
  });

  it("lastRefreshInfo tracks trigger and timestamp", async () => {
    const onRefresh = mock<() => void>(() => undefined);
    const controller = new RefreshController({
      onRefresh,
      debounceMs: 20,
      priorityDebounceMs: 20,
    });

    expect(controller.lastRefreshInfo).toBeNull();

    const beforeManual = Date.now();
    controller.requestImmediate();

    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(controller.lastRefreshInfo).not.toBeNull();
    expect(controller.lastRefreshInfo!.trigger).toBe("manual");
    expect(controller.lastRefreshInfo!.timestamp).toBeGreaterThanOrEqual(beforeManual);

    controller.schedule();
    await sleep(650);
    expect(onRefresh).toHaveBeenCalledTimes(2);
    expect(controller.lastRefreshInfo!.trigger).toBe("scheduled");

    controller.schedulePriority();
    await sleep(650);
    expect(onRefresh).toHaveBeenCalledTimes(3);
    expect(controller.lastRefreshInfo!.trigger).toBe("priority");

    controller.dispose();
  });

  it("onRefreshComplete callback is called with refresh info", async () => {
    const onRefresh = mock<() => void>(() => undefined);
    const onRefreshComplete = mock<(info: LastRefreshInfo) => void>(() => undefined);
    const controller = new RefreshController({
      onRefresh,
      onRefreshComplete,
      debounceMs: 20,
    });

    expect(onRefreshComplete).not.toHaveBeenCalled();

    controller.requestImmediate();
    expect(onRefreshComplete).toHaveBeenCalledTimes(1);
    expect(onRefreshComplete).toHaveBeenCalledWith(
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      expect.objectContaining({ trigger: "manual", timestamp: expect.any(Number) })
    );

    controller.schedule();
    await sleep(650);
    expect(onRefreshComplete).toHaveBeenCalledTimes(2);
    expect(onRefreshComplete).toHaveBeenLastCalledWith(
      expect.objectContaining({ trigger: "scheduled" })
    );

    controller.dispose();
  });
});
