import * as fs from "node:fs/promises";
import * as path from "node:path";

import { describe, expect, test } from "bun:test";

import { SkillNameSchema } from "@/common/orpc/schemas";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import { DisposableTempDir } from "@/node/services/tempDir";
import { discoverAgentSkills, readAgentSkill } from "./agentSkillsService";

interface WriteSkillOptions {
  include_files?: string[];
  extraFiles?: Record<string, string>;
}

async function writeSkill(
  root: string,
  name: string,
  description: string,
  options?: WriteSkillOptions
): Promise<void> {
  const skillDir = path.join(root, name);
  await fs.mkdir(skillDir, { recursive: true });

  let frontmatter = `name: ${name}\ndescription: ${description}`;
  if (options?.include_files) {
    frontmatter += `\ninclude_files:\n${options.include_files.map((f) => `  - "${f}"`).join("\n")}`;
  }

  const content = `---\n${frontmatter}\n---\nBody\n`;
  await fs.writeFile(path.join(skillDir, "SKILL.md"), content, "utf-8");

  // Write extra files if specified
  if (options?.extraFiles) {
    for (const [filePath, fileContent] of Object.entries(options.extraFiles)) {
      const fullPath = path.join(skillDir, filePath);
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.writeFile(fullPath, fileContent, "utf-8");
    }
  }
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

    expect(skills.map((s) => s.name)).toEqual(["bar", "foo"]);

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

  test("readAgentSkill resolves include_files patterns", async () => {
    using project = new DisposableTempDir("agent-skills-include");

    const projectSkillsRoot = path.join(project.path, ".mux", "skills");
    await writeSkill(projectSkillsRoot, "with-files", "skill with included files", {
      include_files: ["examples/*.ts", "schemas/*.json"],
      extraFiles: {
        "examples/hello.ts": 'console.log("hello");',
        "examples/world.ts": 'console.log("world");',
        "schemas/config.json": '{"key": "value"}',
        "other/ignored.txt": "should not be included",
      },
    });

    const roots = { projectRoot: projectSkillsRoot, globalRoot: "/nonexistent" };
    const runtime = new LocalRuntime(project.path);

    const name = SkillNameSchema.parse("with-files");
    const resolved = await readAgentSkill(runtime, project.path, name, { roots });

    expect(resolved.package.includeFilesContext).toBeDefined();
    const ctx = resolved.package.includeFilesContext!;

    // Should have matched 3 files
    expect(ctx.files.length).toBe(3);

    const paths = ctx.files.map((f) => f.path).sort();
    expect(paths).toEqual(["examples/hello.ts", "examples/world.ts", "schemas/config.json"]);

    // Check content is included
    const hello = ctx.files.find((f) => f.path === "examples/hello.ts");
    expect(hello?.content).toBe('console.log("hello");');

    // Check rendered XML uses <@path> format
    expect(ctx.rendered).toContain("<@examples/hello.ts>");
    expect(ctx.rendered).toContain("</@examples/hello.ts>");
    expect(ctx.rendered).toContain("```ts");
    expect(ctx.rendered).toContain('console.log("hello");');

    // Should not include unmatched files
    expect(ctx.rendered).not.toContain("ignored.txt");
  });

  test("readAgentSkill without include_files has no context", async () => {
    using project = new DisposableTempDir("agent-skills-no-include");

    const projectSkillsRoot = path.join(project.path, ".mux", "skills");
    await writeSkill(projectSkillsRoot, "basic", "basic skill");

    const roots = { projectRoot: projectSkillsRoot, globalRoot: "/nonexistent" };
    const runtime = new LocalRuntime(project.path);

    const name = SkillNameSchema.parse("basic");
    const resolved = await readAgentSkill(runtime, project.path, name, { roots });

    expect(resolved.package.includeFilesContext).toBeUndefined();
  });
});
