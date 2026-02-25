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
    expect(skills.map((s) => s.name)).toEqual(["bar", "foo", "init", "mux-diagram", "mux-docs"]);

    const foo = skills.find((s) => s.name === "foo");
    expect(foo).toBeDefined();
    expect(foo!.scope).toBe("project");
    expect(foo!.description).toBe("from project");

    const bar = skills.find((s) => s.name === "bar");
    expect(bar).toBeDefined();
    expect(bar!.scope).toBe("global");
  });

  test("scans universal root after mux global root", async () => {
    using project = new DisposableTempDir("agent-skills-project");
    using global = new DisposableTempDir("agent-skills-global");
    using universal = new DisposableTempDir("agent-skills-universal");

    const projectSkillsRoot = path.join(project.path, ".mux", "skills");
    const globalSkillsRoot = global.path;
    const universalSkillsRoot = universal.path;

    await writeSkill(globalSkillsRoot, "shared", "from global");
    await writeSkill(universalSkillsRoot, "shared", "from universal");
    await writeSkill(universalSkillsRoot, "universal-only", "from universal only");

    const roots = {
      projectRoot: projectSkillsRoot,
      globalRoot: globalSkillsRoot,
      universalRoot: universalSkillsRoot,
    };
    const runtime = new LocalRuntime(project.path);

    const skills = await discoverAgentSkills(runtime, project.path, { roots });

    const shared = skills.find((s) => s.name === "shared");
    expect(shared).toBeDefined();
    expect(shared!.scope).toBe("global");
    expect(shared!.description).toBe("from global");

    const universalOnly = skills.find((s) => s.name === "universal-only");
    expect(universalOnly).toBeDefined();
    expect(universalOnly!.scope).toBe("global");
    expect(universalOnly!.description).toBe("from universal only");

    const universalOnlyName = SkillNameSchema.parse("universal-only");
    const resolved = await readAgentSkill(runtime, project.path, universalOnlyName, { roots });
    expect(resolved.package.scope).toBe("global");
    expect(resolved.package.frontmatter.description).toBe("from universal only");
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

    expect(diagnostics.skills.map((s) => s.name)).toEqual([
      "foo",
      "init",
      "mux-diagram",
      "mux-docs",
    ]);

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

  test("discovers symlinked skill directories", async () => {
    using project = new DisposableTempDir("agent-skills-symlink");
    using skillSource = new DisposableTempDir("agent-skills-source");

    const projectSkillsRoot = path.join(project.path, ".mux", "skills");
    await fs.mkdir(projectSkillsRoot, { recursive: true });

    // Create a real skill in a separate location
    await writeSkill(skillSource.path, "my-skill", "A symlinked skill");

    // Symlink the skill directory into the project skills root
    await fs.symlink(
      path.join(skillSource.path, "my-skill"),
      path.join(projectSkillsRoot, "my-skill")
    );

    const roots = { projectRoot: projectSkillsRoot, globalRoot: "/nonexistent" };
    const runtime = new LocalRuntime(project.path);

    const skills = await discoverAgentSkills(runtime, project.path, { roots });
    const found = skills.find((s) => s.name === "my-skill");
    expect(found).toBeDefined();
    expect(found!.description).toBe("A symlinked skill");
    expect(found!.scope).toBe("project");
  });

  test("readAgentSkill reads from symlinked skill directory", async () => {
    using project = new DisposableTempDir("agent-skills-symlink-read");
    using skillSource = new DisposableTempDir("agent-skills-source-read");

    const projectSkillsRoot = path.join(project.path, ".mux", "skills");
    await fs.mkdir(projectSkillsRoot, { recursive: true });

    await writeSkill(skillSource.path, "linked-skill", "Symlinked for reading");
    await fs.symlink(
      path.join(skillSource.path, "linked-skill"),
      path.join(projectSkillsRoot, "linked-skill")
    );

    const roots = { projectRoot: projectSkillsRoot, globalRoot: "/nonexistent" };
    const runtime = new LocalRuntime(project.path);

    const parsed = SkillNameSchema.safeParse("linked-skill");
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error("bad name");

    const result = await readAgentSkill(runtime, project.path, parsed.data, { roots });
    expect(result.package.frontmatter.name).toBe("linked-skill");
    expect(result.package.frontmatter.description).toBe("Symlinked for reading");
    expect(result.package.scope).toBe("project");
  });

  test("discovers skill directory via relative symlink", async () => {
    // Mirrors a real-world layout:
    //   <project>/.agents/skills/kalshi-docs/SKILL.md   (real skill)
    //   <project>/.mux/skills/kalshi-docs -> ../../.agents/skills/kalshi-docs  (relative symlink)
    using project = new DisposableTempDir("agent-skills-relative-symlink");

    const projectRoot = project.path;
    const externalSkillsDir = path.join(projectRoot, ".agents", "skills");
    const muxSkillsRoot = path.join(projectRoot, ".mux", "skills");
    await fs.mkdir(externalSkillsDir, { recursive: true });
    await fs.mkdir(muxSkillsRoot, { recursive: true });

    // Write the real skill outside .mux/skills/
    await writeSkill(externalSkillsDir, "kalshi-docs", "Kalshi API documentation");

    // Create a relative symlink (../../.agents/skills/kalshi-docs)
    await fs.symlink(
      path.join("..", "..", ".agents", "skills", "kalshi-docs"),
      path.join(muxSkillsRoot, "kalshi-docs")
    );

    const roots = { projectRoot: muxSkillsRoot, globalRoot: "/nonexistent" };
    const runtime = new LocalRuntime(projectRoot);

    // Discovery should find the symlinked skill
    const skills = await discoverAgentSkills(runtime, projectRoot, { roots });
    const found = skills.find((s) => s.name === "kalshi-docs");
    expect(found).toBeDefined();
    expect(found!.description).toBe("Kalshi API documentation");
    expect(found!.scope).toBe("project");

    // readAgentSkill should also resolve through the relative symlink
    const parsed = SkillNameSchema.safeParse("kalshi-docs");
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error("bad name");

    const result = await readAgentSkill(runtime, projectRoot, parsed.data, { roots });
    expect(result.package.frontmatter.name).toBe("kalshi-docs");
    expect(result.package.frontmatter.description).toBe("Kalshi API documentation");
  });

  test("discovers symlinked SKILL.md inside a real directory", async () => {
    using project = new DisposableTempDir("agent-skills-symlink-file");
    using skillSource = new DisposableTempDir("agent-skills-source-file");

    const projectSkillsRoot = path.join(project.path, ".mux", "skills");
    const skillDir = path.join(projectSkillsRoot, "file-linked");
    await fs.mkdir(skillDir, { recursive: true });

    // Write SKILL.md to the source location and symlink just the file
    const sourceSkillMd = path.join(skillSource.path, "SKILL.md");
    await fs.writeFile(
      sourceSkillMd,
      `---\nname: file-linked\ndescription: Symlinked SKILL.md\n---\nBody\n`,
      "utf-8"
    );
    await fs.symlink(sourceSkillMd, path.join(skillDir, "SKILL.md"));

    const roots = { projectRoot: projectSkillsRoot, globalRoot: "/nonexistent" };
    const runtime = new LocalRuntime(project.path);

    const skills = await discoverAgentSkills(runtime, project.path, { roots });
    const found = skills.find((s) => s.name === "file-linked");
    expect(found).toBeDefined();
    expect(found!.description).toBe("Symlinked SKILL.md");
  });
});
