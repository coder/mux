import { describe, test, expect } from "bun:test";
import { formatRelativeTime } from "./dateTime";

describe("formatRelativeTime", () => {
  test("should return 'just now' for very recent timestamps", () => {
    const now = Date.now();
    expect(formatRelativeTime(now)).toBe("just now");
    expect(formatRelativeTime(now - 30 * 1000)).toBe("just now"); // 30 seconds ago
  });

  test("should return 'just now' for future timestamps", () => {
    const future = Date.now() + 5000;
    expect(formatRelativeTime(future)).toBe("just now");
  });

  test("should format minutes correctly", () => {
    const now = Date.now();
    expect(formatRelativeTime(now - 1 * 60 * 1000)).toBe("1 minute ago");
    expect(formatRelativeTime(now - 5 * 60 * 1000)).toBe("5 minutes ago");
    expect(formatRelativeTime(now - 59 * 60 * 1000)).toBe("59 minutes ago");
  });

  test("should format hours correctly", () => {
    const now = Date.now();
    expect(formatRelativeTime(now - 1 * 60 * 60 * 1000)).toBe("1 hour ago");
    expect(formatRelativeTime(now - 3 * 60 * 60 * 1000)).toBe("3 hours ago");
    expect(formatRelativeTime(now - 23 * 60 * 60 * 1000)).toBe("23 hours ago");
  });

  test("should format days correctly", () => {
    const now = Date.now();
    expect(formatRelativeTime(now - 1 * 24 * 60 * 60 * 1000)).toBe("1 day ago");
    expect(formatRelativeTime(now - 3 * 24 * 60 * 60 * 1000)).toBe("3 days ago");
    expect(formatRelativeTime(now - 6 * 24 * 60 * 60 * 1000)).toBe("6 days ago");
  });

  test("should format weeks correctly", () => {
    const now = Date.now();
    expect(formatRelativeTime(now - 7 * 24 * 60 * 60 * 1000)).toBe("1 week ago");
    expect(formatRelativeTime(now - 14 * 24 * 60 * 60 * 1000)).toBe("2 weeks ago");
    expect(formatRelativeTime(now - 27 * 24 * 60 * 60 * 1000)).toBe("3 weeks ago");
  });

  test("should format months correctly", () => {
    const now = Date.now();
    expect(formatRelativeTime(now - 30 * 24 * 60 * 60 * 1000)).toBe("1 month ago");
    expect(formatRelativeTime(now - 60 * 24 * 60 * 60 * 1000)).toBe("2 months ago");
    expect(formatRelativeTime(now - 180 * 24 * 60 * 60 * 1000)).toBe("6 months ago");
  });

  test("should format years correctly", () => {
    const now = Date.now();
    expect(formatRelativeTime(now - 365 * 24 * 60 * 60 * 1000)).toBe("1 year ago");
    expect(formatRelativeTime(now - 730 * 24 * 60 * 60 * 1000)).toBe("2 years ago");
  });
});
