import * as fs from "node:fs/promises";
import * as path from "node:path";

import { describe, expect, test } from "bun:test";

import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import { DisposableTempDir } from "@/node/services/tempDir";

import {
  ensureRuntimePathWithinWorkspace,
  inspectContainmentOnRuntime,
  resolveContainedSkillFilePathOnRuntime,
} from "./runtimeSkillPathUtils";

async function writeSkillMarkdown(
  filePath: string,
  name: string,
  description: string
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(
    filePath,
    `---\nname: ${name}\ndescription: ${description}\n---\nBody\n`,
    "utf-8"
  );
}

describe("runtimeSkillPathUtils", () => {
  test("treats a regular SKILL.md inside the workspace as contained", async () => {
    using project = new DisposableTempDir("runtime-skill-path-utils-regular");

    const skillPath = path.join(project.path, ".mux", "skills", "regular-skill", "SKILL.md");
    await writeSkillMarkdown(skillPath, "regular-skill", "Regular skill");

    const runtime = new LocalRuntime(project.path);
    const probe = await inspectContainmentOnRuntime(runtime, project.path, skillPath);

    expect(probe.withinRoot).toBe(true);
    expect(probe.leafSymlink).toBe(false);
    expect(probe.targetDirResolution).toBe("direct");
    expect(
      ensureRuntimePathWithinWorkspace(runtime, project.path, skillPath, "Project skill file")
    ).resolves.toBeUndefined();
  });

  test("treats a symlinked SKILL.md that resolves inside the workspace as contained", async () => {
    using project = new DisposableTempDir("runtime-skill-path-utils-inside-symlink");

    const skillDir = path.join(project.path, ".mux", "skills", "inside-symlink");
    const sourcePath = path.join(project.path, "skill-sources", "inside-symlink.md");
    const skillPath = path.join(skillDir, "SKILL.md");
    await fs.mkdir(skillDir, { recursive: true });
    await writeSkillMarkdown(sourcePath, "inside-symlink", "Contained via symlink");
    await fs.symlink(sourcePath, skillPath, "file");

    const runtime = new LocalRuntime(project.path);
    const probe = await inspectContainmentOnRuntime(runtime, project.path, skillPath);

    expect(probe.withinRoot).toBe(true);
    expect(probe.leafSymlink).toBe(true);
    expect(probe.targetDirResolution).toBe("direct");
    expect(
      ensureRuntimePathWithinWorkspace(runtime, project.path, skillPath, "Project skill file")
    ).resolves.toBeUndefined();
  });

  test("allows a symlinked file when it still resolves inside the skill directory", async () => {
    using project = new DisposableTempDir("runtime-skill-path-utils-skill-contained-symlink");

    const skillDir = path.join(project.path, ".mux", "skills", "contained-symlink");
    const sourcePath = path.join(skillDir, "source.md");
    const aliasPath = path.join(skillDir, "SKILL.md");
    await fs.mkdir(skillDir, { recursive: true });
    await writeSkillMarkdown(sourcePath, "contained-symlink", "Contained via in-skill symlink");
    await fs.symlink(sourcePath, aliasPath, "file");

    const runtime = new LocalRuntime(project.path);
    expect(resolveContainedSkillFilePathOnRuntime(runtime, skillDir, "SKILL.md")).resolves.toEqual({
      resolvedPath: aliasPath,
      normalizedRelativePath: "SKILL.md",
    });
  });

  test("rejects a symlinked SKILL.md that resolves outside the workspace", async () => {
    using project = new DisposableTempDir("runtime-skill-path-utils-outside-symlink");
    using escapedSource = new DisposableTempDir("runtime-skill-path-utils-outside-source");

    const skillDir = path.join(project.path, ".mux", "skills", "outside-symlink");
    const sourcePath = path.join(escapedSource.path, "outside-symlink.md");
    const skillPath = path.join(skillDir, "SKILL.md");
    await fs.mkdir(skillDir, { recursive: true });
    await writeSkillMarkdown(sourcePath, "outside-symlink", "Escaped via symlink");
    await fs.symlink(sourcePath, skillPath, "file");

    const runtime = new LocalRuntime(project.path);
    const probe = await inspectContainmentOnRuntime(runtime, project.path, skillPath);

    expect(probe.withinRoot).toBe(false);
    expect(probe.leafSymlink).toBe(true);
    expect(probe.targetDirResolution).toBe("direct");
    expect(
      ensureRuntimePathWithinWorkspace(runtime, project.path, skillPath, "Project skill file")
    ).rejects.toThrow(/outside workspace root/i);
  });
});
