import * as fs from "node:fs/promises";
import * as path from "node:path";

import { describe, it, expect } from "bun:test";
import type { ToolExecutionOptions } from "ai";

import { MUX_HELP_CHAT_WORKSPACE_ID } from "@/common/constants/muxChat";
import { FILE_EDIT_DIFF_OMITTED_MESSAGE } from "@/common/types/tools";
import type { AgentSkillWriteToolResult } from "@/common/types/tools";
import { createAgentSkillWriteTool } from "./agent_skill_write";
import { SKILL_FILENAME } from "./skillFileUtils";
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

function skillMarkdown(
  name: string,
  options?: { description?: string; advertise?: boolean; body?: string }
): string {
  const advertiseLine =
    options?.advertise === undefined ? "" : `advertise: ${options.advertise ? "true" : "false"}\n`;

  return [
    "---",
    `name: ${name}`,
    `description: ${options?.description ?? `description for ${name}`}`,
    advertiseLine.trimEnd(),
    "---",
    options?.body ?? "Body",
    "",
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

async function createWriteTool(muxHome: string, workspaceId: string = MUX_HELP_CHAT_WORKSPACE_ID) {
  const workspaceSessionDir = await createWorkspaceSessionDir(muxHome, workspaceId);
  const config = createTestToolConfig(muxHome, {
    workspaceId,
    sessionsDir: workspaceSessionDir,
  });

  return createAgentSkillWriteTool(config);
}

describe("agent_skill_write", () => {
  it("rejects writes outside Chat with Mux workspace", async () => {
    using tempDir = new TestTempDir("test-agent-skill-write-reject");

    const tool = await createWriteTool(tempDir.path, "regular-workspace");
    const result = (await tool.execute!(
      { name: "demo-skill", content: skillMarkdown("demo-skill") },
      mockToolCallOptions
    )) as AgentSkillWriteToolResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/only available/i);
    }
  });

  it("creates SKILL.md for a new global skill", async () => {
    using tempDir = new TestTempDir("test-agent-skill-write-create");

    const tool = await createWriteTool(tempDir.path);
    const content = skillMarkdown("demo-skill");

    const result = (await tool.execute!(
      { name: "demo-skill", content },
      mockToolCallOptions
    )) as AgentSkillWriteToolResult;

    expect(result.success).toBe(true);

    const stored = await fs.readFile(
      path.join(tempDir.path, "skills", "demo-skill", "SKILL.md"),
      "utf-8"
    );
    expect(stored).toBe(content);
  });

  it("updates SKILL.md and returns ui_only diff payload", async () => {
    using tempDir = new TestTempDir("test-agent-skill-write-update");

    const tool = await createWriteTool(tempDir.path);

    const initialContent = skillMarkdown("demo-skill", { body: "Body" });
    const initialResult = (await tool.execute!(
      { name: "demo-skill", content: initialContent },
      mockToolCallOptions
    )) as AgentSkillWriteToolResult;
    expect(initialResult.success).toBe(true);

    const updatedContent = skillMarkdown("demo-skill", { body: "Updated body" });
    const updateResult = (await tool.execute!(
      { name: "demo-skill", content: updatedContent },
      mockToolCallOptions
    )) as AgentSkillWriteToolResult;

    expect(updateResult.success).toBe(true);
    if (updateResult.success) {
      expect(updateResult.diff).toBe(FILE_EDIT_DIFF_OMITTED_MESSAGE);
      expect(updateResult.ui_only?.file_edit?.diff).toContain("SKILL.md");
      expect(updateResult.ui_only?.file_edit?.diff).toContain("Updated body");
    }

    const stored = await fs.readFile(
      path.join(tempDir.path, "skills", "demo-skill", "SKILL.md"),
      "utf-8"
    );
    expect(stored).toBe(updatedContent);
  });

  it("rejects invalid SKILL.md frontmatter", async () => {
    using tempDir = new TestTempDir("test-agent-skill-write-invalid-frontmatter");

    const tool = await createWriteTool(tempDir.path);

    const result = (await tool.execute!(
      { name: "demo-skill", content: "not-frontmatter" },
      mockToolCallOptions
    )) as AgentSkillWriteToolResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/frontmatter/i);
    }
  });

  describe("SKILL.md casing canonicalization", () => {
    it("validates SKILL.md content even with lowercase filePath", async () => {
      using tempDir = new TestTempDir("test-agent-skill-write-lowercase-skillmd");

      const tool = await createWriteTool(tempDir.path);

      const result = (await tool.execute!(
        {
          name: "demo-skill",
          filePath: "skill.md",
          content: "not-frontmatter",
        },
        mockToolCallOptions
      )) as AgentSkillWriteToolResult;

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toMatch(/frontmatter/i);
      }
    });

    it("injects frontmatter name for case-variant filePath", async () => {
      using tempDir = new TestTempDir("test-agent-skill-write-case-variant-name-injection");

      const tool = await createWriteTool(tempDir.path);
      const contentWithMismatchedName = skillMarkdown("wrong-name", {
        description: "description for demo-skill",
      });

      const result = (await tool.execute!(
        {
          name: "demo-skill",
          filePath: "Skill.md",
          content: contentWithMismatchedName,
        },
        mockToolCallOptions
      )) as AgentSkillWriteToolResult;

      expect(result.success).toBe(true);

      const stored = await fs.readFile(
        path.join(tempDir.path, "skills", "demo-skill", SKILL_FILENAME),
        "utf-8"
      );
      expect(stored).toContain("name: demo-skill");
      expect(stored).not.toContain("name: wrong-name");
    });

    it("writes to canonical SKILL.md path regardless of input casing", async () => {
      using tempDir = new TestTempDir("test-agent-skill-write-canonical-skillmd-path");

      const tool = await createWriteTool(tempDir.path);
      const content = skillMarkdown("demo-skill", { body: "Canonical body" });

      const result = (await tool.execute!(
        {
          name: "demo-skill",
          filePath: "SKILL.MD",
          content,
        },
        mockToolCallOptions
      )) as AgentSkillWriteToolResult;

      expect(result.success).toBe(true);

      const canonicalPath = path.join(tempDir.path, "skills", "demo-skill", SKILL_FILENAME);
      const stored = await fs.readFile(canonicalPath, "utf-8");
      expect(stored).toBe(content);
    });
  });

  it("name-mismatch injection preserves all other formatting", async () => {
    using tempDir = new TestTempDir("test-agent-skill-write-name-mismatch");

    const tool = await createWriteTool(tempDir.path);

    const originalContent = [
      "---",
      'name  : "Holistic Design"',
      "description: >-",
      "  Keep this wording exactly as authored.",
      "  Preserve wrapping and punctuation: colon: yes.",
      'compatibility: "mux >= 1.0"',
      "metadata:",
      '  owner: "docs-team"',
      "advertise: false",
      "---",
      "Body line 1",
      "",
      "Body line 3",
      "",
    ].join("\n");

    const result = (await tool.execute!(
      {
        name: "holistic-design",
        content: originalContent,
      },
      mockToolCallOptions
    )) as AgentSkillWriteToolResult;

    expect(result.success).toBe(true);

    const stored = await fs.readFile(
      path.join(tempDir.path, "skills", "holistic-design", "SKILL.md"),
      "utf-8"
    );

    const expectedContent = originalContent.replace(
      'name  : "Holistic Design"',
      "name: holistic-design"
    );
    expect(stored).toBe(expectedContent);

    const originalLines = originalContent.split("\n");
    const storedLines = stored.split("\n");
    const changedLineIndexes = originalLines.flatMap((line, index) =>
      line === storedLines[index] ? [] : [index]
    );

    expect(changedLineIndexes).toEqual([1]);
  });

  it("missing-name insertion preserves existing content", async () => {
    using tempDir = new TestTempDir("test-agent-skill-write-name-missing");

    const tool = await createWriteTool(tempDir.path);

    const originalContent = [
      "---",
      "description: >-",
      "  Keep this exact text.",
      "  Preserve order and spacing.",
      'compatibility: "mux >= 1.0"',
      "metadata:",
      "  owner: docs-team",
      "---",
      "Body",
      "",
    ].join("\n");

    const result = (await tool.execute!(
      {
        name: "demo-skill",
        content: originalContent,
      },
      mockToolCallOptions
    )) as AgentSkillWriteToolResult;

    expect(result.success).toBe(true);

    const stored = await fs.readFile(
      path.join(tempDir.path, "skills", "demo-skill", "SKILL.md"),
      "utf-8"
    );

    const expectedContent = [
      "---",
      "name: demo-skill",
      ...originalContent.split("\n").slice(1),
    ].join("\n");
    expect(stored).toBe(expectedContent);

    const storedLines = stored.split("\n");
    expect(storedLines[1]).toBe("name: demo-skill");
    expect([storedLines[0], ...storedLines.slice(2)]).toEqual(originalContent.split("\n"));
  });

  it("writes reference files within the skill directory", async () => {
    using tempDir = new TestTempDir("test-agent-skill-write-reference");

    const tool = await createWriteTool(tempDir.path);

    const createResult = (await tool.execute!(
      { name: "demo-skill", content: skillMarkdown("demo-skill") },
      mockToolCallOptions
    )) as AgentSkillWriteToolResult;
    expect(createResult.success).toBe(true);

    const refResult = (await tool.execute!(
      {
        name: "demo-skill",
        filePath: "references/foo.txt",
        content: "reference content",
      },
      mockToolCallOptions
    )) as AgentSkillWriteToolResult;

    expect(refResult.success).toBe(true);

    const referencePath = path.join(tempDir.path, "skills", "demo-skill", "references", "foo.txt");
    const stored = await fs.readFile(referencePath, "utf-8");
    expect(stored).toBe("reference content");
  });

  it.each(["/etc/passwd", "../escape", "~/bad"])(
    "rejects invalid filePath %s",
    async (filePathValue) => {
      using tempDir = new TestTempDir("test-agent-skill-write-invalid-path");

      const tool = await createWriteTool(tempDir.path);
      const result = (await tool.execute!(
        {
          name: "demo-skill",
          filePath: filePathValue,
          content: "text",
        },
        mockToolCallOptions
      )) as AgentSkillWriteToolResult;

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toMatch(/Invalid filePath|path traversal/i);
      }
    }
  );

  it("rejects writes when skills root is a symlink", async () => {
    using tempDir = new TestTempDir("test-agent-skill-write-symlinked-root");
    const previousMuxRoot = process.env.MUX_ROOT;
    process.env.MUX_ROOT = tempDir.path;

    try {
      const externalDir = path.join(tempDir.path, "external-skills-tree");
      await fs.mkdir(externalDir, { recursive: true });

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

      const tool = createAgentSkillWriteTool(baseConfig);
      const result = (await tool.execute!(
        {
          name: "evil-skill",
          content: "---\nname: evil-skill\ndescription: test\n---\nBody\n",
        },
        mockToolCallOptions
      )) as AgentSkillWriteToolResult;

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toMatch(/symbolic link/i);
      }

      const externalEntries = await fs.readdir(externalDir);
      expect(externalEntries).toEqual([]);
    } finally {
      restoreMuxRoot(previousMuxRoot);
    }
  });

  it("rejects writes when skill directory is a symlink", async () => {
    using tempDir = new TestTempDir("test-agent-skill-write-symlinked-dir");

    const tool = await createWriteTool(tempDir.path);

    const externalDir = path.join(tempDir.path, "external-target");
    await fs.mkdir(externalDir, { recursive: true });
    await fs.mkdir(path.join(tempDir.path, "skills"), { recursive: true });
    await fs.symlink(externalDir, path.join(tempDir.path, "skills", "demo-skill"));

    const result = (await tool.execute!(
      { name: "demo-skill", content: skillMarkdown("demo-skill") },
      mockToolCallOptions
    )) as AgentSkillWriteToolResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/symlink/i);
    }

    const entries = await fs.readdir(externalDir);
    expect(entries).toEqual([]);
  });

  it("rejects writes when intermediate subdir is a symlinked escape", async () => {
    using tempDir = new TestTempDir("test-agent-skill-write-intermediate-symlink");

    const tool = await createWriteTool(tempDir.path);

    const skillDir = path.join(tempDir.path, "skills", "demo-skill");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, "SKILL.md"), skillMarkdown("demo-skill"), "utf-8");

    const externalDir = path.join(tempDir.path, "external-escape");
    await fs.mkdir(externalDir, { recursive: true });
    await fs.symlink(externalDir, path.join(skillDir, "references"));

    const result = (await tool.execute!(
      {
        name: "demo-skill",
        filePath: "references/secret.txt",
        content: "should not land here",
      },
      mockToolCallOptions
    )) as AgentSkillWriteToolResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/escape|symlink/i);
    }

    const entries = await fs.readdir(externalDir);
    expect(entries).toEqual([]);
  });

  it("rejects writes to symlink targets", async () => {
    using tempDir = new TestTempDir("test-agent-skill-write-symlink");

    const tool = await createWriteTool(tempDir.path);

    const skillDir = path.join(tempDir.path, "skills", "demo-skill");
    await fs.mkdir(skillDir, { recursive: true });

    const symlinkTarget = path.join(tempDir.path, "external-target.md");
    await fs.writeFile(symlinkTarget, "external", "utf-8");
    await fs.symlink(symlinkTarget, path.join(skillDir, "SKILL.md"));

    const result = (await tool.execute!(
      {
        name: "demo-skill",
        content: skillMarkdown("demo-skill"),
      },
      mockToolCallOptions
    )) as AgentSkillWriteToolResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/symlink/i);
    }
  });

  it("rejects internal symlink alias pointing to existing file", async () => {
    using tempDir = new TestTempDir("test-agent-skill-write-internal-alias-symlink");

    const tool = await createWriteTool(tempDir.path);

    const skillDir = path.join(tempDir.path, "skills", "demo-skill");
    await fs.mkdir(skillDir, { recursive: true });

    const skillPath = path.join(skillDir, "SKILL.md");
    const originalContent = skillMarkdown("demo-skill", { body: "Original body" });
    await fs.writeFile(skillPath, originalContent, "utf-8");
    await fs.symlink("SKILL.md", path.join(skillDir, "link.txt"));

    const result = (await tool.execute!(
      {
        name: "demo-skill",
        filePath: "link.txt",
        content: "new alias content",
      },
      mockToolCallOptions
    )) as AgentSkillWriteToolResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/symlink/i);
    }

    const stored = await fs.readFile(skillPath, "utf-8");
    expect(stored).toBe(originalContent);
  });
});
