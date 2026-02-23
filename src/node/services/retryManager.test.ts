import { afterEach, beforeEach, describe, expect, it, setSystemTime, vi } from "bun:test";
import { calculateBackoffDelay } from "@/common/utils/messages/retryState";
import { RetryManager, type RetryStatusEvent } from "./retryManager";

interface ScheduledTimer {
  callback: () => void;
  delayMs: number;
}

describe("RetryManager", () => {
  let scheduledTimers: Map<number, ScheduledTimer>;
  let nextTimerId: number;

  beforeEach(() => {
    setSystemTime(new Date("2026-01-01T00:00:00Z"));

    scheduledTimers = new Map();
    nextTimerId = 1;

    vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      handler: TimerHandler,
      timeout?: number
    ) => {
      if (typeof handler !== "function") {
        throw new Error("RetryManager tests only support function timer handlers");
      }
      const fn = handler as () => void;

      const timerId = nextTimerId;
      nextTimerId += 1;
      scheduledTimers.set(timerId, {
        callback: () => {
          fn();
        },
        delayMs: timeout ?? 0,
      });

      return timerId as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout);

    vi.spyOn(globalThis, "clearTimeout").mockImplementation(((
      timer: ReturnType<typeof setTimeout>
    ) => {
      const timerId = Number(timer);
      scheduledTimers.delete(timerId);
    }) as typeof clearTimeout);
  });

  afterEach(() => {
    setSystemTime();
    vi.restoreAllMocks();
  });

  function runNextTimer(): void {
    const next = [...scheduledTimers.entries()].sort((left, right) => left[0] - right[0])[0];
    if (!next) {
      throw new Error("Expected at least one scheduled timer");
    }

    const [timerId, timer] = next;
    scheduledTimers.delete(timerId);
    timer.callback();
  }

  function createRetryManager() {
    const onRetry = vi.fn(() => Promise.resolve());
    const events: RetryStatusEvent[] = [];
    const onStatusChange = vi.fn((event: RetryStatusEvent) => {
      events.push(event);
    });

    return {
      manager: new RetryManager("workspace-1", onRetry, onStatusChange),
      onRetry,
      onStatusChange,
      events,
    };
  }

  it("uses exponential backoff delays from common retry state utilities", () => {
    expect(calculateBackoffDelay(0)).toBe(1000);
    expect(calculateBackoffDelay(1)).toBe(2000);
    expect(calculateBackoffDelay(2)).toBe(4000);
    expect(calculateBackoffDelay(6)).toBe(60000);
  });

  it("abandons non-retryable errors", () => {
    const { manager, onRetry, onStatusChange, events } = createRetryManager();

    manager.handleStreamFailure({ type: "api_key_not_found" });

    expect(onStatusChange).toHaveBeenCalledTimes(1);
    expect(events).toEqual([{ type: "auto-retry-abandoned", reason: "api_key_not_found" }]);
    expect(manager.isRetryPending).toBe(false);
    expect(scheduledTimers.size).toBe(0);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("non-retryable error cancels pending retryable timer", () => {
    const { manager, events } = createRetryManager();

    // Schedule a retryable error first
    manager.handleStreamFailure({ type: "unknown" });
    expect(manager.isRetryPending).toBe(true);

    // Then a non-retryable error arrives — should cancel the pending timer
    manager.handleStreamFailure({ type: "api_key_not_found" });
    expect(manager.isRetryPending).toBe(false);
    expect(scheduledTimers.size).toBe(0);
    expect(events).toContainEqual({ type: "auto-retry-abandoned", reason: "api_key_not_found" });
  });

  it("schedules and runs retry after backoff delay", async () => {
    const { manager, onRetry, events } = createRetryManager();

    manager.handleStreamFailure({ type: "unknown", message: "transient" });

    const expectedDelay = calculateBackoffDelay(1);
    expect(events).toEqual([
      {
        type: "auto-retry-scheduled",
        attempt: 1,
        delayMs: expectedDelay,
        scheduledAt: Date.now(),
      },
    ]);
    expect(manager.isRetryPending).toBe(true);
    expect(scheduledTimers.size).toBe(1);
    expect(scheduledTimers.get(1)?.delayMs).toBe(expectedDelay);

    runNextTimer();
    await Promise.resolve();

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(events).toContainEqual({ type: "auto-retry-starting", attempt: 1 });
    expect(manager.isRetryPending).toBe(false);
    expect(scheduledTimers.size).toBe(0);
  });

  it("exposes pending scheduled retry for reconnect snapshots", () => {
    const { manager } = createRetryManager();

    manager.handleStreamFailure({ type: "unknown", message: "transient" });

    const snapshot = manager.getScheduledStatusSnapshot();
    expect(snapshot).toEqual({
      type: "auto-retry-scheduled",
      attempt: 1,
      delayMs: calculateBackoffDelay(1),
      scheduledAt: Date.now(),
    });

    // Snapshot should be defensive-copied.
    if (!snapshot) {
      throw new Error("Expected a pending retry snapshot");
    }
    snapshot.attempt = 99;

    expect(manager.getScheduledStatusSnapshot()).toEqual({
      type: "auto-retry-scheduled",
      attempt: 1,
      delayMs: calculateBackoffDelay(1),
      scheduledAt: Date.now(),
    });

    runNextTimer();
    expect(manager.getScheduledStatusSnapshot()).toBeNull();
  });

  it("clears pending scheduled snapshot when retry is canceled", () => {
    const { manager } = createRetryManager();

    manager.handleStreamFailure({ type: "unknown" });
    expect(manager.getScheduledStatusSnapshot()).not.toBeNull();

    manager.cancel();
    expect(manager.getScheduledStatusSnapshot()).toBeNull();
  });

  it("cancel clears pending retry timer", () => {
    const { manager, onRetry } = createRetryManager();

    manager.handleStreamFailure({ type: "unknown" });
    expect(manager.isRetryPending).toBe(true);
    expect(scheduledTimers.size).toBe(1);

    manager.cancel();
    expect(manager.isRetryPending).toBe(false);
    expect(scheduledTimers.size).toBe(0);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("setEnabled(false) prevents scheduling", () => {
    const { manager, onStatusChange } = createRetryManager();

    manager.setEnabled(false);
    manager.handleStreamFailure({ type: "unknown" });

    expect(onStatusChange).not.toHaveBeenCalled();
    expect(manager.isRetryPending).toBe(false);
    expect(scheduledTimers.size).toBe(0);
  });

  it("setEnabled(false) cancels pending retry and emits abandoned event", () => {
    const { manager, events } = createRetryManager();

    manager.handleStreamFailure({ type: "unknown" });
    expect(manager.isRetryPending).toBe(true);

    manager.setEnabled(false);
    expect(manager.isRetryPending).toBe(false);
    expect(scheduledTimers.size).toBe(0);
    expect(events).toContainEqual({
      type: "auto-retry-abandoned",
      reason: "disabled_by_user",
    });
  });

  it("setEnabled(false) emits abandoned even after timer has fired (in-flight retry)", () => {
    const { manager, events } = createRetryManager();

    // Schedule a retry, then fire the timer so retryTimer is null
    // but state.attempt > 0 (retry callback is in-flight).
    manager.handleStreamFailure({ type: "unknown" });
    expect(manager.isRetryPending).toBe(true);
    runNextTimer();
    expect(manager.isRetryPending).toBe(false);

    // Disable while the retry callback is executing. Even though the timer
    // is gone, the UI should still be cleared via abandoned event.
    manager.setEnabled(false);
    expect(events).toContainEqual({
      type: "auto-retry-abandoned",
      reason: "disabled_by_user",
    });
  });

  it("setEnabled(false) during auto-retry-starting prevents queued resume", () => {
    const onRetry = vi.fn(() => Promise.resolve());
    const events: RetryStatusEvent[] = [];

    const managerRef: { current?: RetryManager } = {};
    const onStatusChange = vi.fn((event: RetryStatusEvent) => {
      events.push(event);
      if (event.type === "auto-retry-starting") {
        managerRef.current?.setEnabled(false);
      }
    });

    const manager = new RetryManager("workspace-1", onRetry, onStatusChange);
    managerRef.current = manager;

    manager.handleStreamFailure({ type: "unknown" });
    runNextTimer();

    expect(onRetry).not.toHaveBeenCalled();
    expect(events).toContainEqual({
      type: "auto-retry-abandoned",
      reason: "disabled_by_user",
    });
  });

  it("ignores stale onRetry rejection after disable", async () => {
    let rejectRetry: ((reason?: unknown) => void) | undefined;
    const onRetry = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectRetry = reject;
        })
    );

    const events: RetryStatusEvent[] = [];
    const onStatusChange = vi.fn((event: RetryStatusEvent) => {
      events.push(event);
    });

    const manager = new RetryManager("workspace-1", onRetry, onStatusChange);

    manager.handleStreamFailure({ type: "unknown" });
    runNextTimer();
    expect(onRetry).toHaveBeenCalledTimes(1);

    manager.setEnabled(false);
    rejectRetry?.(new Error("late_retry_failure"));
    await Promise.resolve();
    await Promise.resolve();

    const abandonedReasons = events
      .filter(
        (event): event is Extract<RetryStatusEvent, { type: "auto-retry-abandoned" }> =>
          event.type === "auto-retry-abandoned"
      )
      .map((event) => event.reason);

    expect(abandonedReasons).toContain("disabled_by_user");
    expect(abandonedReasons).not.toContain("late_retry_failure");
  });

  it("reschedules when a second failure arrives while retry is pending", () => {
    const { manager, events } = createRetryManager();

    // First failure schedules a retry
    manager.handleStreamFailure({ type: "unknown" });
    expect(manager.isRetryPending).toBe(true);
    expect(scheduledTimers.size).toBe(1);

    // Second failure should cancel the first and reschedule with higher backoff
    manager.handleStreamFailure({ type: "network" });
    expect(manager.isRetryPending).toBe(true);
    expect(scheduledTimers.size).toBe(1); // only one timer active

    const scheduleEvents = events.filter(
      (event): event is Extract<RetryStatusEvent, { type: "auto-retry-scheduled" }> =>
        event.type === "auto-retry-scheduled"
    );
    expect(scheduleEvents).toHaveLength(2);
    // Second attempt should have higher backoff than first
    expect(scheduleEvents[1].attempt).toBeGreaterThan(scheduleEvents[0].attempt);
  });

  it("handleStreamSuccess resets retry attempt progression", () => {
    const { manager, events } = createRetryManager();

    manager.handleStreamFailure({ type: "unknown" });
    runNextTimer();

    manager.handleStreamSuccess();
    manager.handleStreamFailure({ type: "unknown" });

    const scheduleEvents = events.filter(
      (event): event is Extract<RetryStatusEvent, { type: "auto-retry-scheduled" }> =>
        event.type === "auto-retry-scheduled"
    );

    expect(scheduleEvents).toHaveLength(2);
    expect(scheduleEvents[0]?.attempt).toBe(1);
    expect(scheduleEvents[1]?.attempt).toBe(1);
  });
});
