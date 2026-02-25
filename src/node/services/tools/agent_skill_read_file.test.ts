import * as fs from "node:fs/promises";
import * as path from "node:path";

import { describe, it, expect } from "bun:test";
import type { ToolExecutionOptions } from "ai";

import { MUX_HELP_CHAT_WORKSPACE_ID } from "@/common/constants/muxChat";
import { AgentSkillReadFileToolResultSchema } from "@/common/utils/tools/toolDefinitions";
import { createAgentSkillReadFileTool } from "./agent_skill_read_file";
import { createTestToolConfig, TestTempDir } from "./testHelpers";

const mockToolCallOptions: ToolExecutionOptions = {
  toolCallId: "test-call-id",
  messages: [],
};

async function writeProjectSkill(workspacePath: string, name: string): Promise<void> {
  const skillDir = path.join(workspacePath, ".mux", "skills", name);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    path.join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: test\n---\nBody\n`,
    "utf-8"
  );
}

async function writeGlobalSkill(muxRoot: string, name: string): Promise<void> {
  const skillDir = path.join(muxRoot, "skills", name);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    path.join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: test\n---\nBody\n`,
    "utf-8"
  );
}

function restoreMuxRoot(previousMuxRoot: string | undefined): void {
  if (previousMuxRoot === undefined) {
    delete process.env.MUX_ROOT;
    return;
  }

  process.env.MUX_ROOT = previousMuxRoot;
}

describe("agent_skill_read_file", () => {
  it("allows reading built-in skill files", async () => {
    using tempDir = new TestTempDir("test-agent-skill-read-file-mux-chat");
    const baseConfig = createTestToolConfig(tempDir.path, {
      workspaceId: MUX_HELP_CHAT_WORKSPACE_ID,
    });

    const tool = createAgentSkillReadFileTool(baseConfig);

    const raw: unknown = await Promise.resolve(
      tool.execute!(
        { name: "mux-docs", filePath: "SKILL.md", offset: 1, limit: 25 },
        mockToolCallOptions
      )
    );

    const parsed = AgentSkillReadFileToolResultSchema.safeParse(raw);
    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      throw new Error(parsed.error.message);
    }

    const result = parsed.data;
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.content).toMatch(/name:\s*mux-docs/i);
    }
  });

  it("allows reading global skill files on disk in Chat with Mux workspace", async () => {
    using tempDir = new TestTempDir("test-agent-skill-read-file-global");
    const previousMuxRoot = process.env.MUX_ROOT;
    process.env.MUX_ROOT = tempDir.path;

    try {
      await writeGlobalSkill(tempDir.path, "foo");

      const baseConfig = createTestToolConfig(tempDir.path, {
        workspaceId: MUX_HELP_CHAT_WORKSPACE_ID,
      });
      const tool = createAgentSkillReadFileTool(baseConfig);

      const raw: unknown = await Promise.resolve(
        tool.execute!(
          { name: "foo", filePath: "SKILL.md", offset: 1, limit: 5 },
          mockToolCallOptions
        )
      );

      const parsed = AgentSkillReadFileToolResultSchema.safeParse(raw);
      expect(parsed.success).toBe(true);
      if (!parsed.success) {
        throw new Error(parsed.error.message);
      }

      const result = parsed.data;
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.content).toMatch(/name:\s*foo/i);
      }
    } finally {
      restoreMuxRoot(previousMuxRoot);
    }
  });

  it("allows reading project skill files on disk outside Chat with Mux workspace", async () => {
    using tempDir = new TestTempDir("test-agent-skill-read-file-project");
    await writeProjectSkill(tempDir.path, "project-skill");

    const baseConfig = createTestToolConfig(tempDir.path, {
      workspaceId: "regular-workspace",
    });
    const tool = createAgentSkillReadFileTool(baseConfig);

    const raw: unknown = await Promise.resolve(
      tool.execute!(
        { name: "project-skill", filePath: "SKILL.md", offset: 1, limit: 5 },
        mockToolCallOptions
      )
    );

    const parsed = AgentSkillReadFileToolResultSchema.safeParse(raw);
    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      throw new Error(parsed.error.message);
    }

    const result = parsed.data;
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.content).toMatch(/name:\s*project-skill/i);
    }
  });

  describe("symlink safety", () => {
    it("rejects reads from a symlinked skill directory", async () => {
      using tempDir = new TestTempDir("test-agent-skill-read-file-symlinked-dir");

      const skillsRoot = path.join(tempDir.path, ".mux", "skills");
      const externalDir = path.join(tempDir.path, "external-skill-source");
      await fs.mkdir(externalDir, { recursive: true });
      await fs.writeFile(
        path.join(externalDir, "SKILL.md"),
        "---\nname: evil\ndescription: test\n---\nBody\n",
        "utf-8"
      );
      await fs.writeFile(path.join(externalDir, "secret.txt"), "top secret", "utf-8");

      await fs.mkdir(skillsRoot, { recursive: true });
      await fs.symlink(
        externalDir,
        path.join(skillsRoot, "evil"),
        process.platform === "win32" ? "junction" : "dir"
      );

      const baseConfig = createTestToolConfig(tempDir.path, {
        workspaceId: "regular-workspace",
      });
      const tool = createAgentSkillReadFileTool(baseConfig);

      const raw: unknown = await Promise.resolve(
        tool.execute!({ name: "evil", filePath: "secret.txt" }, mockToolCallOptions)
      );

      const parsed = AgentSkillReadFileToolResultSchema.safeParse(raw);
      expect(parsed.success).toBe(true);
      if (!parsed.success) {
        throw new Error(parsed.error.message);
      }

      const result = parsed.data;
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toMatch(/symbolic link/i);
      }
    });

    it("rejects reads from a symlinked file that escapes containment", async () => {
      using tempDir = new TestTempDir("test-agent-skill-read-file-symlinked-file");
      await writeProjectSkill(tempDir.path, "real-skill");

      const skillDir = path.join(tempDir.path, ".mux", "skills", "real-skill");
      const externalFile = path.join(tempDir.path, "external-secret.txt");
      await fs.writeFile(externalFile, "outside skill", "utf-8");
      await fs.symlink(externalFile, path.join(skillDir, "link.txt"), "file");

      const baseConfig = createTestToolConfig(tempDir.path, {
        workspaceId: "regular-workspace",
      });
      const tool = createAgentSkillReadFileTool(baseConfig);

      const raw: unknown = await Promise.resolve(
        tool.execute!({ name: "real-skill", filePath: "link.txt" }, mockToolCallOptions)
      );

      const parsed = AgentSkillReadFileToolResultSchema.safeParse(raw);
      expect(parsed.success).toBe(true);
      if (!parsed.success) {
        throw new Error(parsed.error.message);
      }

      const result = parsed.data;
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toMatch(/escape|outside|symlink/i);
      }
    });
  });
});
