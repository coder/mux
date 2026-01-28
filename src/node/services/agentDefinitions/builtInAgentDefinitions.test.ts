import { beforeEach, describe, expect, test } from "bun:test";

import { clearBuiltInAgentCache, getBuiltInAgentDefinitions } from "./builtInAgentDefinitions";

describe("built-in agent definitions", () => {
  beforeEach(() => {
    clearBuiltInAgentCache();
  });

  test("includes orchestrator and implementor with expected flags", () => {
    const pkgs = getBuiltInAgentDefinitions();
    const byId = new Map(pkgs.map((pkg) => [pkg.id, pkg] as const));

    const orchestrator = byId.get("orchestrator");
    expect(orchestrator).toBeTruthy();
    expect(orchestrator?.frontmatter.ui?.hidden).toBe(true);
    expect(orchestrator?.frontmatter.subagent?.runnable).toBe(false);

    const implementor = byId.get("implementor");
    expect(implementor).toBeTruthy();
    expect(implementor?.frontmatter.ui?.hidden).toBe(true);
    expect(implementor?.frontmatter.subagent?.runnable).toBe(true);
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

    const implementor = byId.get("implementor");
    expect(implementor).toBeTruthy();
    expect(implementor?.frontmatter.tools?.remove ?? []).toContain("task_apply_git_patch");
  });
});
