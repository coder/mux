import { describe, it, expect } from "bun:test";
import {
  createFreshRetryState,
  createManualRetryState,
  createFailedRetryState,
  calculateBackoffDelay,
  INITIAL_DELAY,
} from "./retryState";

describe("retryState utilities", () => {
  describe("calculateBackoffDelay", () => {
    it("returns exponential backoff: 1s → 2s → 4s → 8s...", () => {
      expect(calculateBackoffDelay(0)).toBe(1000);
      expect(calculateBackoffDelay(1)).toBe(2000);
      expect(calculateBackoffDelay(2)).toBe(4000);
      expect(calculateBackoffDelay(3)).toBe(8000);
    });

    it("caps at 60 seconds for large attempts", () => {
      expect(calculateBackoffDelay(6)).toBe(60000);
      expect(calculateBackoffDelay(10)).toBe(60000);
    });
  });

  describe("createFreshRetryState", () => {
    it("creates a state with attempt 0 and no error", () => {
      const state = createFreshRetryState();
      expect(state.attempt).toBe(0);
      expect(state.lastError).toBeUndefined();
      expect(state.retryStartTime).toBeLessThanOrEqual(Date.now());
    });
  });

  describe("createManualRetryState", () => {
    it("preserves attempt counter (critical for backoff)", () => {
      const currentAttempt = 3;
      const state = createManualRetryState(currentAttempt);

      // CRITICAL: Manual retry must preserve attempt counter
      // This ensures exponential backoff continues if the retry fails
      expect(state.attempt).toBe(currentAttempt);
    });

    it("makes retry immediately eligible by backdating retryStartTime", () => {
      const state = createManualRetryState(0);
      const expectedTime = Date.now() - INITIAL_DELAY;
      expect(state.retryStartTime).toBeLessThanOrEqual(expectedTime);
    });

    it("clears any previous error", () => {
      const state = createManualRetryState(2);
      expect(state.lastError).toBeUndefined();
    });

    it("prevents no-backoff bug: preserves attempt counter for continued backoff", () => {
      // Bug scenario: After 3 failed attempts, manual retry should preserve counter
      // so next failure waits 2^3=8s, not reset to 2^0=1s
      const state = createManualRetryState(3);
      expect(state.attempt).toBe(3); // NOT reset to 0
    });
  });

  describe("createFailedRetryState", () => {
    it("increments attempt counter and stores error", () => {
      const error = { type: "unknown" as const, raw: "Test error" };
      const state = createFailedRetryState(2, error);

      expect(state.attempt).toBe(3);
      expect(state.lastError).toEqual(error);
      expect(state.retryStartTime).toBeLessThanOrEqual(Date.now());
    });
  });

  describe("backoff progression scenario", () => {
    it("maintains exponential backoff through manual retries", () => {
      // 3 auto-retry failures → manual retry → preserves attempt counter
      let state = createFailedRetryState(0, { type: "unknown" as const, raw: "Error" });
      state = createFailedRetryState(state.attempt, { type: "unknown" as const, raw: "Error" });
      state = createFailedRetryState(state.attempt, { type: "unknown" as const, raw: "Error" });
      expect(state.attempt).toBe(3);

      state = createManualRetryState(state.attempt);
      expect(state.attempt).toBe(3); // NOT reset to 0

      state = createFailedRetryState(state.attempt, { type: "unknown" as const, raw: "Error" });
      expect(state.attempt).toBe(4); // Continues progression
    });

    it("resets backoff on successful stream start", () => {
      let state = createFailedRetryState(0, { type: "unknown" as const, raw: "Error" });
      state = createFailedRetryState(state.attempt, { type: "unknown" as const, raw: "Error" });
      expect(state.attempt).toBe(2);

      state = createFreshRetryState();
      expect(state.attempt).toBe(0);
      expect(state.lastError).toBeUndefined();
    });
  });
});
