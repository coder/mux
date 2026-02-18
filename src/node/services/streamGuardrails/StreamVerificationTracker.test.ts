import { describe, expect, test } from "bun:test";

import { StreamVerificationTracker } from "./StreamVerificationTracker";

describe("StreamVerificationTracker", () => {
  test("hasValidationAttempt is false initially and true after markValidationAttempt", () => {
    const tracker = new StreamVerificationTracker();

    expect(tracker.hasValidationAttempt()).toBe(false);

    tracker.markValidationAttempt();
    expect(tracker.hasValidationAttempt()).toBe(true);
  });

  test("nudge lifecycle for completion guard", () => {
    const tracker = new StreamVerificationTracker();

    expect(tracker.hasBeenNudged()).toBe(false);
    expect(tracker.shouldNudgeBeforeAllowingReport(false)).toBe(false);
    expect(tracker.shouldNudgeBeforeAllowingReport(true)).toBe(true);

    tracker.markNudged();
    expect(tracker.hasBeenNudged()).toBe(true);
    expect(tracker.shouldNudgeBeforeAllowingReport(true)).toBe(false);

    tracker.markValidationAttempt();
    expect(tracker.hasValidationAttempt()).toBe(true);
    expect(tracker.shouldNudgeBeforeAllowingReport(true)).toBe(false);
  });

  test("resetValidation clears validation state so pre-edit validation doesn't count", () => {
    const tracker = new StreamVerificationTracker();

    // Validate first
    tracker.markValidationAttempt();
    expect(tracker.hasValidationAttempt()).toBe(true);

    // Then an edit happens — validation should be reset
    tracker.resetValidation();
    expect(tracker.hasValidationAttempt()).toBe(false);

    // Guard should now nudge because validation was pre-edit
    expect(tracker.shouldNudgeBeforeAllowingReport(true)).toBe(true);
  });

  test("post-edit validation still counts after reset", () => {
    const tracker = new StreamVerificationTracker();

    // Validate, then edit resets it
    tracker.markValidationAttempt();
    tracker.resetValidation();
    expect(tracker.hasValidationAttempt()).toBe(false);

    // Validate again (post-edit) — should count
    tracker.markValidationAttempt();
    expect(tracker.hasValidationAttempt()).toBe(true);
    expect(tracker.shouldNudgeBeforeAllowingReport(true)).toBe(false);
  });
});
