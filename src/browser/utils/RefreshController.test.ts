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
  it("schedule() debounces and resets to the last call", async () => {
    const onRefresh = mock<() => void>(() => undefined);
    const controller = new RefreshController({ onRefresh, debounceMs: 50 });

    controller.schedule();
    await sleep(25);
    controller.schedule();

    // Only ~35ms after the last schedule() (debounceMs=50), so we should not have refreshed yet.
    await sleep(35);
    expect(onRefresh).not.toHaveBeenCalled();

    await sleep(40);
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

    // Allow the Promise.finally() callback + the queued setTimeout(0) refresh.
    await sleep(10);

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
