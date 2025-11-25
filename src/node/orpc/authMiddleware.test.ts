import { describe, expect, it } from "bun:test";
import { safeEq } from "./authMiddleware";

describe("safeEq", () => {
  it("returns true for equal strings", () => {
    expect(safeEq("secret", "secret")).toBe(true);
    expect(safeEq("", "")).toBe(true);
    expect(safeEq("a", "a")).toBe(true);
  });

  it("returns false for different strings of same length", () => {
    expect(safeEq("secret", "secreT")).toBe(false);
    expect(safeEq("aaaaaa", "aaaaab")).toBe(false);
    expect(safeEq("a", "b")).toBe(false);
  });

  it("returns false for different length strings", () => {
    expect(safeEq("short", "longer")).toBe(false);
    expect(safeEq("", "a")).toBe(false);
    expect(safeEq("abc", "ab")).toBe(false);
  });

  it("handles unicode strings", () => {
    expect(safeEq("héllo", "héllo")).toBe(true);
    expect(safeEq("héllo", "hello")).toBe(false);
    expect(safeEq("🔐", "🔐")).toBe(true);
  });

  describe("timing consistency", () => {
    const ITERATIONS = 10000;
    const secret = "supersecrettoken123456789";

    function measureAvgTime(fn: () => void, iterations: number): number {
      const start = process.hrtime.bigint();
      for (let i = 0; i < iterations; i++) {
        fn();
      }
      const end = process.hrtime.bigint();
      return Number(end - start) / iterations;
    }

    it("takes similar time for matching vs non-matching strings of same length", () => {
      const matching = secret;
      const nonMatching = "Xupersecrettoken123456789"; // differs at first char

      const matchTime = measureAvgTime(() => safeEq(secret, matching), ITERATIONS);
      const nonMatchTime = measureAvgTime(() => safeEq(secret, nonMatching), ITERATIONS);

      // Allow up to 50% variance (timing tests are inherently noisy)
      const ratio = Math.max(matchTime, nonMatchTime) / Math.min(matchTime, nonMatchTime);
      expect(ratio).toBeLessThan(1.5);
    });

    it("takes similar time regardless of where mismatch occurs", () => {
      const earlyMismatch = "Xupersecrettoken123456789"; // first char
      const lateMismatch = "supersecrettoken12345678X"; // last char

      const earlyTime = measureAvgTime(() => safeEq(secret, earlyMismatch), ITERATIONS);
      const lateTime = measureAvgTime(() => safeEq(secret, lateMismatch), ITERATIONS);

      const ratio = Math.max(earlyTime, lateTime) / Math.min(earlyTime, lateTime);
      expect(ratio).toBeLessThan(1.5);
    });

    it("length mismatch takes comparable time to same-length comparison", () => {
      const sameLength = "Xupersecrettoken123456789";
      const diffLength = "short";

      const sameLenTime = measureAvgTime(() => safeEq(secret, sameLength), ITERATIONS);
      const diffLenTime = measureAvgTime(() => safeEq(secret, diffLength), ITERATIONS);

      // Length mismatch should not be significantly faster due to dummy comparison
      const ratio = Math.max(sameLenTime, diffLenTime) / Math.min(sameLenTime, diffLenTime);
      expect(ratio).toBeLessThan(2.0);
    });
  });
});
