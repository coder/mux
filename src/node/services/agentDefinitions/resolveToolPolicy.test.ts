import { describe, expect, test } from "bun:test";

import { resolveToolPolicyForAgent } from "./resolveToolPolicy";

describe("resolveToolPolicyForAgent", () => {
  test("no tools means all tools disabled", () => {
    const policy = resolveToolPolicyForAgent({
      agentId: "test",
      frontmatter: { name: "Test Agent" },
      isSubagent: false,
      disableTaskToolsForDepth: false,
    });

    expect(policy).toEqual([{ regex_match: ".*", action: "disable" }]);
  });

  test("tools.add enables specified patterns", () => {
    const policy = resolveToolPolicyForAgent({
      agentId: "test",
      frontmatter: {
        name: "Test Agent",
        tools: { add: ["file_read", "bash.*"] },
      },
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
    const policy = resolveToolPolicyForAgent({
      agentId: "my-plan",
      frontmatter: {
        name: "My Plan",
        tools: { add: ["propose_plan", "file_read"] },
      },
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
    const policy = resolveToolPolicyForAgent({
      agentId: "subagent",
      frontmatter: {
        name: "Subagent",
        tools: { add: ["task", "file_read"] },
      },
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
    const policy = resolveToolPolicyForAgent({
      agentId: "exec",
      frontmatter: {
        name: "Exec",
        tools: { add: ["task", "file_read"] },
      },
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
    const policy = resolveToolPolicyForAgent({
      agentId: "empty",
      frontmatter: {
        name: "Empty",
        tools: { add: [] },
      },
      isSubagent: false,
      disableTaskToolsForDepth: false,
    });

    expect(policy).toEqual([{ regex_match: ".*", action: "disable" }]);
  });

  test("whitespace in tool patterns is trimmed", () => {
    const policy = resolveToolPolicyForAgent({
      agentId: "test",
      frontmatter: {
        name: "Test",
        tools: { add: ["  file_read  ", "  ", "bash"] },
      },
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
    const policy = resolveToolPolicyForAgent({
      agentId: "test",
      frontmatter: {
        name: "Test",
        tools: { add: ["file_read", "bash", "task"], remove: ["task"] },
      },
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
});
