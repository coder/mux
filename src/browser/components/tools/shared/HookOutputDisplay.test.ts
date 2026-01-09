import { describe, test, expect } from "bun:test";
import { extractHookOutput, extractHookDuration } from "./HookOutputDisplay";

describe("extractHookOutput", () => {
  test("returns null for null input", () => {
    expect(extractHookOutput(null)).toBeNull();
  });

  test("returns null for undefined input", () => {
    expect(extractHookOutput(undefined)).toBeNull();
  });

  test("returns null for non-object input", () => {
    expect(extractHookOutput("string")).toBeNull();
    expect(extractHookOutput(42)).toBeNull();
    expect(extractHookOutput(true)).toBeNull();
  });

  test("returns null when hook_output is missing", () => {
    expect(extractHookOutput({ success: true })).toBeNull();
    expect(extractHookOutput({ output: "some output" })).toBeNull();
  });

  test("returns null when hook_output is empty string", () => {
    expect(extractHookOutput({ hook_output: "" })).toBeNull();
  });

  test("returns null when hook_output is not a string", () => {
    expect(extractHookOutput({ hook_output: 123 })).toBeNull();
    expect(extractHookOutput({ hook_output: null })).toBeNull();
    expect(extractHookOutput({ hook_output: { nested: true } })).toBeNull();
  });

  test("extracts hook_output when present and non-empty", () => {
    expect(extractHookOutput({ hook_output: "lint errors found" })).toBe("lint errors found");
    expect(extractHookOutput({ success: true, hook_output: "formatter ran" })).toBe(
      "formatter ran"
    );
  });

  test("extracts hook_output with multiline content", () => {
    const multiline = "Line 1\nLine 2\nLine 3";
    expect(extractHookOutput({ hook_output: multiline })).toBe(multiline);
  });
});

describe("extractHookDuration", () => {
  test("returns undefined for null input", () => {
    expect(extractHookDuration(null)).toBeUndefined();
  });

  test("returns undefined for undefined input", () => {
    expect(extractHookDuration(undefined)).toBeUndefined();
  });

  test("returns undefined for non-object input", () => {
    expect(extractHookDuration("string")).toBeUndefined();
    expect(extractHookDuration(42)).toBeUndefined();
    expect(extractHookDuration(true)).toBeUndefined();
  });

  test("returns undefined when hook_duration_ms is missing", () => {
    expect(extractHookDuration({ success: true })).toBeUndefined();
    expect(extractHookDuration({ hook_output: "output" })).toBeUndefined();
  });

  test("returns undefined when hook_duration_ms is not a number", () => {
    expect(extractHookDuration({ hook_duration_ms: "123" })).toBeUndefined();
    expect(extractHookDuration({ hook_duration_ms: null })).toBeUndefined();
    expect(extractHookDuration({ hook_duration_ms: {} })).toBeUndefined();
  });

  test("returns undefined for non-finite numbers", () => {
    expect(extractHookDuration({ hook_duration_ms: NaN })).toBeUndefined();
    expect(extractHookDuration({ hook_duration_ms: Infinity })).toBeUndefined();
    expect(extractHookDuration({ hook_duration_ms: -Infinity })).toBeUndefined();
  });

  test("extracts hook_duration_ms when present and valid", () => {
    expect(extractHookDuration({ hook_duration_ms: 123 })).toBe(123);
    expect(extractHookDuration({ hook_duration_ms: 0 })).toBe(0);
    expect(extractHookDuration({ hook_duration_ms: 5000 })).toBe(5000);
  });

  test("extracts hook_duration_ms alongside other fields", () => {
    expect(
      extractHookDuration({ hook_output: "output", hook_duration_ms: 456, success: true })
    ).toBe(456);
  });
});
