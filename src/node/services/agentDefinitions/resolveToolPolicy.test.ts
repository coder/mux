import { describe, expect, test } from "bun:test";

import type { AgentLikeForPolicy } from "./resolveToolPolicy";
import { resolveToolPolicyForAgent } from "./resolveToolPolicy";

// Test helper: agents array is ordered child → base (as returned by resolveAgentInheritanceChain)
describe("resolveToolPolicyForAgent", () => {
  test("no tools means all tools disabled", () => {
    const agents: AgentLikeForPolicy[] = [{}];
    const policy = resolveToolPolicyForAgent({
      agents,
      isSubagent: false,
      disableTaskToolsForDepth: false,
    });

    expect(policy).toEqual([{ regex_match: ".*", action: "disable" }]);
  });

  test("tools.add enables specified patterns", () => {
    const agents: AgentLikeForPolicy[] = [{ tools: { add: ["file_read", "bash.*"] } }];
    const policy = resolveToolPolicyForAgent({
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
    const agents: AgentLikeForPolicy[] = [{ tools: { add: ["propose_plan", "file_read"] } }];
    const policy = resolveToolPolicyForAgent({
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
    const agents: AgentLikeForPolicy[] = [{ tools: { add: ["task", "file_read"] } }];
    const policy = resolveToolPolicyForAgent({
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
    const agents: AgentLikeForPolicy[] = [{ tools: { add: ["task", "file_read"] } }];
    const policy = resolveToolPolicyForAgent({
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
    const agents: AgentLikeForPolicy[] = [{ tools: { add: [] } }];
    const policy = resolveToolPolicyForAgent({
      agents,
      isSubagent: false,
      disableTaskToolsForDepth: false,
    });

    expect(policy).toEqual([{ regex_match: ".*", action: "disable" }]);
  });

  test("whitespace in tool patterns is trimmed", () => {
    const agents: AgentLikeForPolicy[] = [{ tools: { add: ["  file_read  ", "  ", "bash"] } }];
    const policy = resolveToolPolicyForAgent({
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
      { tools: { add: ["file_read", "bash", "task"], remove: ["task"] } },
    ];
    const policy = resolveToolPolicyForAgent({
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
    // Chain: ask → exec (ordered child → base as returned by resolveAgentInheritanceChain)
    const agents: AgentLikeForPolicy[] = [
      { tools: { remove: ["file_edit_.*"] } }, // ask (child)
      { tools: { add: [".*"], remove: ["propose_plan"] } }, // exec (base)
    ];
    const policy = resolveToolPolicyForAgent({
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
    // Chain: leaf → middle → base (ordered child → base)
    const agents: AgentLikeForPolicy[] = [
      { tools: { remove: ["task"] } }, // leaf (child)
      { tools: { add: ["task"], remove: ["bash"] } }, // middle
      { tools: { add: ["file_read", "bash"] } }, // base
    ];
    const policy = resolveToolPolicyForAgent({
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
    // Chain: child → base (ordered child → base)
    const agents: AgentLikeForPolicy[] = [
      { tools: { add: ["bash"] } }, // child
      { tools: { add: ["file_read"] } }, // base
    ];
    const policy = resolveToolPolicyForAgent({
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
