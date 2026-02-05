import * as fs from "node:fs/promises";
import * as path from "node:path";

import { describe, expect, test } from "bun:test";

import { SkillNameSchema } from "@/common/orpc/schemas";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import { DisposableTempDir } from "@/node/services/tempDir";
import {
  discoverAgentSkills,
  discoverAgentSkillsDiagnostics,
  readAgentSkill,
} from "./agentSkillsService";

async function writeSkill(root: string, name: string, description: string): Promise<void> {
  const skillDir = path.join(root, name);
  await fs.mkdir(skillDir, { recursive: true });
  const content = `---
name: ${name}
description: ${description}
---
Body
`;
  await fs.writeFile(path.join(skillDir, "SKILL.md"), content, "utf-8");
}

describe("agentSkillsService", () => {
  test("project skills override global skills", async () => {
    using project = new DisposableTempDir("agent-skills-project");
    using global = new DisposableTempDir("agent-skills-global");

    const projectSkillsRoot = path.join(project.path, ".mux", "skills");
    const globalSkillsRoot = global.path;

    await writeSkill(globalSkillsRoot, "foo", "from global");
    await writeSkill(projectSkillsRoot, "foo", "from project");
    await writeSkill(globalSkillsRoot, "bar", "global only");

    const roots = { projectRoot: projectSkillsRoot, globalRoot: globalSkillsRoot };
    const runtime = new LocalRuntime(project.path);

    const skills = await discoverAgentSkills(runtime, project.path, { roots });

    // Should include project/global skills plus built-in skills
    // Note: deep-review skill is a project skill in the Mux repo, not a built-in
    expect(skills.map((s) => s.name)).toEqual(["bar", "foo", "init", "mux-docs"]);

    const foo = skills.find((s) => s.name === "foo");
    expect(foo).toBeDefined();
    expect(foo!.scope).toBe("project");
    expect(foo!.description).toBe("from project");

    const bar = skills.find((s) => s.name === "bar");
    expect(bar).toBeDefined();
    expect(bar!.scope).toBe("global");
  });

  test("readAgentSkill resolves project before global", async () => {
    using project = new DisposableTempDir("agent-skills-project");
    using global = new DisposableTempDir("agent-skills-global");

    const projectSkillsRoot = path.join(project.path, ".mux", "skills");
    const globalSkillsRoot = global.path;

    await writeSkill(globalSkillsRoot, "foo", "from global");
    await writeSkill(projectSkillsRoot, "foo", "from project");

    const roots = { projectRoot: projectSkillsRoot, globalRoot: globalSkillsRoot };
    const runtime = new LocalRuntime(project.path);

    const name = SkillNameSchema.parse("foo");
    const resolved = await readAgentSkill(runtime, project.path, name, { roots });

    expect(resolved.package.scope).toBe("project");
    expect(resolved.package.frontmatter.description).toBe("from project");
  });

  test("readAgentSkill can read built-in skills", async () => {
    using project = new DisposableTempDir("agent-skills-project");
    using global = new DisposableTempDir("agent-skills-global");

    const projectSkillsRoot = path.join(project.path, ".mux", "skills");
    const globalSkillsRoot = global.path;

    const roots = { projectRoot: projectSkillsRoot, globalRoot: globalSkillsRoot };
    const runtime = new LocalRuntime(project.path);

    const name = SkillNameSchema.parse("mux-docs");
    const resolved = await readAgentSkill(runtime, project.path, name, { roots });

    expect(resolved.package.scope).toBe("built-in");
    expect(resolved.package.frontmatter.name).toBe("mux-docs");
    expect(resolved.skillDir).toBe("<built-in:mux-docs>");
  });

  test("project/global skills override built-in skills", async () => {
    using project = new DisposableTempDir("agent-skills-project");
    using global = new DisposableTempDir("agent-skills-global");

    const projectSkillsRoot = path.join(project.path, ".mux", "skills");
    const globalSkillsRoot = global.path;

    // Override the built-in mux-docs skill with a project-local version
    await writeSkill(projectSkillsRoot, "mux-docs", "custom docs from project");

    const roots = { projectRoot: projectSkillsRoot, globalRoot: globalSkillsRoot };
    const runtime = new LocalRuntime(project.path);

    const skills = await discoverAgentSkills(runtime, project.path, { roots });
    const muxDocs = skills.find((s) => s.name === "mux-docs");

    expect(muxDocs).toBeDefined();
    expect(muxDocs!.scope).toBe("project");
    expect(muxDocs!.description).toBe("custom docs from project");

    // readAgentSkill should also return the project version
    const name = SkillNameSchema.parse("mux-docs");
    const resolved = await readAgentSkill(runtime, project.path, name, { roots });
    expect(resolved.package.scope).toBe("project");
  });

  test("discoverAgentSkillsDiagnostics surfaces invalid skills", async () => {
    using project = new DisposableTempDir("agent-skills-project");
    using global = new DisposableTempDir("agent-skills-global");

    const projectSkillsRoot = path.join(project.path, ".mux", "skills");
    const globalSkillsRoot = global.path;

    await writeSkill(projectSkillsRoot, "foo", "valid");

    // Invalid directory name (fails SkillNameSchema parsing)
    const invalidDirName = "Bad_Skill";
    const invalidDir = path.join(projectSkillsRoot, invalidDirName);
    await fs.mkdir(invalidDir, { recursive: true });

    // Valid directory name but missing SKILL.md
    await fs.mkdir(path.join(projectSkillsRoot, "missing-skill"), { recursive: true });

    // Invalid SKILL.md frontmatter (missing required description)
    const badFrontmatterDir = path.join(projectSkillsRoot, "bad-frontmatter");
    await fs.mkdir(badFrontmatterDir, { recursive: true });
    await fs.writeFile(
      path.join(badFrontmatterDir, "SKILL.md"),
      `---\nname: bad-frontmatter\n---\nBody\n`,
      "utf-8"
    );

    // Mismatched frontmatter.name vs directory name
    const mismatchDir = path.join(projectSkillsRoot, "name-mismatch");
    await fs.mkdir(mismatchDir, { recursive: true });
    await fs.writeFile(
      path.join(mismatchDir, "SKILL.md"),
      `---\nname: other-name\ndescription: mismatch\n---\nBody\n`,
      "utf-8"
    );

    const roots = { projectRoot: projectSkillsRoot, globalRoot: globalSkillsRoot };
    const runtime = new LocalRuntime(project.path);

    const diagnostics = await discoverAgentSkillsDiagnostics(runtime, project.path, { roots });

    expect(diagnostics.skills.map((s) => s.name)).toEqual(["foo", "init", "mux-docs"]);

    const invalidNames = diagnostics.invalidSkills.map((issue) => issue.directoryName).sort();
    expect(invalidNames).toEqual(
      [invalidDirName, "bad-frontmatter", "missing-skill", "name-mismatch"].sort()
    );

    for (const issue of diagnostics.invalidSkills) {
      expect(issue.scope).toBe("project");
      expect(issue.displayPath).toContain(issue.directoryName);
      expect(issue.message.length).toBeGreaterThan(0);
      expect(issue.hint?.length).toBeGreaterThan(0);
    }

    expect(
      diagnostics.invalidSkills.find((i) => i.directoryName === invalidDirName)?.message
    ).toContain("Invalid skill directory name");
    expect(
      diagnostics.invalidSkills.find((i) => i.directoryName === "missing-skill")?.message
    ).toContain("SKILL.md is missing");
    expect(
      diagnostics.invalidSkills.find((i) => i.directoryName === "bad-frontmatter")?.message
    ).toContain("Invalid SKILL.md frontmatter");
    expect(
      diagnostics.invalidSkills.find((i) => i.directoryName === "name-mismatch")?.message
    ).toContain("must match directory name");
  });
});
