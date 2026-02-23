import { beforeEach, describe, expect, test } from "bun:test";

import { MAX_LOG_ENTRIES } from "@/common/constants/ui";
import {
  clearLogEntries,
  getEpoch,
  getRecentLogs,
  onLogEntry,
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
    const startEpoch = getEpoch();
    const received: BufferEvent[] = [];

    const unsubscribe = onLogEntry((event) => {
      received.push(event);
    });

    const entry = createEntry(1);
    pushLogEntry(entry);

    unsubscribe();

    expect(received).toEqual([{ type: "append", epoch: startEpoch, entry }]);
  });

  test("subscribeLogFeed snapshots existing entries and streams new events", () => {
    const existingEntry = createEntry(2);
    pushLogEntry(existingEntry);
    const currentEpoch = getEpoch();
    const received: BufferEvent[] = [];

    const { snapshot, unsubscribe } = subscribeLogFeed((event) => {
      received.push(event);
    });

    expect(snapshot).toEqual({ epoch: currentEpoch, entries: [existingEntry] });

    const nextEntry = createEntry(3);
    pushLogEntry(nextEntry);

    unsubscribe();

    expect(received).toEqual([{ type: "append", epoch: currentEpoch, entry: nextEntry }]);
  });

  test("clearLogEntries emits a reset event and increments epoch", () => {
    const startEpoch = getEpoch();
    const received: BufferEvent[] = [];

    const unsubscribe = onLogEntry((event) => {
      received.push(event);
    });

    clearLogEntries();

    unsubscribe();

    expect(received).toEqual([{ type: "reset", epoch: startEpoch + 1 }]);
    expect(getEpoch()).toBe(startEpoch + 1);
  });

  test("unsubscribe stops receiving append and reset events", () => {
    const received: BufferEvent[] = [];

    const unsubscribe = onLogEntry((event) => {
      received.push(event);
    });

    unsubscribe();
    pushLogEntry(createEntry(2));
    clearLogEntries();

    expect(received).toHaveLength(0);
  });

  test("getEpoch only advances on reset events", () => {
    const initialEpoch = getEpoch();

    pushLogEntry(createEntry(3));
    expect(getEpoch()).toBe(initialEpoch);

    clearLogEntries();
    const afterFirstReset = getEpoch();
    expect(afterFirstReset).toBe(initialEpoch + 1);

    clearLogEntries();
    expect(getEpoch()).toBe(afterFirstReset + 1);
  });

  test("retains only the most recent MAX_LOG_ENTRIES entries", () => {
    const overflowCount = 5;
    const totalEntries = MAX_LOG_ENTRIES + overflowCount;

    for (let id = 0; id < totalEntries; id += 1) {
      pushLogEntry(createEntry(id));
    }

    const recent = getRecentLogs();

    expect(recent).toHaveLength(MAX_LOG_ENTRIES);
    expect(recent[0]?.message).toBe(`entry-${overflowCount}`);
    expect(recent.at(-1)?.message).toBe(`entry-${totalEntries - 1}`);
  });
});
