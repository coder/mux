import { describe, expect, it } from "bun:test";
import { safeEq } from "./authMiddleware";

// Timing microbenchmarks are inherently noisy and can be flaky under parallel
// test execution. Run these locally with MUX_TEST_TIMING=1 when you want to
// sanity-check constant-time behavior.
const describeTiming = process.env.MUX_TEST_TIMING === "1" ? describe : describe.skip;

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

  describeTiming("timing consistency", () => {
    // Use a longer secret to make timing comparisons less noisy.
    const ITERATIONS = 2000;
    const secret = "a".repeat(256);

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
      const nonMatching = "b" + "a".repeat(secret.length - 1); // differs at first char

      const matchTime = measureAvgTime(() => safeEq(secret, matching), ITERATIONS);
      const nonMatchTime = measureAvgTime(() => safeEq(secret, nonMatching), ITERATIONS);

      const ratio = Math.max(matchTime, nonMatchTime) / Math.min(matchTime, nonMatchTime);
      // Timing microbenchmarks can be extremely noisy in CI and local dev environments.
      // This is a regression guard (against early-exit), not a strict performance spec.
      expect(ratio).toBeLessThan(2.0);
    });

    it("takes similar time regardless of where mismatch occurs", () => {
      const earlyMismatch = "b" + "a".repeat(secret.length - 1); // first char
      const lateMismatch = "a".repeat(secret.length - 1) + "b"; // last char

      const earlyTime = measureAvgTime(() => safeEq(secret, earlyMismatch), ITERATIONS);
      const lateTime = measureAvgTime(() => safeEq(secret, lateMismatch), ITERATIONS);

      const ratio = Math.max(earlyTime, lateTime) / Math.min(earlyTime, lateTime);
      // Timing microbenchmarks can be extremely noisy in CI and local dev environments.
      // This is a regression guard (against early-exit), not a strict performance spec.
      expect(ratio).toBeLessThan(2.0);
    });

    it("length mismatch takes comparable time to same-length comparison", () => {
      const sameLength = "b" + "a".repeat(secret.length - 1);
      const diffLength = "a".repeat(64);

      const sameLenTime = measureAvgTime(() => safeEq(secret, sameLength), ITERATIONS);
      const diffLenTime = measureAvgTime(() => safeEq(secret, diffLength), ITERATIONS);

      // Length mismatch should not be significantly faster (no early-exit)
      const ratio = Math.max(sameLenTime, diffLenTime) / Math.min(sameLenTime, diffLenTime);
      expect(ratio).toBeLessThan(2.0);
    });
  });
});
