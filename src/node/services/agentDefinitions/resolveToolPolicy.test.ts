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

    expect(policy).toEqual([
      { regex_match: ".*", action: "disable" },
      { regex_match: "switch_agent", action: "disable" },
    ]);
  });

  test("switch_agent is disabled by default when not explicitly requested", () => {
    const agents: AgentLikeForPolicy[] = [{ tools: { add: ["file_read"] } }];
    const policy = resolveToolPolicyForAgent({
      agents,
      isSubagent: false,
      disableTaskToolsForDepth: false,
    });

    expect(policy).toEqual([
      { regex_match: ".*", action: "disable" },
      { regex_match: "file_read", action: "enable" },
      { regex_match: "switch_agent", action: "disable" },
    ]);
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
      { regex_match: "switch_agent", action: "disable" },
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
      { regex_match: "switch_agent", action: "disable" },
    ]);
  });

  test("top-level agents can explicitly re-enable switch_agent via tools.add", () => {
    const agents: AgentLikeForPolicy[] = [{ tools: { add: ["file_read", "switch_agent"] } }];
    const policy = resolveToolPolicyForAgent({
      agents,
      isSubagent: false,
      disableTaskToolsForDepth: false,
    });

    expect(policy).toEqual([
      { regex_match: ".*", action: "disable" },
      { regex_match: "file_read", action: "enable" },
      { regex_match: "switch_agent", action: "enable" },
      { regex_match: "switch_agent", action: "disable" },
      { regex_match: "switch_agent", action: "require" },
    ]);
  });

  test("top-level agents can require switch_agent via tools.require", () => {
    const agents: AgentLikeForPolicy[] = [{ tools: { require: ["switch_agent"] } }];
    const policy = resolveToolPolicyForAgent({
      agents,
      isSubagent: false,
      disableTaskToolsForDepth: false,
    });

    expect(policy).toEqual([
      { regex_match: ".*", action: "disable" },
      { regex_match: "switch_agent", action: "require" },
      { regex_match: "switch_agent", action: "disable" },
      { regex_match: "switch_agent", action: "require" },
    ]);
  });

  test("child tools.require overrides base tools.require", () => {
    // Chain: child → base
    const agents: AgentLikeForPolicy[] = [
      { tools: { require: ["agent_report"] } },
      { tools: { require: ["switch_agent"] } },
    ];
    const policy = resolveToolPolicyForAgent({
      agents,
      isSubagent: false,
      disableTaskToolsForDepth: false,
    });

    expect(policy).toEqual([
      { regex_match: ".*", action: "disable" },
      { regex_match: "agent_report", action: "require" },
      { regex_match: "switch_agent", action: "disable" },
    ]);
  });

  test("broad wildcard add does not implicitly unlock switch_agent", () => {
    const agents: AgentLikeForPolicy[] = [{ tools: { add: [".*"] } }];
    const policy = resolveToolPolicyForAgent({
      agents,
      isSubagent: false,
      disableTaskToolsForDepth: false,
    });

    expect(policy).toEqual([
      { regex_match: ".*", action: "disable" },
      { regex_match: ".*", action: "enable" },
      { regex_match: "switch_agent", action: "disable" },
    ]);
  });

  test("non-literal regex add that matches switch_agent does not unlock switch_agent", () => {
    const agents: AgentLikeForPolicy[] = [{ tools: { add: [".+"] } }];
    const policy = resolveToolPolicyForAgent({
      agents,
      isSubagent: false,
      disableTaskToolsForDepth: false,
    });

    expect(policy).toEqual([
      { regex_match: ".*", action: "disable" },
      { regex_match: ".+", action: "enable" },
      { regex_match: "switch_agent", action: "disable" },
    ]);
  });

  test("tools.require uses only the last entry in a layer", () => {
    const agents: AgentLikeForPolicy[] = [{ tools: { require: ["switch_agent", "agent_report"] } }];
    const policy = resolveToolPolicyForAgent({
      agents,
      isSubagent: false,
      disableTaskToolsForDepth: false,
    });

    expect(policy).toEqual([
      { regex_match: ".*", action: "disable" },
      { regex_match: "agent_report", action: "require" },
      { regex_match: "switch_agent", action: "disable" },
    ]);
  });

  test("regex-like tools.require entries are ignored", () => {
    const agents: AgentLikeForPolicy[] = [{ tools: { require: ["task_.*"] } }];
    const policy = resolveToolPolicyForAgent({
      agents,
      isSubagent: false,
      disableTaskToolsForDepth: false,
    });

    expect(policy).toEqual([
      { regex_match: ".*", action: "disable" },
      { regex_match: "switch_agent", action: "disable" },
    ]);
  });

  test("wildcard remove clears switch_agent enablement from earlier explicit add", () => {
    // Chain: child → base. Base explicitly enables switch_agent, then child strips all tools.
    const agents: AgentLikeForPolicy[] = [
      { tools: { remove: [".*"] } },
      { tools: { add: ["switch_agent"] } },
    ];
    const policy = resolveToolPolicyForAgent({
      agents,
      isSubagent: false,
      disableTaskToolsForDepth: false,
    });

    expect(policy).toEqual([
      { regex_match: ".*", action: "disable" },
      { regex_match: "switch_agent", action: "enable" },
      { regex_match: ".*", action: "disable" },
      { regex_match: "switch_agent", action: "disable" },
    ]);
  });

  test("subagents still hard-deny switch_agent even when explicitly requested", () => {
    const agents: AgentLikeForPolicy[] = [{ tools: { require: ["switch_agent"] } }];
    const policy = resolveToolPolicyForAgent({
      agents,
      isSubagent: true,
      disableTaskToolsForDepth: false,
    });

    expect(policy).toEqual([
      { regex_match: ".*", action: "disable" },
      { regex_match: "switch_agent", action: "disable" },
      { regex_match: "ask_user_question", action: "disable" },
      { regex_match: "switch_agent", action: "disable" },
      { regex_match: "propose_plan", action: "disable" },
      { regex_match: "agent_report", action: "require" },
    ]);
  });

  test("subagents skip require filters for hard-denied ask_user_question", () => {
    const agents: AgentLikeForPolicy[] = [{ tools: { require: ["ask_user_question"] } }];
    const policy = resolveToolPolicyForAgent({
      agents,
      isSubagent: true,
      disableTaskToolsForDepth: false,
    });

    expect(policy).toEqual([
      { regex_match: ".*", action: "disable" },
      { regex_match: "switch_agent", action: "disable" },
      { regex_match: "ask_user_question", action: "disable" },
      { regex_match: "switch_agent", action: "disable" },
      { regex_match: "propose_plan", action: "disable" },
      { regex_match: "agent_report", action: "require" },
    ]);
  });

  test("non-plan subagents disable propose_plan and allow agent_report", () => {
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
      { regex_match: "switch_agent", action: "disable" },
      { regex_match: "ask_user_question", action: "disable" },
      { regex_match: "switch_agent", action: "disable" },
      { regex_match: "propose_plan", action: "disable" },
      { regex_match: "agent_report", action: "require" },
    ]);
  });

  test("plan-like subagents enable propose_plan and disable agent_report", () => {
    const agents: AgentLikeForPolicy[] = [
      { tools: { add: ["propose_plan", "file_read", "agent_report"] } },
    ];
    const policy = resolveToolPolicyForAgent({
      agents,
      isSubagent: true,
      disableTaskToolsForDepth: false,
    });

    expect(policy).toEqual([
      { regex_match: ".*", action: "disable" },
      { regex_match: "propose_plan", action: "enable" },
      { regex_match: "file_read", action: "enable" },
      { regex_match: "agent_report", action: "enable" },
      { regex_match: "switch_agent", action: "disable" },
      { regex_match: "ask_user_question", action: "disable" },
      { regex_match: "switch_agent", action: "disable" },
      { regex_match: "propose_plan", action: "require" },
      { regex_match: "agent_report", action: "disable" },
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
      { regex_match: "switch_agent", action: "disable" },
    ]);
  });

  test("depth limit hard-denies task tools for subagents", () => {
    const agents: AgentLikeForPolicy[] = [{ tools: { add: ["task", "file_read"] } }];
    const policy = resolveToolPolicyForAgent({
      agents,
      isSubagent: true,
      disableTaskToolsForDepth: true,
    });

    expect(policy).toEqual([
      { regex_match: ".*", action: "disable" },
      { regex_match: "task", action: "enable" },
      { regex_match: "file_read", action: "enable" },
      { regex_match: "task", action: "disable" },
      { regex_match: "task_.*", action: "disable" },
      { regex_match: "switch_agent", action: "disable" },
      { regex_match: "ask_user_question", action: "disable" },
      { regex_match: "switch_agent", action: "disable" },
      { regex_match: "propose_plan", action: "disable" },
      { regex_match: "agent_report", action: "require" },
    ]);
  });

  test("empty tools.add array means no tools", () => {
    const agents: AgentLikeForPolicy[] = [{ tools: { add: [] } }];
    const policy = resolveToolPolicyForAgent({
      agents,
      isSubagent: false,
      disableTaskToolsForDepth: false,
    });

    expect(policy).toEqual([
      { regex_match: ".*", action: "disable" },
      { regex_match: "switch_agent", action: "disable" },
    ]);
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
      { regex_match: "switch_agent", action: "disable" },
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
      { regex_match: "switch_agent", action: "disable" },
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
      { regex_match: "switch_agent", action: "disable" },
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
      { regex_match: "switch_agent", action: "disable" },
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
      { regex_match: "switch_agent", action: "disable" },
    ]);
  });
});
