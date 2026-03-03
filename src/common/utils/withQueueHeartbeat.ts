export type AsyncQueue<T> = {
  push: (value: T) => void;
  iterate: () => AsyncGenerator<T>;
  end: () => void;
};

export const SUBSCRIPTION_HEARTBEAT_INTERVAL_MS = 5_000;

/**
 * Wraps any { push, iterate, end } queue to inject periodic heartbeat events.
 * Heartbeats begin when the consumer starts iterating and stop when the
 * iterator completes (either via end() or consumer break/return).
 */
export function withQueueHeartbeat<T>(
  queue: AsyncQueue<T>,
  heartbeatEvent: T,
  intervalMs = SUBSCRIPTION_HEARTBEAT_INTERVAL_MS
): AsyncQueue<T> {
  let timer: ReturnType<typeof setInterval> | null = null;

  const stop = () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };

  return {
    push: queue.push,
    end: () => {
      stop();
      queue.end();
    },
    iterate: () =>
      (async function* () {
        timer = setInterval(() => queue.push(heartbeatEvent), intervalMs);
        try {
          yield* queue.iterate();
        } finally {
          stop();
        }
      })(),
  };
}
