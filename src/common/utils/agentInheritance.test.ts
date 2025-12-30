import { describe, expect, test } from "bun:test";
import {
  resolveAgentTools,
  agentHasTool,
  isPlanLike,
  isExecLike,
  resolveAgentProperty,
} from "./agentInheritance";

describe("resolveAgentTools", () => {
  test("returns agent's own tools when no base", () => {
    const agents = [{ id: "exec", tools: { add: ["bash", "file_.*"] } }] as const;
    expect(resolveAgentTools("exec", agents)).toEqual(["bash", "file_.*"]);
  });

  test("returns empty array for agent with no tools", () => {
    const agents = [{ id: "empty" }] as const;
    expect(resolveAgentTools("empty", agents)).toEqual([]);
  });

  test("inherits tools from base agent", () => {
    const agents = [
      { id: "exec", tools: { add: ["bash", "file_.*"] } },
      { id: "my-exec", base: "exec", tools: { add: ["custom_tool"] } },
    ] as const;
    const tools = resolveAgentTools("my-exec", agents);
    expect(tools).toContain("bash");
    expect(tools).toContain("file_.*");
    expect(tools).toContain("custom_tool");
  });

  test("multi-level inheritance", () => {
    const agents = [
      { id: "base", tools: { add: ["tool_a"] } },
      { id: "middle", base: "base", tools: { add: ["tool_b"] } },
      { id: "child", base: "middle", tools: { add: ["tool_c"] } },
    ] as const;
    const tools = resolveAgentTools("child", agents);
    expect(tools).toContain("tool_a");
    expect(tools).toContain("tool_b");
    expect(tools).toContain("tool_c");
  });

  test("child with no tools still inherits from parent", () => {
    const agents = [
      { id: "plan", tools: { add: ["propose_plan", "bash"] } },
      { id: "my-plan", base: "plan" }, // No tools defined
    ] as const;
    const tools = resolveAgentTools("my-plan", agents);
    expect(tools).toContain("propose_plan");
    expect(tools).toContain("bash");
  });

  test("handles missing base gracefully", () => {
    const agents = [{ id: "orphan", base: "missing", tools: { add: ["tool"] } }] as const;
    expect(resolveAgentTools("orphan", agents)).toEqual(["tool"]);
  });

  test("child can remove tools from base", () => {
    const agents = [
      { id: "exec", tools: { add: ["bash", "file_read", "file_edit"] } },
      { id: "read-only", base: "exec", tools: { remove: ["file_edit"] } },
    ] as const;
    const tools = resolveAgentTools("read-only", agents);
    expect(tools).toContain("bash");
    expect(tools).toContain("file_read");
    expect(tools).not.toContain("file_edit");
  });

  test("child can add and remove tools in same config", () => {
    const agents = [
      { id: "exec", tools: { add: ["bash", "task"] } },
      { id: "no-task", base: "exec", tools: { add: ["custom"], remove: ["task"] } },
    ] as const;
    const tools = resolveAgentTools("no-task", agents);
    expect(tools).toContain("bash");
    expect(tools).toContain("custom");
    expect(tools).not.toContain("task");
  });
});

describe("agentHasTool", () => {
  const agents = [
    { id: "exec", tools: { add: ["bash", "file_.*", "web_fetch"] } },
    { id: "plan", tools: { add: ["bash", "file_.*", "propose_plan", "ask_user_question"] } },
    { id: "wildcard", tools: { add: [".*"] } },
    { id: "wildcard-with-removes", tools: { add: [".*"], remove: ["propose_plan", "task"] } },
    { id: "no-tools", tools: { add: [] } },
    { id: "undefined-tools" }, // No tools field
  ] as const;

  test("exact match returns true", () => {
    expect(agentHasTool("exec", "bash", agents)).toBe(true);
    expect(agentHasTool("exec", "web_fetch", agents)).toBe(true);
    expect(agentHasTool("plan", "propose_plan", agents)).toBe(true);
  });

  test("regex pattern match returns true", () => {
    expect(agentHasTool("exec", "file_read", agents)).toBe(true);
    expect(agentHasTool("exec", "file_edit", agents)).toBe(true);
    expect(agentHasTool("plan", "file_edit_replace_string", agents)).toBe(true);
  });

  test("wildcard .* matches any tool", () => {
    expect(agentHasTool("wildcard", "anything", agents)).toBe(true);
    expect(agentHasTool("wildcard", "propose_plan", agents)).toBe(true);
    expect(agentHasTool("wildcard", "bash", agents)).toBe(true);
  });

  test("wildcard with removes excludes specific tools", () => {
    // Wildcard allows all, but removes should exclude specific tools
    expect(agentHasTool("wildcard-with-removes", "bash", agents)).toBe(true);
    expect(agentHasTool("wildcard-with-removes", "file_read", agents)).toBe(true);
    expect(agentHasTool("wildcard-with-removes", "propose_plan", agents)).toBe(false);
    expect(agentHasTool("wildcard-with-removes", "task", agents)).toBe(false);
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
      { id: "plan", tools: { add: ["propose_plan", "bash"] } },
      { id: "my-plan", base: "plan" }, // Inherits propose_plan
    ] as const;
    expect(agentHasTool("my-plan", "propose_plan", agentsWithInheritance)).toBe(true);
    expect(agentHasTool("my-plan", "bash", agentsWithInheritance)).toBe(true);
  });
});

describe("isPlanLike", () => {
  test("agent with propose_plan is plan-like", () => {
    const agents = [
      { id: "plan", tools: { add: ["bash", "file_.*", "propose_plan"] } },
      { id: "custom-plan", tools: { add: ["propose_plan", "todo_.*"] } },
    ] as const;
    expect(isPlanLike("plan", agents)).toBe(true);
    expect(isPlanLike("custom-plan", agents)).toBe(true);
  });

  test("agent with wildcard .* is plan-like", () => {
    const agents = [{ id: "wildcard", tools: { add: [".*"] } }] as const;
    expect(isPlanLike("wildcard", agents)).toBe(true);
  });

  test("agent without propose_plan is not plan-like", () => {
    const agents = [{ id: "exec", tools: { add: ["bash", "file_.*"] } }] as const;
    expect(isPlanLike("exec", agents)).toBe(false);
  });

  test("agent inheriting propose_plan from base is plan-like", () => {
    const agents = [
      { id: "plan", tools: { add: ["propose_plan"] } },
      { id: "my-plan", base: "plan" }, // Inherits propose_plan
    ] as const;
    expect(isPlanLike("my-plan", agents)).toBe(true);
  });

  test("agent that removes propose_plan from base is not plan-like", () => {
    const agents = [
      { id: "plan", tools: { add: ["propose_plan", "bash"] } },
      { id: "exec-from-plan", base: "plan", tools: { remove: ["propose_plan"] } },
    ] as const;
    expect(isPlanLike("exec-from-plan", agents)).toBe(false);
  });
});

describe("isExecLike", () => {
  const agents = [
    { id: "exec", tools: { add: ["bash", "file_.*"] } },
    { id: "plan", tools: { add: ["bash", "file_.*", "propose_plan"] } },
  ] as const;

  test("agent without propose_plan is exec-like", () => {
    expect(isExecLike("exec", agents)).toBe(true);
  });

  test("agent with propose_plan is not exec-like", () => {
    expect(isExecLike("plan", agents)).toBe(false);
  });
});

describe("resolveAgentProperty", () => {
  test("returns property from agent", () => {
    const agents = [{ id: "exec", uiColor: "#ff0000" }];
    expect(resolveAgentProperty("exec", "uiColor", agents)).toBe("#ff0000");
  });

  test("returns undefined when property not set", () => {
    const agents = [{ id: "exec" }];
    expect(resolveAgentProperty("exec", "uiColor", agents)).toBeUndefined();
  });

  test("inherits property from base agent", () => {
    const agents = [
      { id: "exec", uiColor: "var(--color-exec-mode)" },
      { id: "my-exec", base: "exec" },
    ];
    expect(resolveAgentProperty("my-exec", "uiColor", agents)).toBe("var(--color-exec-mode)");
  });

  test("child property overrides base property", () => {
    const agents = [
      { id: "exec", uiColor: "var(--color-exec-mode)" },
      { id: "custom", base: "exec", uiColor: "#custom" },
    ];
    expect(resolveAgentProperty("custom", "uiColor", agents)).toBe("#custom");
  });

  test("multi-level inheritance returns nearest defined value", () => {
    const agents = [
      { id: "base", uiColor: "#base" },
      { id: "middle", base: "base" }, // No uiColor
      { id: "child", base: "middle" }, // No uiColor
    ];
    expect(resolveAgentProperty("child", "uiColor", agents)).toBe("#base");
  });

  test("handles unknown agent gracefully", () => {
    const agents = [{ id: "exec", uiColor: "#ff0000" }];
    expect(resolveAgentProperty("unknown", "uiColor", agents)).toBeUndefined();
  });

  test("handles missing base gracefully", () => {
    const agents = [{ id: "orphan", base: "missing", uiColor: "#orphan" }];
    expect(resolveAgentProperty("orphan", "uiColor", agents)).toBe("#orphan");
  });
});
