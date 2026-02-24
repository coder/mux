import { beforeEach, describe, expect, test } from "bun:test";

import { clearBuiltInAgentCache, getBuiltInAgentDefinitions } from "./builtInAgentDefinitions";

describe("built-in agent definitions", () => {
  beforeEach(() => {
    clearBuiltInAgentCache();
  });

  test("exec and orchestrator trust Explore sub-agent reports", () => {
    const pkgs = getBuiltInAgentDefinitions();
    const byId = new Map(pkgs.map((pkg) => [pkg.id, pkg] as const));

    const exec = byId.get("exec");
    expect(exec).toBeTruthy();
    expect(exec?.body).toContain("sub-agent reports as authoritative for repo facts");
    expect(exec?.body).toContain("counts as having read the referenced files");

    const orchestrator = byId.get("orchestrator");
    expect(orchestrator).toBeTruthy();
    expect(orchestrator?.body).toContain("sub-agent reports as authoritative for repo facts");
    expect(orchestrator?.body).toContain("counts as having read the referenced files");
  });

  test("includes auto router built-in", () => {
    const pkgs = getBuiltInAgentDefinitions();
    const byId = new Map(pkgs.map((pkg) => [pkg.id, pkg] as const));

    const auto = byId.get("auto");
    expect(auto).toBeTruthy();
    expect(auto?.frontmatter.tools?.remove ?? []).toContain(".*");
    expect(auto?.body).toContain("Immediately call `switch_agent`");
  });

  test("orchestrator includes an exec task brief template", () => {
    const pkgs = getBuiltInAgentDefinitions();
    const byId = new Map(pkgs.map((pkg) => [pkg.id, pkg] as const));

    const orchestrator = byId.get("orchestrator");
    expect(orchestrator).toBeTruthy();
    expect(orchestrator?.body).toContain("Exec task brief template");
    expect(orchestrator?.body).toContain("Background (why this matters)");
    expect(orchestrator?.body).toContain("Starting points");
  });

  test("exec subagent append_prompt warns about missing task brief context", () => {
    const pkgs = getBuiltInAgentDefinitions();
    const byId = new Map(pkgs.map((pkg) => [pkg.id, pkg] as const));

    const exec = byId.get("exec");
    expect(exec).toBeTruthy();

    const appendPrompt = exec?.frontmatter.subagent?.append_prompt;
    expect(appendPrompt).toBeTruthy();
    expect(appendPrompt).toContain("task brief is missing critical information");
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
