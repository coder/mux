import { describe, expect, test } from "bun:test";

import type { AgentLikeForPolicy } from "./resolveToolPolicy";
import { resolveToolPolicyForAgent } from "./resolveToolPolicy";

describe("resolveToolPolicyForAgent", () => {
  test("no tools means all tools disabled", () => {
    const agents: AgentLikeForPolicy[] = [{ id: "test" }];
    const policy = resolveToolPolicyForAgent({
      agentId: "test",
      agents,
      isSubagent: false,
      disableTaskToolsForDepth: false,
    });

    expect(policy).toEqual([{ regex_match: ".*", action: "disable" }]);
  });

  test("tools.add enables specified patterns", () => {
    const agents: AgentLikeForPolicy[] = [{ id: "test", tools: { add: ["file_read", "bash.*"] } }];
    const policy = resolveToolPolicyForAgent({
      agentId: "test",
      agents,
      isSubagent: false,
      disableTaskToolsForDepth: false,
    });

    expect(policy).toEqual([
      { regex_match: ".*", action: "disable" },
      { regex_match: "file_read", action: "enable" },
      { regex_match: "bash.*", action: "enable" },
    ]);
  });

  test("agents can include propose_plan in tools", () => {
    const agents: AgentLikeForPolicy[] = [
      { id: "my-plan", tools: { add: ["propose_plan", "file_read"] } },
    ];
    const policy = resolveToolPolicyForAgent({
      agentId: "my-plan",
      agents,
      isSubagent: false,
      disableTaskToolsForDepth: false,
    });

    expect(policy).toEqual([
      { regex_match: ".*", action: "disable" },
      { regex_match: "propose_plan", action: "enable" },
      { regex_match: "file_read", action: "enable" },
    ]);
  });

  test("subagents hard-deny task recursion and always allow agent_report", () => {
    const agents: AgentLikeForPolicy[] = [
      { id: "subagent", tools: { add: ["task", "file_read"] } },
    ];
    const policy = resolveToolPolicyForAgent({
      agentId: "subagent",
      agents,
      isSubagent: true,
      disableTaskToolsForDepth: false,
    });

    expect(policy).toEqual([
      { regex_match: ".*", action: "disable" },
      { regex_match: "task", action: "enable" },
      { regex_match: "file_read", action: "enable" },
      { regex_match: "task", action: "disable" },
      { regex_match: "task_.*", action: "disable" },
      { regex_match: "propose_plan", action: "disable" },
      { regex_match: "ask_user_question", action: "disable" },
      { regex_match: "agent_report", action: "enable" },
    ]);
  });

  test("depth limit hard-denies task tools", () => {
    const agents: AgentLikeForPolicy[] = [{ id: "exec", tools: { add: ["task", "file_read"] } }];
    const policy = resolveToolPolicyForAgent({
      agentId: "exec",
      agents,
      isSubagent: false,
      disableTaskToolsForDepth: true,
    });

    expect(policy).toEqual([
      { regex_match: ".*", action: "disable" },
      { regex_match: "task", action: "enable" },
      { regex_match: "file_read", action: "enable" },
      { regex_match: "task", action: "disable" },
      { regex_match: "task_.*", action: "disable" },
    ]);
  });

  test("empty tools.add array means no tools", () => {
    const agents: AgentLikeForPolicy[] = [{ id: "empty", tools: { add: [] } }];
    const policy = resolveToolPolicyForAgent({
      agentId: "empty",
      agents,
      isSubagent: false,
      disableTaskToolsForDepth: false,
    });

    expect(policy).toEqual([{ regex_match: ".*", action: "disable" }]);
  });

  test("whitespace in tool patterns is trimmed", () => {
    const agents: AgentLikeForPolicy[] = [
      { id: "test", tools: { add: ["  file_read  ", "  ", "bash"] } },
    ];
    const policy = resolveToolPolicyForAgent({
      agentId: "test",
      agents,
      isSubagent: false,
      disableTaskToolsForDepth: false,
    });

    expect(policy).toEqual([
      { regex_match: ".*", action: "disable" },
      { regex_match: "file_read", action: "enable" },
      { regex_match: "bash", action: "enable" },
    ]);
  });

  test("tools.remove disables specified patterns", () => {
    const agents: AgentLikeForPolicy[] = [
      { id: "test", tools: { add: ["file_read", "bash", "task"], remove: ["task"] } },
    ];
    const policy = resolveToolPolicyForAgent({
      agentId: "test",
      agents,
      isSubagent: false,
      disableTaskToolsForDepth: false,
    });

    expect(policy).toEqual([
      { regex_match: ".*", action: "disable" },
      { regex_match: "file_read", action: "enable" },
      { regex_match: "bash", action: "enable" },
      { regex_match: "task", action: "enable" },
      { regex_match: "task", action: "disable" },
    ]);
  });

  test("inherits tools from base agent", () => {
    const agents: AgentLikeForPolicy[] = [
      { id: "exec", tools: { add: [".*"], remove: ["propose_plan"] } },
      { id: "ask", base: "exec", tools: { remove: ["file_edit_.*"] } },
    ];
    const policy = resolveToolPolicyForAgent({
      agentId: "ask",
      agents,
      isSubagent: false,
      disableTaskToolsForDepth: false,
    });

    // exec: deny-all → enable .* → disable propose_plan
    // ask: → disable file_edit_.*
    expect(policy).toEqual([
      { regex_match: ".*", action: "disable" },
      { regex_match: ".*", action: "enable" },
      { regex_match: "propose_plan", action: "disable" },
      { regex_match: "file_edit_.*", action: "disable" },
    ]);
  });

  test("multi-level inheritance", () => {
    const agents: AgentLikeForPolicy[] = [
      { id: "base", tools: { add: ["file_read", "bash"] } },
      { id: "middle", base: "base", tools: { add: ["task"], remove: ["bash"] } },
      { id: "leaf", base: "middle", tools: { remove: ["task"] } },
    ];
    const policy = resolveToolPolicyForAgent({
      agentId: "leaf",
      agents,
      isSubagent: false,
      disableTaskToolsForDepth: false,
    });

    // base: deny-all → enable file_read → enable bash
    // middle: → enable task → disable bash
    // leaf: → disable task
    expect(policy).toEqual([
      { regex_match: ".*", action: "disable" },
      { regex_match: "file_read", action: "enable" },
      { regex_match: "bash", action: "enable" },
      { regex_match: "task", action: "enable" },
      { regex_match: "bash", action: "disable" },
      { regex_match: "task", action: "disable" },
    ]);
  });

  test("child can add tools not in base", () => {
    const agents: AgentLikeForPolicy[] = [
      { id: "base", tools: { add: ["file_read"] } },
      { id: "child", base: "base", tools: { add: ["bash"] } },
    ];
    const policy = resolveToolPolicyForAgent({
      agentId: "child",
      agents,
      isSubagent: false,
      disableTaskToolsForDepth: false,
    });

    expect(policy).toEqual([
      { regex_match: ".*", action: "disable" },
      { regex_match: "file_read", action: "enable" },
      { regex_match: "bash", action: "enable" },
    ]);
  });
});
