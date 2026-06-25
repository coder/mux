import { describe, expect, test } from "bun:test";

import { formatHeartbeatInterval, formatHeartbeatIntervalShort } from "./HeartbeatToolCall";

describe("formatHeartbeatInterval", () => {
  test("pluralizes minutes and prefers whole hours", () => {
    expect(formatHeartbeatInterval(60_000)).toBe("1 minute");
    expect(formatHeartbeatInterval(30 * 60_000)).toBe("30 minutes");
    expect(formatHeartbeatInterval(3_600_000)).toBe("1 hour");
    expect(formatHeartbeatInterval(2 * 3_600_000)).toBe("2 hours");
  });

  test("falls back to milliseconds for sub-minute values", () => {
    expect(formatHeartbeatInterval(30_000)).toBe("30000 ms");
  });
});

describe("formatHeartbeatIntervalShort", () => {
  test("uses the largest whole unit", () => {
    expect(formatHeartbeatIntervalShort(30 * 60_000)).toBe("30m");
    expect(formatHeartbeatIntervalShort(3_600_000)).toBe("1h");
    expect(formatHeartbeatIntervalShort(2 * 3_600_000)).toBe("2h");
  });
});
