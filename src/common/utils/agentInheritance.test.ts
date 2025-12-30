import { describe, expect, test } from "bun:test";
import { resolveAgentTools, agentHasTool, isPlanLike, isExecLike } from "./agentInheritance";

describe("resolveAgentTools", () => {
  test("returns agent's own tools when no base", () => {
    const agents = [{ id: "exec", tools: ["bash", "file_*"] }] as const;
    expect(resolveAgentTools("exec", agents)).toEqual(["bash", "file_*"]);
  });

  test("returns empty array for agent with no tools", () => {
    const agents = [{ id: "empty" }] as const;
    expect(resolveAgentTools("empty", agents)).toEqual([]);
  });

  test("inherits tools from base agent", () => {
    const agents = [
      { id: "exec", tools: ["bash", "file_*"] },
      { id: "my-exec", base: "exec", tools: ["custom_tool"] },
    ] as const;
    const tools = resolveAgentTools("my-exec", agents);
    expect(tools).toContain("bash");
    expect(tools).toContain("file_*");
    expect(tools).toContain("custom_tool");
  });

  test("multi-level inheritance", () => {
    const agents = [
      { id: "base", tools: ["tool_a"] },
      { id: "middle", base: "base", tools: ["tool_b"] },
      { id: "child", base: "middle", tools: ["tool_c"] },
    ] as const;
    const tools = resolveAgentTools("child", agents);
    expect(tools).toContain("tool_a");
    expect(tools).toContain("tool_b");
    expect(tools).toContain("tool_c");
  });

  test("child with no tools still inherits from parent", () => {
    const agents = [
      { id: "plan", tools: ["propose_plan", "bash"] },
      { id: "my-plan", base: "plan" }, // No tools defined
    ] as const;
    const tools = resolveAgentTools("my-plan", agents);
    expect(tools).toContain("propose_plan");
    expect(tools).toContain("bash");
  });

  test("handles missing base gracefully", () => {
    const agents = [{ id: "orphan", base: "missing", tools: ["tool"] }] as const;
    expect(resolveAgentTools("orphan", agents)).toEqual(["tool"]);
  });
});

describe("agentHasTool", () => {
  const agents = [
    { id: "exec", tools: ["bash", "file_*", "web_fetch"] },
    { id: "plan", tools: ["bash", "file_*", "propose_plan", "ask_user_question"] },
    { id: "wildcard", tools: ["*"] },
    { id: "no-tools", tools: [] },
    { id: "undefined-tools" }, // No tools field
  ] as const;

  test("exact match returns true", () => {
    expect(agentHasTool("exec", "bash", agents)).toBe(true);
    expect(agentHasTool("exec", "web_fetch", agents)).toBe(true);
    expect(agentHasTool("plan", "propose_plan", agents)).toBe(true);
  });

  test("glob pattern match returns true", () => {
    expect(agentHasTool("exec", "file_read", agents)).toBe(true);
    expect(agentHasTool("exec", "file_edit", agents)).toBe(true);
    expect(agentHasTool("plan", "file_edit_replace_string", agents)).toBe(true);
  });

  test("wildcard * matches any tool", () => {
    expect(agentHasTool("wildcard", "anything", agents)).toBe(true);
    expect(agentHasTool("wildcard", "propose_plan", agents)).toBe(true);
    expect(agentHasTool("wildcard", "bash", agents)).toBe(true);
  });

  test("no match returns false", () => {
    expect(agentHasTool("exec", "propose_plan", agents)).toBe(false);
    expect(agentHasTool("exec", "unknown_tool", agents)).toBe(false);
  });

  test("empty tools returns false", () => {
    expect(agentHasTool("no-tools", "bash", agents)).toBe(false);
  });

  test("undefined tools returns false", () => {
    expect(agentHasTool("undefined-tools", "bash", agents)).toBe(false);
  });

  test("unknown agent returns false", () => {
    expect(agentHasTool("unknown-agent", "bash", agents)).toBe(false);
  });

  test("inherits tools from base", () => {
    const agentsWithInheritance = [
      { id: "plan", tools: ["propose_plan", "bash"] },
      { id: "my-plan", base: "plan" }, // Inherits propose_plan
    ] as const;
    expect(agentHasTool("my-plan", "propose_plan", agentsWithInheritance)).toBe(true);
    expect(agentHasTool("my-plan", "bash", agentsWithInheritance)).toBe(true);
  });
});

describe("isPlanLike", () => {
  test("agent with propose_plan is plan-like", () => {
    const agents = [
      { id: "plan", tools: ["bash", "file_*", "propose_plan"] },
      { id: "custom-plan", tools: ["propose_plan", "todo_*"] },
    ] as const;
    expect(isPlanLike("plan", agents)).toBe(true);
    expect(isPlanLike("custom-plan", agents)).toBe(true);
  });

  test("agent with wildcard * is plan-like", () => {
    const agents = [{ id: "wildcard", tools: ["*"] }] as const;
    expect(isPlanLike("wildcard", agents)).toBe(true);
  });

  test("agent without propose_plan is not plan-like", () => {
    const agents = [{ id: "exec", tools: ["bash", "file_*"] }] as const;
    expect(isPlanLike("exec", agents)).toBe(false);
  });

  test("agent inheriting propose_plan from base is plan-like", () => {
    const agents = [
      { id: "plan", tools: ["propose_plan"] },
      { id: "my-plan", base: "plan" }, // Inherits propose_plan
    ] as const;
    expect(isPlanLike("my-plan", agents)).toBe(true);
  });
});

describe("isExecLike", () => {
  const agents = [
    { id: "exec", tools: ["bash", "file_*"] },
    { id: "plan", tools: ["bash", "file_*", "propose_plan"] },
  ] as const;

  test("agent without propose_plan is exec-like", () => {
    expect(isExecLike("exec", agents)).toBe(true);
  });

  test("agent with propose_plan is not exec-like", () => {
    expect(isExecLike("plan", agents)).toBe(false);
  });
});
