import { describe, expect, test } from "bun:test";
import { agentHasTool, isPlanLike, isExecLike } from "./agentInheritance";

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
});

describe("isPlanLike", () => {
  const agents = [
    { id: "exec", tools: ["bash", "file_*"] },
    { id: "plan", tools: ["bash", "file_*", "propose_plan"] },
    { id: "custom-plan", tools: ["propose_plan", "todo_*"] },
    { id: "wildcard", tools: ["*"] },
  ] as const;

  test("agent with propose_plan is plan-like", () => {
    expect(isPlanLike("plan", agents)).toBe(true);
    expect(isPlanLike("custom-plan", agents)).toBe(true);
  });

  test("agent with wildcard * is plan-like", () => {
    expect(isPlanLike("wildcard", agents)).toBe(true);
  });

  test("agent without propose_plan is not plan-like", () => {
    expect(isPlanLike("exec", agents)).toBe(false);
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
