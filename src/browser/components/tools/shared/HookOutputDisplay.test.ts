import { describe, test, expect } from "bun:test";
import { extractHookOutput } from "./HookOutputDisplay";

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
