import { describe, expect, it } from "bun:test";
import {
  formatDurationShort,
  isWorkspaceSnoozed,
  MAX_SNOOZE_MS,
  parseHumanDurationMs,
} from "./snooze";

describe("parseHumanDurationMs", () => {
  it("parses minutes, hours, days, and weeks", () => {
    expect(parseHumanDurationMs("15m")).toBe(15 * 60_000);
    expect(parseHumanDurationMs("2h")).toBe(2 * 60 * 60_000);
    expect(parseHumanDurationMs("3d")).toBe(3 * 24 * 60 * 60_000);
    expect(parseHumanDurationMs("1w")).toBe(7 * 24 * 60 * 60_000);
  });

  it("is case-insensitive and tolerant of whitespace", () => {
    expect(parseHumanDurationMs(" 2H ")).toBe(2 * 60 * 60_000);
    expect(parseHumanDurationMs("2 h")).toBe(2 * 60 * 60_000);
  });

  it("rejects zero, negative, decimal, and unknown units", () => {
    // Zero would mean "snooze for no time" — not useful and would round-trip to
    // an unsnooze, so we force callers to use the explicit `off` keyword.
    expect(parseHumanDurationMs("0h")).toBeNull();
    expect(parseHumanDurationMs("-2h")).toBeNull();
    expect(parseHumanDurationMs("1.5h")).toBeNull();
    expect(parseHumanDurationMs("3y")).toBeNull();
    expect(parseHumanDurationMs("")).toBeNull();
    expect(parseHumanDurationMs("abc")).toBeNull();
  });
});

describe("formatDurationShort", () => {
  it("picks the largest dividing unit", () => {
    expect(formatDurationShort(15 * 60_000)).toBe("15m");
    expect(formatDurationShort(60 * 60_000)).toBe("1h");
    expect(formatDurationShort(2 * 24 * 60 * 60_000)).toBe("2d");
    expect(formatDurationShort(2 * 7 * 24 * 60 * 60_000)).toBe("2w");
  });

  it("falls back to minutes for non-clean values", () => {
    expect(formatDurationShort(90 * 60_000)).toBe("90m");
  });

  it("returns 0m for nonpositive or non-finite input", () => {
    expect(formatDurationShort(0)).toBe("0m");
    expect(formatDurationShort(-1)).toBe("0m");
    expect(formatDurationShort(Number.NaN)).toBe("0m");
  });
});

describe("isWorkspaceSnoozed", () => {
  const NOW = 1_700_000_000_000;

  it("returns true while the deadline is in the future", () => {
    const future = new Date(NOW + 60 * 60_000).toISOString();
    expect(isWorkspaceSnoozed(future, NOW)).toBe(true);
  });

  it("returns false when the deadline has already passed (auto-drains the section)", () => {
    const past = new Date(NOW - 1).toISOString();
    expect(isWorkspaceSnoozed(past, NOW)).toBe(false);
  });

  it("handles missing or malformed timestamps defensively", () => {
    expect(isWorkspaceSnoozed(undefined, NOW)).toBe(false);
    expect(isWorkspaceSnoozed("not-a-date", NOW)).toBe(false);
  });
});

describe("MAX_SNOOZE_MS", () => {
  it("matches 52 weeks", () => {
    expect(MAX_SNOOZE_MS).toBe(52 * 7 * 24 * 60 * 60_000);
  });
});
