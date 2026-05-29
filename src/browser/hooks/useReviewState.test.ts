/**
 * Tests for useReviewState hook
 *
 * Note: Hook integration tests are omitted because they require jsdom setup.
 * The eviction logic is the critical piece and is tested here.
 * The hook itself is a thin wrapper around usePersistedState with manual testing.
 */

import { describe, it, expect } from "bun:test";
import type { HunkReadState } from "@/common/types/review";
import { evictOldestReviews } from "./useReviewState";

describe("evictOldestReviews", () => {
  it("should not evict when under limit", () => {
    const readState: Record<string, HunkReadState> = {
      "hunk-1": { hunkId: "hunk-1", isRead: true, timestamp: 1 },
      "hunk-2": { hunkId: "hunk-2", isRead: true, timestamp: 2 },
    };

    const result = evictOldestReviews(readState, 10);
    expect(Object.keys(result).length).toBe(2);
  });

  it("should evict oldest entries when exceeding limit", () => {
    const readState: Record<string, HunkReadState> = {
      "hunk-1": { hunkId: "hunk-1", isRead: true, timestamp: 1 },
      "hunk-2": { hunkId: "hunk-2", isRead: true, timestamp: 2 },
      "hunk-3": { hunkId: "hunk-3", isRead: true, timestamp: 3 },
      "hunk-4": { hunkId: "hunk-4", isRead: true, timestamp: 4 },
      "hunk-5": { hunkId: "hunk-5", isRead: true, timestamp: 5 },
    };

    const result = evictOldestReviews(readState, 3);
    expect(Object.keys(result).length).toBe(3);

    // Should keep the newest 3 (timestamps 3, 4, 5)
    expect(result["hunk-3"]).toBeDefined();
    expect(result["hunk-4"]).toBeDefined();
    expect(result["hunk-5"]).toBeDefined();

    // Should evict oldest 2 (timestamps 1, 2)
    expect(result["hunk-1"]).toBeUndefined();
    expect(result["hunk-2"]).toBeUndefined();
  });

  it("should handle exactly at limit", () => {
    const readState: Record<string, HunkReadState> = {
      "hunk-1": { hunkId: "hunk-1", isRead: true, timestamp: 1 },
      "hunk-2": { hunkId: "hunk-2", isRead: true, timestamp: 2 },
      "hunk-3": { hunkId: "hunk-3", isRead: true, timestamp: 3 },
    };

    const result = evictOldestReviews(readState, 3);
    expect(Object.keys(result).length).toBe(3);
    expect(result).toEqual(readState);
  });

  it("should handle empty state", () => {
    const readState: Record<string, HunkReadState> = {};
    const result = evictOldestReviews(readState, 10);
    expect(Object.keys(result).length).toBe(0);
  });

  it("should evict to exact limit with many entries", () => {
    const readState: Record<string, HunkReadState> = {};
    // Create 1100 entries
    for (let i = 0; i < 1100; i++) {
      readState[`hunk-${i}`] = {
        hunkId: `hunk-${i}`,
        isRead: true,
        timestamp: i,
      };
    }

    const result = evictOldestReviews(readState, 1024);
    expect(Object.keys(result).length).toBe(1024);

    // Should keep newest 1024 (timestamps 76-1099)
    expect(result["hunk-1099"]).toBeDefined();
    expect(result["hunk-76"]).toBeDefined();

    // Should evict oldest (timestamps 0-75)
    expect(result["hunk-0"]).toBeUndefined();
    expect(result["hunk-75"]).toBeUndefined();
  });
});
