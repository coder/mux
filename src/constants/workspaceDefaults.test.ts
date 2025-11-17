import { describe, test, expect } from "bun:test";
import { WORKSPACE_DEFAULTS } from "./workspaceDefaults";

type Mutable<T> = { -readonly [P in keyof T]: T[P] };

describe("WORKSPACE_DEFAULTS", () => {
  test("should have all expected keys", () => {
    expect(WORKSPACE_DEFAULTS).toHaveProperty("mode");
    expect(WORKSPACE_DEFAULTS).toHaveProperty("thinkingLevel");
    expect(WORKSPACE_DEFAULTS).toHaveProperty("model");
    expect(WORKSPACE_DEFAULTS).toHaveProperty("autoRetry");
    expect(WORKSPACE_DEFAULTS).toHaveProperty("input");
  });

  test("should have correct default values", () => {
    expect(WORKSPACE_DEFAULTS.mode).toBe("exec");
    expect(WORKSPACE_DEFAULTS.thinkingLevel).toBe("off");
    expect(WORKSPACE_DEFAULTS.model).toBe("anthropic:claude-sonnet-4-5");
    expect(WORKSPACE_DEFAULTS.autoRetry).toBe(true);
    expect(WORKSPACE_DEFAULTS.input).toBe("");
  });

  test("should have correct types", () => {
    expect(typeof WORKSPACE_DEFAULTS.mode).toBe("string");
    expect(typeof WORKSPACE_DEFAULTS.thinkingLevel).toBe("string");
    expect(typeof WORKSPACE_DEFAULTS.model).toBe("string");
    expect(typeof WORKSPACE_DEFAULTS.autoRetry).toBe("boolean");
    expect(typeof WORKSPACE_DEFAULTS.input).toBe("string");
  });

  test("should be frozen to prevent modification", () => {
    expect(Object.isFrozen(WORKSPACE_DEFAULTS)).toBe(true);
  });

  test("should prevent modification attempts (immutability)", () => {
    // Frozen objects silently fail in non-strict mode, throw in strict mode
    // We just verify the object is frozen - TypeScript prevents modification at compile time
    const originalMode = WORKSPACE_DEFAULTS.mode;
    const mutableDefaults = WORKSPACE_DEFAULTS as Mutable<typeof WORKSPACE_DEFAULTS>;
    try {
      mutableDefaults.mode = "plan";
    } catch {
      // Expected in strict mode
    }
    // Value should remain unchanged
    expect(WORKSPACE_DEFAULTS.mode).toBe(originalMode);
  });

  test("mode should be valid UIMode", () => {
    const validModes = ["exec", "plan"];
    expect(validModes).toContain(WORKSPACE_DEFAULTS.mode);
  });

  test("thinkingLevel should be valid ThinkingLevel", () => {
    const validLevels = ["off", "low", "medium", "high"];
    expect(validLevels).toContain(WORKSPACE_DEFAULTS.thinkingLevel);
  });

  test("model should follow provider:model format", () => {
    expect(WORKSPACE_DEFAULTS.model).toMatch(/^[a-z]+:[a-z0-9-]+$/);
  });

  test("autoRetry should be boolean", () => {
    expect(typeof WORKSPACE_DEFAULTS.autoRetry).toBe("boolean");
  });

  test("input should be empty string", () => {
    expect(WORKSPACE_DEFAULTS.input).toBe("");
    expect(WORKSPACE_DEFAULTS.input).toHaveLength(0);
  });
});
