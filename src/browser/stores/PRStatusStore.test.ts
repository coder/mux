import { describe, expect, it } from "bun:test";

import { parseMergeQueueEntry } from "./PRStatusStore";

describe("parseMergeQueueEntry", () => {
  it("returns null for null and undefined", () => {
    expect(parseMergeQueueEntry(null)).toBeNull();
    expect(parseMergeQueueEntry(undefined)).toBeNull();
  });

  it("returns null for non-object values", () => {
    expect(parseMergeQueueEntry("queue")).toBeNull();
    expect(parseMergeQueueEntry(42)).toBeNull();
    expect(parseMergeQueueEntry(true)).toBeNull();
  });

  it("parses valid merge queue entry", () => {
    expect(parseMergeQueueEntry({ state: "QUEUED", position: 0 })).toEqual({
      state: "QUEUED",
      position: 0,
    });
  });

  it("allows null position", () => {
    expect(parseMergeQueueEntry({ state: "AWAITING_CHECKS", position: null })).toEqual({
      state: "AWAITING_CHECKS",
      position: null,
    });
  });

  it("defaults state to QUEUED when absent", () => {
    expect(parseMergeQueueEntry({ position: 2 })).toEqual({
      state: "QUEUED",
      position: 2,
    });
  });

  it("normalizes invalid position values to null", () => {
    expect(parseMergeQueueEntry({ state: "QUEUED", position: -1 })).toEqual({
      state: "QUEUED",
      position: null,
    });
    expect(parseMergeQueueEntry({ state: "QUEUED", position: 1.5 })).toEqual({
      state: "QUEUED",
      position: null,
    });
    expect(parseMergeQueueEntry({ state: "QUEUED", position: "0" })).toEqual({
      state: "QUEUED",
      position: null,
    });
  });
});
