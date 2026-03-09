import { beforeEach, describe, expect, test } from "bun:test";

import { clearBuiltInAgentCache, getBuiltInAgentDefinitions } from "./builtInAgentDefinitions";

describe("built-in agent definitions", () => {
  beforeEach(() => {
    clearBuiltInAgentCache();
  });

  test("includes auto router built-in", () => {
    const pkgs = getBuiltInAgentDefinitions();
    const byId = new Map(pkgs.map((pkg) => [pkg.id, pkg] as const));

    const auto = byId.get("auto");
    expect(auto).toBeTruthy();
    expect(auto?.frontmatter.base).toBeUndefined();
    expect(auto?.frontmatter.tools?.require ?? []).toContain("switch_agent");
  });

  test("includes orchestrator with expected flags", () => {
    const pkgs = getBuiltInAgentDefinitions();
    const byId = new Map(pkgs.map((pkg) => [pkg.id, pkg] as const));

    const orchestrator = byId.get("orchestrator");
    expect(orchestrator).toBeTruthy();
    expect(orchestrator?.frontmatter.ui?.requires).toEqual(["plan"]);
    expect(orchestrator?.frontmatter.ui?.hidden).toBeUndefined();
    expect(orchestrator?.frontmatter.subagent?.append_prompt).toContain(
      "Do NOT create pull requests"
    );
    expect(orchestrator?.frontmatter.subagent?.runnable).toBe(false);
  });

  test("explore agent allows skill tools", () => {
    const pkgs = getBuiltInAgentDefinitions();
    const byId = new Map(pkgs.map((pkg) => [pkg.id, pkg] as const));

    const explore = byId.get("explore");
    expect(explore).toBeTruthy();
    const removed = explore?.frontmatter.tools?.remove ?? [];
    expect(removed).not.toContain("agent_skill_read");
    expect(removed).not.toContain("agent_skill_read_file");
  });

  test("analytics_query is restricted to the mux (Chat With Mux) agent", () => {
    const pkgs = getBuiltInAgentDefinitions();
    const byId = new Map(pkgs.map((pkg) => [pkg.id, pkg] as const));

    const mux = byId.get("mux");
    expect(mux).toBeTruthy();
    expect(mux?.frontmatter.tools?.add ?? []).toContain("analytics_query");

    const exec = byId.get("exec");
    expect(exec).toBeTruthy();
    expect(exec?.frontmatter.tools?.remove ?? []).toContain("analytics_query");

    const plan = byId.get("plan");
    expect(plan).toBeTruthy();
    expect(plan?.frontmatter.tools?.remove ?? []).toContain("analytics_query");
  });

  test("task_apply_git_patch is restricted to exec/orchestrator", () => {
    const pkgs = getBuiltInAgentDefinitions();
    const byId = new Map(pkgs.map((pkg) => [pkg.id, pkg] as const));

    const exec = byId.get("exec");
    expect(exec).toBeTruthy();
    expect(exec?.frontmatter.tools?.remove ?? []).not.toContain("task_apply_git_patch");

    const orchestrator = byId.get("orchestrator");
    expect(orchestrator).toBeTruthy();
    expect(orchestrator?.frontmatter.tools?.remove ?? []).not.toContain("task_apply_git_patch");

    const plan = byId.get("plan");
    expect(plan).toBeTruthy();
    expect(plan?.frontmatter.tools?.remove ?? []).toContain("task_apply_git_patch");

    const explore = byId.get("explore");
    expect(explore).toBeTruthy();
    expect(explore?.frontmatter.tools?.remove ?? []).toContain("task_apply_git_patch");
  });
});
