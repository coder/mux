import { describe, it, expect } from "bun:test";
import { createFreshRetryState, createFailedRetryState, calculateBackoffDelay } from "./retryState";

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
