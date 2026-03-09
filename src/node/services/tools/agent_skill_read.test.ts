import * as fs from "node:fs/promises";
import * as path from "node:path";

import { describe, it, expect } from "bun:test";
import type { ToolExecutionOptions } from "ai";

import { AgentSkillReadToolResultSchema } from "@/common/utils/tools/toolDefinitions";
import { MUX_HELP_CHAT_WORKSPACE_ID } from "@/common/constants/muxChat";
import { createAgentSkillReadTool } from "./agent_skill_read";
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

describe("agent_skill_read", () => {
  it("allows reading built-in skills", async () => {
    using tempDir = new TestTempDir("test-agent-skill-read-mux-chat");
    const baseConfig = createTestToolConfig(tempDir.path, {
      workspaceId: MUX_HELP_CHAT_WORKSPACE_ID,
    });

    const tool = createAgentSkillReadTool(baseConfig);

    const raw: unknown = await Promise.resolve(
      tool.execute!({ name: "mux-docs" }, mockToolCallOptions)
    );

    const parsed = AgentSkillReadToolResultSchema.safeParse(raw);
    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      throw new Error(parsed.error.message);
    }

    const result = parsed.data;
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.skill.scope).toBe("built-in");
      expect(result.skill.frontmatter.name).toBe("mux-docs");
    }
  });

  it("allows reading global skills on disk in Chat with Mux workspace", async () => {
    using tempDir = new TestTempDir("test-agent-skill-read-global");
    const previousMuxRoot = process.env.MUX_ROOT;
    process.env.MUX_ROOT = tempDir.path;

    try {
      await writeGlobalSkill(tempDir.path, "foo");

      const baseConfig = createTestToolConfig(tempDir.path, {
        workspaceId: MUX_HELP_CHAT_WORKSPACE_ID,
      });
      const tool = createAgentSkillReadTool(baseConfig);

      const raw: unknown = await Promise.resolve(
        tool.execute!({ name: "foo" }, mockToolCallOptions)
      );

      const parsed = AgentSkillReadToolResultSchema.safeParse(raw);
      expect(parsed.success).toBe(true);
      if (!parsed.success) {
        throw new Error(parsed.error.message);
      }

      const result = parsed.data;
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.skill.scope).toBe("global");
        expect(result.skill.frontmatter.name).toBe("foo");
      }
    } finally {
      restoreMuxRoot(previousMuxRoot);
    }
  });

  it("allows reading project skills on disk outside Chat with Mux workspace", async () => {
    using tempDir = new TestTempDir("test-agent-skill-read-project");
    await writeProjectSkill(tempDir.path, "project-skill");

    const baseConfig = createTestToolConfig(tempDir.path, {
      workspaceId: "regular-workspace",
    });
    const tool = createAgentSkillReadTool(baseConfig);

    const raw: unknown = await Promise.resolve(
      tool.execute!({ name: "project-skill" }, mockToolCallOptions)
    );

    const parsed = AgentSkillReadToolResultSchema.safeParse(raw);
    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      throw new Error(parsed.error.message);
    }

    const result = parsed.data;
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.skill.scope).toBe("project");
      expect(result.skill.frontmatter.name).toBe("project-skill");
    }
  });
});
