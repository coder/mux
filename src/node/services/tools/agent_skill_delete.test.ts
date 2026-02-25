import * as fs from "node:fs/promises";
import * as path from "node:path";

import { describe, it, expect } from "bun:test";
import type { ToolExecutionOptions } from "ai";

import { MUX_HELP_CHAT_WORKSPACE_ID } from "@/common/constants/muxChat";
import type { AgentSkillDeleteToolResult } from "@/common/types/tools";
import { createAgentSkillDeleteTool } from "./agent_skill_delete";
import { createTestToolConfig, TestTempDir } from "./testHelpers";

const mockToolCallOptions: ToolExecutionOptions = {
  toolCallId: "test-call-id",
  messages: [],
};

async function createWorkspaceSessionDir(muxHome: string, workspaceId: string): Promise<string> {
  const workspaceSessionDir = path.join(muxHome, "sessions", workspaceId);
  await fs.mkdir(workspaceSessionDir, { recursive: true });
  return workspaceSessionDir;
}

function restoreMuxRoot(previousMuxRoot: string | undefined): void {
  if (previousMuxRoot === undefined) {
    delete process.env.MUX_ROOT;
    return;
  }

  process.env.MUX_ROOT = previousMuxRoot;
}

async function createDeleteTool(muxHome: string, workspaceId: string = MUX_HELP_CHAT_WORKSPACE_ID) {
  const workspaceSessionDir = await createWorkspaceSessionDir(muxHome, workspaceId);
  const config = createTestToolConfig(muxHome, {
    workspaceId,
    sessionsDir: workspaceSessionDir,
  });

  return createAgentSkillDeleteTool(config);
}

async function writeSkillFixture(muxHome: string, name: string): Promise<void> {
  const skillDir = path.join(muxHome, "skills", name);
  await fs.mkdir(path.join(skillDir, "references"), { recursive: true });
  await fs.writeFile(
    path.join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: fixture\n---\nBody\n`,
    "utf-8"
  );
  await fs.writeFile(path.join(skillDir, "references", "foo.txt"), "fixture", "utf-8");
}

describe("agent_skill_delete", () => {
  it("rejects deletes outside Chat with Mux workspace", async () => {
    using tempDir = new TestTempDir("test-agent-skill-delete-reject");

    const tool = await createDeleteTool(tempDir.path, "regular-workspace");
    const result = (await tool.execute!(
      { name: "demo-skill", filePath: "SKILL.md", confirm: true },
      mockToolCallOptions
    )) as AgentSkillDeleteToolResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/only available/i);
    }
  });

  it("requires confirm: true before deleting", async () => {
    using tempDir = new TestTempDir("test-agent-skill-delete-confirm");

    await writeSkillFixture(tempDir.path, "demo-skill");

    const tool = await createDeleteTool(tempDir.path);
    const result = (await tool.execute!(
      { name: "demo-skill", filePath: "SKILL.md", confirm: false },
      mockToolCallOptions
    )) as AgentSkillDeleteToolResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/confirm/i);
    }

    const skillStat = await fs.stat(path.join(tempDir.path, "skills", "demo-skill"));
    expect(skillStat.isDirectory()).toBe(true);
  });

  it("deletes a specific file within a skill", async () => {
    using tempDir = new TestTempDir("test-agent-skill-delete-file");

    await writeSkillFixture(tempDir.path, "demo-skill");

    const tool = await createDeleteTool(tempDir.path);
    const result = (await tool.execute!(
      {
        name: "demo-skill",
        filePath: "references/foo.txt",
        confirm: true,
      },
      mockToolCallOptions
    )) as AgentSkillDeleteToolResult;

    expect(result).toMatchObject({ success: true, deleted: "file" });

    const statErr = await fs
      .stat(path.join(tempDir.path, "skills", "demo-skill", "references", "foo.txt"))
      .catch((e: NodeJS.ErrnoException) => e);
    expect(statErr).toMatchObject({ code: "ENOENT" });

    const skillStat = await fs.stat(path.join(tempDir.path, "skills", "demo-skill", "SKILL.md"));
    expect(skillStat.isFile()).toBe(true);
  });

  it("deletes an entire skill directory when target is 'skill'", async () => {
    using tempDir = new TestTempDir("test-agent-skill-delete-skill-dir");

    await writeSkillFixture(tempDir.path, "demo-skill");

    const tool = await createDeleteTool(tempDir.path);
    const result = (await tool.execute!(
      {
        name: "demo-skill",
        target: "skill",
        confirm: true,
      },
      mockToolCallOptions
    )) as AgentSkillDeleteToolResult;

    expect(result).toMatchObject({ success: true, deleted: "skill" });

    const statErr = await fs
      .stat(path.join(tempDir.path, "skills", "demo-skill"))
      .catch((e: NodeJS.ErrnoException) => e);
    expect(statErr).toMatchObject({ code: "ENOENT" });
  });

  it("requires filePath when target is 'file'", async () => {
    using tempDir = new TestTempDir("test-agent-skill-delete-filepath-required");

    await writeSkillFixture(tempDir.path, "demo-skill");

    const tool = await createDeleteTool(tempDir.path);
    const result = (await tool.execute!(
      {
        name: "demo-skill",
        target: "file",
        confirm: true,
      },
      mockToolCallOptions
    )) as AgentSkillDeleteToolResult;

    expect(result).toMatchObject({
      success: false,
      error: "filePath is required when target is 'file'",
    });
  });

  it("rejects deletes when skills root is a symlink", async () => {
    using tempDir = new TestTempDir("test-agent-skill-delete-symlinked-root");
    const previousMuxRoot = process.env.MUX_ROOT;
    process.env.MUX_ROOT = tempDir.path;

    try {
      const externalDir = path.join(tempDir.path, "external-skills-tree");
      const externalSkillDir = path.join(externalDir, "evil-skill");
      await fs.mkdir(externalSkillDir, { recursive: true });
      await fs.writeFile(
        path.join(externalSkillDir, "SKILL.md"),
        "---\nname: evil-skill\ndescription: test\n---\nBody\n",
        "utf-8"
      );

      const muxDir = path.join(tempDir.path, ".mux");
      await fs.mkdir(muxDir, { recursive: true });
      await fs.symlink(
        externalDir,
        path.join(muxDir, "skills"),
        process.platform === "win32" ? "junction" : "dir"
      );

      const baseConfig = createTestToolConfig(tempDir.path, {
        workspaceId: MUX_HELP_CHAT_WORKSPACE_ID,
        sessionsDir: path.join(muxDir, "sessions", MUX_HELP_CHAT_WORKSPACE_ID),
      });

      const tool = createAgentSkillDeleteTool(baseConfig);
      const result = (await tool.execute!(
        {
          name: "evil-skill",
          target: "skill",
          confirm: true,
        },
        mockToolCallOptions
      )) as AgentSkillDeleteToolResult;

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toMatch(/symbolic link/i);
      }

      const externalStillExists = await fs
        .stat(externalSkillDir)
        .then(() => true)
        .catch(() => false);
      expect(externalStillExists).toBe(true);
    } finally {
      restoreMuxRoot(previousMuxRoot);
    }
  });

  it("refuses to delete a symlinked skill directory", async () => {
    using tempDir = new TestTempDir("test-agent-skill-delete-symlink-skill");

    const realSkillDir = path.join(tempDir.path, "real-skill-dir");
    await fs.mkdir(realSkillDir, { recursive: true });
    await fs.mkdir(path.join(tempDir.path, "skills"), { recursive: true });
    await fs.symlink(realSkillDir, path.join(tempDir.path, "skills", "demo-skill"));

    const tool = await createDeleteTool(tempDir.path);
    const result = (await tool.execute!(
      {
        name: "demo-skill",
        target: "skill",
        confirm: true,
      },
      mockToolCallOptions
    )) as AgentSkillDeleteToolResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/symlink/i);
    }

    const skillLinkStat = await fs.lstat(path.join(tempDir.path, "skills", "demo-skill"));
    expect(skillLinkStat.isSymbolicLink()).toBe(true);
  });

  it("refuses to delete a file when skill directory is a symlink", async () => {
    using tempDir = new TestTempDir("test-agent-skill-delete-symlinked-dir-file");

    const externalDir = path.join(tempDir.path, "external-target");
    await fs.mkdir(externalDir, { recursive: true });
    await fs.writeFile(
      path.join(externalDir, "SKILL.md"),
      "---\nname: demo-skill\ndescription: fixture\n---\nBody\n",
      "utf-8"
    );

    await fs.mkdir(path.join(tempDir.path, "skills"), { recursive: true });
    await fs.symlink(externalDir, path.join(tempDir.path, "skills", "demo-skill"));

    const tool = await createDeleteTool(tempDir.path);
    const result = (await tool.execute!(
      { name: "demo-skill", filePath: "SKILL.md", confirm: true },
      mockToolCallOptions
    )) as AgentSkillDeleteToolResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/symlink/i);
    }

    const stat = await fs.stat(path.join(externalDir, "SKILL.md"));
    expect(stat.isFile()).toBe(true);
  });

  it("refuses to delete a file via symlinked intermediate path", async () => {
    using tempDir = new TestTempDir("test-agent-skill-delete-intermediate-symlink");

    await writeSkillFixture(tempDir.path, "demo-skill");

    const externalDir = path.join(tempDir.path, "external-escape");
    await fs.mkdir(externalDir, { recursive: true });
    await fs.writeFile(path.join(externalDir, "secret.txt"), "important", "utf-8");

    const skillDir = path.join(tempDir.path, "skills", "demo-skill");
    await fs.rm(path.join(skillDir, "references"), { recursive: true });
    await fs.symlink(externalDir, path.join(skillDir, "references"));

    const tool = await createDeleteTool(tempDir.path);
    const result = (await tool.execute!(
      { name: "demo-skill", filePath: "references/secret.txt", confirm: true },
      mockToolCallOptions
    )) as AgentSkillDeleteToolResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/escape|symlink/i);
    }

    const stat = await fs.stat(path.join(externalDir, "secret.txt"));
    expect(stat.isFile()).toBe(true);
  });

  it("rejects internal symlink alias pointing to existing file", async () => {
    using tempDir = new TestTempDir("test-agent-skill-delete-internal-alias-symlink");

    await writeSkillFixture(tempDir.path, "demo-skill");

    const skillDir = path.join(tempDir.path, "skills", "demo-skill");
    const skillPath = path.join(skillDir, "SKILL.md");
    const originalContent = await fs.readFile(skillPath, "utf-8");
    await fs.symlink("SKILL.md", path.join(skillDir, "link.txt"));

    const tool = await createDeleteTool(tempDir.path);
    const result = (await tool.execute!(
      {
        name: "demo-skill",
        target: "file",
        filePath: "link.txt",
        confirm: true,
      },
      mockToolCallOptions
    )) as AgentSkillDeleteToolResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/symlink/i);
    }

    const stored = await fs.readFile(skillPath, "utf-8");
    expect(stored).toBe(originalContent);
  });

  it.each(["/etc/passwd", "../escape", "~/bad"])(
    "rejects invalid filePath %s",
    async (filePathValue) => {
      using tempDir = new TestTempDir("test-agent-skill-delete-invalid-path");

      await writeSkillFixture(tempDir.path, "demo-skill");

      const tool = await createDeleteTool(tempDir.path);
      const result = (await tool.execute!(
        {
          name: "demo-skill",
          filePath: filePathValue,
          confirm: true,
        },
        mockToolCallOptions
      )) as AgentSkillDeleteToolResult;

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toMatch(/Invalid filePath|path traversal/i);
      }
    }
  );

  it("returns a clear error when the skill does not exist", async () => {
    using tempDir = new TestTempDir("test-agent-skill-delete-missing");

    const tool = await createDeleteTool(tempDir.path);
    const result = (await tool.execute!(
      { name: "missing-skill", filePath: "SKILL.md", confirm: true },
      mockToolCallOptions
    )) as AgentSkillDeleteToolResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe("Skill not found: missing-skill");
    }
  });

  it("returns explicit not-found when deleting a file that does not exist within an existing skill", async () => {
    using tempDir = new TestTempDir("test-agent-skill-delete-missing-file");

    await writeSkillFixture(tempDir.path, "demo-skill");

    const tool = await createDeleteTool(tempDir.path);
    const result = (await tool.execute!(
      {
        name: "demo-skill",
        filePath: "nonexistent.txt",
        confirm: true,
      },
      mockToolCallOptions
    )) as AgentSkillDeleteToolResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe("File not found in skill 'demo-skill': nonexistent.txt");
    }
  });
});
