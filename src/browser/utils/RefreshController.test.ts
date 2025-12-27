import { describe, it, expect, mock } from "bun:test";

import { RefreshController } from "./RefreshController";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;

  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

// NOTE: Bun's Jest-compat layer does not currently expose timer controls like
// jest.advanceTimersByTime(), so these tests use real timers.

describe("RefreshController", () => {
  it("schedule() rate-limits and does not reset to the last call", async () => {
    const onRefresh = mock<() => void>(() => undefined);
    const controller = new RefreshController({ onRefresh, debounceMs: 200 });

    controller.schedule();
    await sleep(100);
    controller.schedule();

    // After 230ms total: >200ms since the first call, but only 130ms since the second call.
    // If schedule() reset the timer, we would not have refreshed yet.
    await sleep(130);
    expect(onRefresh).toHaveBeenCalledTimes(1);

    // Ensure the second call didn't schedule another refresh.
    await sleep(250);
    expect(onRefresh).toHaveBeenCalledTimes(1);

    controller.dispose();
  });

  it("schedule() coalesces many calls into a single refresh", async () => {
    const onRefresh = mock<() => void>(() => undefined);
    const controller = new RefreshController({ onRefresh, debounceMs: 20 });

    controller.schedule();
    controller.schedule();
    controller.schedule();

    expect(onRefresh).not.toHaveBeenCalled();

    await sleep(80);

    expect(onRefresh).toHaveBeenCalledTimes(1);

    controller.dispose();
  });

  it("requestImmediate() triggers immediately and clears a pending debounce", async () => {
    const onRefresh = mock<() => void>(() => undefined);
    const controller = new RefreshController({ onRefresh, debounceMs: 60 });

    controller.schedule();
    expect(onRefresh).not.toHaveBeenCalled();

    controller.requestImmediate();
    expect(onRefresh).toHaveBeenCalledTimes(1);

    // Original timer should be cleared.
    await sleep(120);
    expect(onRefresh).toHaveBeenCalledTimes(1);

    controller.dispose();
  });

  it("requestImmediate() during an in-flight refresh queues exactly one follow-up", async () => {
    const refreshes: Array<ReturnType<typeof deferred<void>>> = [];
    const onRefresh = mock(() => {
      const d = deferred<void>();
      refreshes.push(d);
      return d.promise;
    });

    const controller = new RefreshController({ onRefresh, debounceMs: 20 });

    controller.requestImmediate();
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(controller.isRefreshing).toBe(true);

    // Multiple immediate requests while in-flight should coalesce into a single follow-up.
    controller.requestImmediate();
    controller.requestImmediate();
    expect(onRefresh).toHaveBeenCalledTimes(1);

    expect(refreshes).toHaveLength(1);
    refreshes[0].resolve();

    // Allow the Promise.finally() callback + the queued trailing debounce refresh.
    await sleep(80);

    expect(onRefresh).toHaveBeenCalledTimes(2);

    expect(refreshes).toHaveLength(2);
    refreshes[1].resolve();
    await sleep(10);

    expect(controller.isRefreshing).toBe(false);

    controller.dispose();
  });

  it("isRefreshing reflects in-flight state", async () => {
    const refresh = deferred<void>();

    const onRefresh = mock(() => refresh.promise);
    const controller = new RefreshController({ onRefresh, debounceMs: 20 });

    expect(controller.isRefreshing).toBe(false);

    controller.requestImmediate();
    expect(controller.isRefreshing).toBe(true);

    refresh.resolve();
    await Promise.resolve();

    expect(controller.isRefreshing).toBe(false);

    controller.dispose();
  });

  it("dispose() cancels a pending debounce timer", async () => {
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
});
