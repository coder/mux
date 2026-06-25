import { describe, expect, test } from "bun:test";

import { formatHeartbeatInterval, formatHeartbeatIntervalShort } from "./heartbeat";

describe("formatHeartbeatInterval", () => {
  test("renders whole hours and pluralizes minutes", () => {
    expect(formatHeartbeatInterval(60_000)).toBe("1 minute");
    expect(formatHeartbeatInterval(30 * 60_000)).toBe("30 minutes");
    expect(formatHeartbeatInterval(3_600_000)).toBe("1 hour");
    expect(formatHeartbeatInterval(2 * 3_600_000)).toBe("2 hours");
  });

  test("rounds in-range non-whole-minute intervals instead of emitting raw ms", () => {
    expect(formatHeartbeatInterval(5 * 60_000 + 1)).toBe("5 minutes");
    expect(formatHeartbeatIntervalShort(5 * 60_000 + 1)).toBe("5m");
  });
});

describe("formatHeartbeatIntervalShort", () => {
  test("uses the largest whole unit", () => {
    expect(formatHeartbeatIntervalShort(30 * 60_000)).toBe("30m");
    expect(formatHeartbeatIntervalShort(3_600_000)).toBe("1h");
    expect(formatHeartbeatIntervalShort(2 * 3_600_000)).toBe("2h");
  });
});
