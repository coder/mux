import { describe, expect, test } from "bun:test";

import { resolveToolPolicyForAgent } from "./resolveToolPolicy";

import type { AgentDefinitionFrontmatter } from "@/common/types/agentDefinition";

const baseFrontmatter: AgentDefinitionFrontmatter = { name: "Test Agent" };

describe("resolveToolPolicyForAgent", () => {
  test("exec baseline disables propose_plan", () => {
    const policy = resolveToolPolicyForAgent({
      base: "exec",
      frontmatter: baseFrontmatter,
      isSubagent: false,
      disableTaskToolsForDepth: false,
    });

    expect(policy).toEqual([{ regex_match: "propose_plan", action: "disable" }]);
  });

  test("compact always disables all tools", () => {
    const policy = resolveToolPolicyForAgent({
      base: "compact",
      frontmatter: {
        name: "Compact",
        policy: { tools: { only: ["bash"] } },
      },
      isSubagent: false,
      disableTaskToolsForDepth: false,
    });

    expect(policy).toEqual([{ regex_match: ".*", action: "disable" }]);
  });

  test("tools.only disables everything then enables the allowlist (cannot re-enable propose_plan in exec)", () => {
    const policy = resolveToolPolicyForAgent({
      base: "exec",
      frontmatter: {
        name: "Allowlist",
        policy: { tools: { only: ["bash", "propose_plan"] } },
      },
      isSubagent: false,
      disableTaskToolsForDepth: false,
    });

    expect(policy).toEqual([
      { regex_match: ".*", action: "disable" },
      { regex_match: "bash", action: "enable" },
    ]);
  });

  test("tools.deny disables listed tools and applies baseline denies last", () => {
    const policy = resolveToolPolicyForAgent({
      base: "exec",
      frontmatter: {
        name: "Deny",
        policy: { tools: { deny: ["bash"] } },
      },
      isSubagent: false,
      disableTaskToolsForDepth: false,
    });

    expect(policy).toEqual([
      { regex_match: "bash", action: "disable" },
      { regex_match: "propose_plan", action: "disable" },
    ]);
  });

  test("subagents always hard-deny task recursion and propose_plan", () => {
    const policy = resolveToolPolicyForAgent({
      base: "plan",
      frontmatter: baseFrontmatter,
      isSubagent: true,
      disableTaskToolsForDepth: false,
    });

    expect(policy).toEqual([
      { regex_match: "task", action: "disable" },
      { regex_match: "task_.*", action: "disable" },
      { regex_match: "propose_plan", action: "disable" },
      { regex_match: "ask_user_question", action: "disable" },
    ]);
  });

  test("depth limit hard-denies task tools (even for the main agent)", () => {
    const policy = resolveToolPolicyForAgent({
      base: "exec",
      frontmatter: baseFrontmatter,
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
