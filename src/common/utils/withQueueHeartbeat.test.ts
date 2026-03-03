import { describe, expect, test } from "bun:test";
import { createAsyncEventQueue } from "./asyncEventIterator";
import { withQueueHeartbeat } from "./withQueueHeartbeat";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("withQueueHeartbeat", () => {
  test("passes through normal events", async () => {
    const queue = createAsyncEventQueue<string>();
    const wrapped = withQueueHeartbeat(queue, "heartbeat", 1_000);
    const iterator = wrapped.iterate();

    wrapped.push("event-1");
    wrapped.push("event-2");

    const first = await iterator.next();
    const second = await iterator.next();

    wrapped.end();
    const done = await iterator.next();

    expect(first).toEqual({ value: "event-1", done: false });
    expect(second).toEqual({ value: "event-2", done: false });
    expect(done.done).toBe(true);
  });

  test("emits heartbeat events on an interval", async () => {
    const queue = createAsyncEventQueue<string>();
    const wrapped = withQueueHeartbeat(queue, "heartbeat", 10);

    const eventsPromise = (async () => {
      const events: string[] = [];
      for await (const event of wrapped.iterate()) {
        events.push(event);
      }
      return events;
    })();

    await sleep(25);
    wrapped.push("event-1");
    await sleep(35);
    wrapped.end();

    const events = await eventsPromise;
    const heartbeats = events.filter((event) => event === "heartbeat");
    const payloadIndex = events.indexOf("event-1");

    expect(heartbeats.length).toBeGreaterThanOrEqual(2);
    expect(payloadIndex).toBeGreaterThan(0);
    expect(payloadIndex).toBeLessThan(events.length - 1);
  });

  test("stops heartbeat timer when end() is called", async () => {
    const inner = createAsyncEventQueue<string>();
    let heartbeatPushCount = 0;

    const queue = {
      push: (event: string) => {
        if (event === "heartbeat") {
          heartbeatPushCount += 1;
        }
        inner.push(event);
      },
      iterate: inner.iterate,
      end: inner.end,
    };

    const wrapped = withQueueHeartbeat(queue, "heartbeat", 10);

    const consumer = (async () => {
      for await (const _event of wrapped.iterate()) {
        // no-op: keep iterator active until end()
      }
    })();

    await sleep(30);
    wrapped.end();

    const countAtEnd = heartbeatPushCount;
    await sleep(30);

    expect(countAtEnd).toBeGreaterThan(0);
    expect(heartbeatPushCount).toBe(countAtEnd);

    await consumer;
  });

  test("stops heartbeat timer when consumer breaks iteration", async () => {
    const inner = createAsyncEventQueue<string>();
    let heartbeatPushCount = 0;

    const queue = {
      push: (event: string) => {
        if (event === "heartbeat") {
          heartbeatPushCount += 1;
        }
        inner.push(event);
      },
      iterate: inner.iterate,
      end: inner.end,
    };

    const wrapped = withQueueHeartbeat(queue, "heartbeat", 10);

    await (async () => {
      for await (const event of wrapped.iterate()) {
        if (event === "heartbeat") {
          break;
        }
      }
    })();

    const countAfterBreak = heartbeatPushCount;
    await sleep(30);

    expect(countAfterBreak).toBeGreaterThan(0);
    expect(heartbeatPushCount).toBe(countAfterBreak);

    wrapped.end();
  });

  test("supports calling end() multiple times", async () => {
    const queue = createAsyncEventQueue<string>();
    const wrapped = withQueueHeartbeat(queue, "heartbeat", 10);

    const consumer = (async () => {
      for await (const _event of wrapped.iterate()) {
        // no-op
      }
    })();

    await sleep(15);

    expect(() => {
      wrapped.end();
      wrapped.end();
    }).not.toThrow();

    await consumer;
  });
});
