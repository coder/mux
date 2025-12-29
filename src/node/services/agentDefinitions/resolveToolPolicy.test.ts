import { describe, expect, test } from "bun:test";

import { resolveToolPolicyForAgent } from "./resolveToolPolicy";

import type { AgentDefinitionFrontmatter } from "@/common/types/agentDefinition";

describe("resolveToolPolicyForAgent", () => {
  test("missing permissionMode denies all tools (exec)", () => {
    const policy = resolveToolPolicyForAgent({
      base: "exec",
      frontmatter: { name: "Test Agent" },
      isSubagent: false,
      disableTaskToolsForDepth: false,
    });

    expect(policy).toEqual([
      { regex_match: ".*", action: "disable" },
      { regex_match: "propose_plan", action: "disable" },
    ]);
  });

  test("permissionMode: default preserves prior exec baseline (hard-deny propose_plan)", () => {
    const frontmatter: AgentDefinitionFrontmatter = {
      name: "Test Agent",
      permissionMode: "default",
    };

    const policy = resolveToolPolicyForAgent({
      base: "exec",
      frontmatter,
      isSubagent: false,
      disableTaskToolsForDepth: false,
    });

    expect(policy).toEqual([{ regex_match: "propose_plan", action: "disable" }]);
  });

  test("permissionMode: default preserves prior plan baseline (no policy)", () => {
    const policy = resolveToolPolicyForAgent({
      base: "plan",
      frontmatter: { name: "Plan", permissionMode: "default" },
      isSubagent: false,
      disableTaskToolsForDepth: false,
    });

    expect(policy).toEqual([]);
  });

  test("permissionMode: readOnly enables only the read-only allowlist", () => {
    const policy = resolveToolPolicyForAgent({
      base: "exec",
      frontmatter: { name: "Read-only", permissionMode: "readOnly" },
      isSubagent: false,
      disableTaskToolsForDepth: false,
    });

    expect(policy).toEqual([
      { regex_match: ".*", action: "disable" },
      { regex_match: "file_read", action: "enable" },
      { regex_match: "agent_skill_read", action: "enable" },
      { regex_match: "agent_skill_read_file", action: "enable" },
      { regex_match: "web_fetch", action: "enable" },
      { regex_match: "propose_plan", action: "disable" },
    ]);
  });

  test("tools/disallowedTools compose with the permissionMode baseline", () => {
    const policy = resolveToolPolicyForAgent({
      base: "exec",
      frontmatter: {
        name: "Tweaks",
        permissionMode: "readOnly",
        tools: ["Edit"],
        disallowedTools: ["file_read"],
      },
      isSubagent: false,
      disableTaskToolsForDepth: false,
    });

    expect(policy).toEqual([
      { regex_match: ".*", action: "disable" },
      { regex_match: "file_read", action: "enable" },
      { regex_match: "agent_skill_read", action: "enable" },
      { regex_match: "agent_skill_read_file", action: "enable" },
      { regex_match: "web_fetch", action: "enable" },
      { regex_match: "file_edit_.*", action: "enable" },
      { regex_match: "file_read", action: "disable" },
      { regex_match: "propose_plan", action: "disable" },
    ]);
  });

  test("policy.tools.only is a ground-up allowlist override", () => {
    const policy = resolveToolPolicyForAgent({
      base: "exec",
      frontmatter: {
        name: "Allowlist",
        policy: { tools: { only: ["Bash", "propose_plan"] } },
      },
      isSubagent: false,
      disableTaskToolsForDepth: false,
    });

    expect(policy).toEqual([
      { regex_match: ".*", action: "disable" },
      { regex_match: "(?:bash|bash_output|bash_background_.*)", action: "enable" },
      { regex_match: "propose_plan", action: "disable" },
    ]);
  });

  test("compact always disables all tools", () => {
    const policy = resolveToolPolicyForAgent({
      base: "compact",
      frontmatter: {
        name: "Compact",
        permissionMode: "default",
        policy: { tools: { only: ["bash"] } },
      },
      isSubagent: false,
      disableTaskToolsForDepth: false,
    });

    expect(policy).toEqual([{ regex_match: ".*", action: "disable" }]);
  });

  test("subagents always hard-deny task recursion and propose_plan", () => {
    const policy = resolveToolPolicyForAgent({
      base: "plan",
      frontmatter: { name: "Subagent", permissionMode: "default" },
      isSubagent: true,
      disableTaskToolsForDepth: false,
    });

    expect(policy).toEqual([
      { regex_match: "task", action: "disable" },
      { regex_match: "task_.*", action: "disable" },
      { regex_match: "propose_plan", action: "disable" },
      { regex_match: "ask_user_question", action: "disable" },
      { regex_match: "agent_report", action: "enable" },
    ]);
  });

  test("subagents always allow agent_report (even when permissionMode is missing)", () => {
    const policy = resolveToolPolicyForAgent({
      base: "exec",
      frontmatter: { name: "Subagent" },
      isSubagent: true,
      disableTaskToolsForDepth: false,
    });

    expect(policy).toEqual([
      { regex_match: ".*", action: "disable" },
      { regex_match: "propose_plan", action: "disable" },
      { regex_match: "task", action: "disable" },
      { regex_match: "task_.*", action: "disable" },
      { regex_match: "propose_plan", action: "disable" },
      { regex_match: "ask_user_question", action: "disable" },
      { regex_match: "agent_report", action: "enable" },
    ]);
  });

  test("depth limit hard-denies task tools (even for the main agent)", () => {
    const policy = resolveToolPolicyForAgent({
      base: "exec",
      frontmatter: { name: "Depth", permissionMode: "default" },
      isSubagent: false,
      disableTaskToolsForDepth: true,
    });

    expect(policy).toEqual([
      { regex_match: "propose_plan", action: "disable" },
      { regex_match: "task", action: "disable" },
      { regex_match: "task_.*", action: "disable" },
    ]);
  });
});
