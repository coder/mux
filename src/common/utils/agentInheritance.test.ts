import { describe, expect, test } from "bun:test";
import { inheritsFrom, isPlanLike, isExecLike } from "./agentInheritance";

describe("inheritsFrom", () => {
  const agents = [
    { id: "exec" },
    { id: "plan" },
    { id: "compact" },
    { id: "explore", base: "exec" },
    { id: "my-plan", base: "plan" },
    { id: "my-sub-plan", base: "my-plan" }, // Three-layer: my-sub-plan → my-plan → plan
    { id: "custom-exec", base: "exec" },
    { id: "deep-exec", base: "custom-exec" }, // Three-layer: deep-exec → custom-exec → exec
  ] as const;

  test("self-match returns true", () => {
    expect(inheritsFrom("exec", "exec", agents)).toBe(true);
    expect(inheritsFrom("plan", "plan", agents)).toBe(true);
    expect(inheritsFrom("compact", "compact", agents)).toBe(true);
  });

  test("direct base match returns true", () => {
    expect(inheritsFrom("explore", "exec", agents)).toBe(true);
    expect(inheritsFrom("my-plan", "plan", agents)).toBe(true);
    expect(inheritsFrom("custom-exec", "exec", agents)).toBe(true);
  });

  test("three-layer inheritance returns true", () => {
    // my-sub-plan → my-plan → plan
    expect(inheritsFrom("my-sub-plan", "plan", agents)).toBe(true);
    expect(inheritsFrom("my-sub-plan", "my-plan", agents)).toBe(true);

    // deep-exec → custom-exec → exec
    expect(inheritsFrom("deep-exec", "exec", agents)).toBe(true);
    expect(inheritsFrom("deep-exec", "custom-exec", agents)).toBe(true);
  });

  test("unrelated agents return false", () => {
    expect(inheritsFrom("exec", "plan", agents)).toBe(false);
    expect(inheritsFrom("plan", "exec", agents)).toBe(false);
    expect(inheritsFrom("explore", "plan", agents)).toBe(false);
    expect(inheritsFrom("my-plan", "exec", agents)).toBe(false);
  });

  test("unknown agent returns false", () => {
    expect(inheritsFrom("unknown-agent", "plan", agents)).toBe(false);
    expect(inheritsFrom("exec", "unknown-target", agents)).toBe(false);
  });

  test("maxDepth prevents infinite loops", () => {
    // Create a circular reference (should be prevented by schema, but defense in depth)
    const circular = [
      { id: "a", base: "b" },
      { id: "b", base: "c" },
      { id: "c", base: "a" }, // Circular!
    ] as const;

    // Should terminate without hanging, returning false since target not found within depth
    expect(inheritsFrom("a", "target", circular, 5)).toBe(false);
  });

  test("agent not in collection returns false for unknown agent", () => {
    const agents = [{ id: "exec" }] as const;

    // Unknown agent should return false
    expect(inheritsFrom("unknown", "exec", agents)).toBe(false);
  });

  test("orphan agent can still match its declared base", () => {
    // Agent declares a base that doesn't exist in the collection
    // This still returns true for direct base match
    const partial = [{ id: "orphan", base: "missing-parent" }] as const;

    // Direct base match works even if base isn't in collection
    expect(inheritsFrom("orphan", "missing-parent", partial)).toBe(true);
    // But can't traverse further since missing-parent isn't defined
    expect(inheritsFrom("orphan", "grandparent", partial)).toBe(false);
  });
});

describe("isPlanLike", () => {
  const agents = [
    { id: "exec" },
    { id: "plan" },
    { id: "my-plan", base: "plan" },
    { id: "my-sub-plan", base: "my-plan" },
    { id: "explore", base: "exec" },
  ] as const;

  test("plan is plan-like", () => {
    expect(isPlanLike("plan", agents)).toBe(true);
  });

  test("agents inheriting from plan are plan-like", () => {
    expect(isPlanLike("my-plan", agents)).toBe(true);
    expect(isPlanLike("my-sub-plan", agents)).toBe(true);
  });

  test("exec and exec-derived are not plan-like", () => {
    expect(isPlanLike("exec", agents)).toBe(false);
    expect(isPlanLike("explore", agents)).toBe(false);
  });
});

describe("isExecLike", () => {
  const agents = [
    { id: "exec" },
    { id: "plan" },
    { id: "my-plan", base: "plan" },
    { id: "explore", base: "exec" },
  ] as const;

  test("exec and exec-derived are exec-like", () => {
    expect(isExecLike("exec", agents)).toBe(true);
    expect(isExecLike("explore", agents)).toBe(true);
  });

  test("plan and plan-derived are not exec-like", () => {
    expect(isExecLike("plan", agents)).toBe(false);
    expect(isExecLike("my-plan", agents)).toBe(false);
  });
});
