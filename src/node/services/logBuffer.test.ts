import { beforeEach, describe, expect, test } from "bun:test";

import { MAX_LOG_ENTRIES } from "@/common/constants/ui";
import {
  clearLogEntries,
  pushLogEntry,
  subscribeLogFeed,
  type BufferEvent,
  type LogEntry,
} from "./logBuffer";

function createEntry(id: number): LogEntry {
  return {
    timestamp: id,
    level: "info",
    message: `entry-${id}`,
    location: `src/test.ts:${id}`,
  };
}

describe("logBuffer", () => {
  beforeEach(() => {
    clearLogEntries();
  });

  test("pushLogEntry emits append events with the current epoch", () => {
    const received: BufferEvent[] = [];

    const { snapshot, unsubscribe } = subscribeLogFeed((event) => {
      received.push(event);
    });
    const startEpoch = snapshot.epoch;

    const entry = createEntry(1);
    pushLogEntry(entry);

    unsubscribe();

    expect(received).toEqual([{ type: "append", epoch: startEpoch, entry }]);
  });

  test("subscribeLogFeed snapshots existing entries and streams new events", () => {
    const existingEntry = createEntry(2);
    pushLogEntry(existingEntry);
    const received: BufferEvent[] = [];

    const { snapshot, unsubscribe } = subscribeLogFeed((event) => {
      received.push(event);
    });

    expect(snapshot.entries).toEqual([existingEntry]);

    const nextEntry = createEntry(3);
    pushLogEntry(nextEntry);

    unsubscribe();

    expect(received).toEqual([{ type: "append", epoch: snapshot.epoch, entry: nextEntry }]);
  });

  test("clearLogEntries emits a reset event and increments epoch", () => {
    const received: BufferEvent[] = [];

    const { snapshot, unsubscribe } = subscribeLogFeed((event) => {
      received.push(event);
    });
    const startEpoch = snapshot.epoch;

    clearLogEntries();

    unsubscribe();

    expect(received).toEqual([{ type: "reset", epoch: startEpoch + 1 }]);
  });

  test("unsubscribe stops receiving append and reset events", () => {
    const received: BufferEvent[] = [];

    const { unsubscribe } = subscribeLogFeed((event) => {
      received.push(event);
    });

    unsubscribe();
    pushLogEntry(createEntry(2));
    clearLogEntries();

    expect(received).toHaveLength(0);
  });

  test("epoch only advances on reset events", () => {
    const noop = () => void 0;
    const { snapshot: before } = subscribeLogFeed(noop);
    const initialEpoch = before.epoch;

    pushLogEntry(createEntry(3));
    const { snapshot: afterPush } = subscribeLogFeed(noop);
    expect(afterPush.epoch).toBe(initialEpoch);

    clearLogEntries();
    const { snapshot: afterFirstReset } = subscribeLogFeed(noop);
    expect(afterFirstReset.epoch).toBe(initialEpoch + 1);

    clearLogEntries();
    const { snapshot: afterSecondReset } = subscribeLogFeed(noop);
    expect(afterSecondReset.epoch).toBe(initialEpoch + 2);
  });

  test("retains only the most recent MAX_LOG_ENTRIES entries", () => {
    const overflowCount = 5;
    const totalEntries = MAX_LOG_ENTRIES + overflowCount;

    for (let id = 0; id < totalEntries; id += 1) {
      pushLogEntry(createEntry(id));
    }

    const { snapshot } = subscribeLogFeed(() => void 0);

    expect(snapshot.entries).toHaveLength(MAX_LOG_ENTRIES);
    expect(snapshot.entries[0]?.message).toBe(`entry-${overflowCount}`);
    expect(snapshot.entries.at(-1)?.message).toBe(`entry-${totalEntries - 1}`);
  });
});
