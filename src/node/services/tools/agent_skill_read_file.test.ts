import * as fs from "node:fs/promises";
import * as path from "node:path";

import { describe, it, expect } from "bun:test";
import type { ToolCallOptions } from "ai";

import { MUX_CHAT_WORKSPACE_ID } from "@/common/constants/muxChat";
import { AgentSkillReadFileToolResultSchema } from "@/common/utils/tools/toolDefinitions";
import { createAgentSkillReadFileTool } from "./agent_skill_read_file";
import { createTestToolConfig, TestTempDir } from "./testHelpers";

const mockToolCallOptions: ToolCallOptions = {
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

describe("agent_skill_read_file (Chat with Mux sandbox)", () => {
  it("allows reading built-in skill files", async () => {
    using tempDir = new TestTempDir("test-agent-skill-read-file-mux-chat");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: MUX_CHAT_WORKSPACE_ID });

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

  it("rejects project/global skill file reads on disk", async () => {
    using tempDir = new TestTempDir("test-agent-skill-read-file-mux-chat-reject");
    await writeProjectSkill(tempDir.path, "foo");

    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: MUX_CHAT_WORKSPACE_ID });
    const tool = createAgentSkillReadFileTool(baseConfig);

    const raw: unknown = await Promise.resolve(
      tool.execute!({ name: "foo", filePath: "SKILL.md", offset: 1, limit: 5 }, mockToolCallOptions)
    );

    const parsed = AgentSkillReadFileToolResultSchema.safeParse(raw);
    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      throw new Error(parsed.error.message);
    }

    const result = parsed.data;
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/only built-in skills/i);
    }
  });
});
