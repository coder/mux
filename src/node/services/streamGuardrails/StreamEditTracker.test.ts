import { describe, expect, test } from "bun:test";

import { DOOM_LOOP_EDIT_THRESHOLD, StreamEditTracker } from "./StreamEditTracker";

describe("StreamEditTracker", () => {
  test("recordEdit increments edit count for the same file", () => {
    const tracker = new StreamEditTracker();

    expect(tracker.recordEdit("/tmp/file.ts")).toBe(1);
    expect(tracker.recordEdit("/tmp/file.ts")).toBe(2);
    expect(tracker.recordEdit("/tmp/file.ts")).toBe(3);
  });

  test("hasAnyEdits is false before edits and true after first edit", () => {
    const tracker = new StreamEditTracker();

    expect(tracker.hasAnyEdits()).toBe(false);
    tracker.recordEdit("/tmp/file.ts");
    expect(tracker.hasAnyEdits()).toBe(true);
  });

  test("shouldNudge is false below threshold and true at threshold", () => {
    const tracker = new StreamEditTracker();
    const filePath = "/tmp/file.ts";

    for (let i = 0; i < DOOM_LOOP_EDIT_THRESHOLD - 1; i += 1) {
      tracker.recordEdit(filePath);
    }

    expect(tracker.shouldNudge(filePath, DOOM_LOOP_EDIT_THRESHOLD)).toBe(false);

    tracker.recordEdit(filePath);
    expect(tracker.shouldNudge(filePath, DOOM_LOOP_EDIT_THRESHOLD)).toBe(true);
  });

  test("shouldNudge is once per file after markNudged", () => {
    const tracker = new StreamEditTracker();
    const filePath = "/tmp/file.ts";

    for (let i = 0; i < DOOM_LOOP_EDIT_THRESHOLD; i += 1) {
      tracker.recordEdit(filePath);
    }

    expect(tracker.shouldNudge(filePath, DOOM_LOOP_EDIT_THRESHOLD)).toBe(true);

    tracker.markNudged(filePath);
    expect(tracker.shouldNudge(filePath, DOOM_LOOP_EDIT_THRESHOLD)).toBe(false);

    tracker.recordEdit(filePath);
    expect(tracker.shouldNudge(filePath, DOOM_LOOP_EDIT_THRESHOLD)).toBe(false);
  });

  test("tracks edit counts independently per file", () => {
    const tracker = new StreamEditTracker();

    for (let i = 0; i < DOOM_LOOP_EDIT_THRESHOLD; i += 1) {
      tracker.recordEdit("/tmp/a.ts");
    }
    tracker.recordEdit("/tmp/b.ts");

    expect(tracker.shouldNudge("/tmp/a.ts", DOOM_LOOP_EDIT_THRESHOLD)).toBe(true);
    expect(tracker.shouldNudge("/tmp/b.ts", DOOM_LOOP_EDIT_THRESHOLD)).toBe(false);
  });
});
