import * as fs from "node:fs/promises";
import * as path from "node:path";

import { describe, it, expect } from "bun:test";
import type { ToolExecutionOptions } from "ai";

import { MUX_HELP_CHAT_WORKSPACE_ID } from "@/common/constants/muxChat";
import type { AgentSkillListToolResult } from "@/common/types/tools";
import { createAgentSkillListTool } from "./agent_skill_list";
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

async function writeGlobalSkill(
  muxHome: string,
  name: string,
  options?: { description?: string; advertise?: boolean }
): Promise<void> {
  const skillDir = path.join(muxHome, "skills", name);
  await fs.mkdir(skillDir, { recursive: true });

  const advertiseLine =
    options?.advertise === undefined ? "" : `advertise: ${options.advertise ? "true" : "false"}\n`;

  await fs.writeFile(
    path.join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${options?.description ?? `description for ${name}`}\n${advertiseLine}---\nBody\n`,
    "utf-8"
  );
}

describe("agent_skill_list", () => {
  it("rejects listing skills outside Chat with Mux workspace", async () => {
    using tempDir = new TestTempDir("test-agent-skill-list-reject");

    const workspaceSessionDir = await createWorkspaceSessionDir(tempDir.path, "regular-workspace");
    const config = createTestToolConfig(tempDir.path, {
      workspaceId: "regular-workspace",
      sessionsDir: workspaceSessionDir,
    });

    const tool = createAgentSkillListTool(config);
    const result = (await tool.execute!({}, mockToolCallOptions)) as AgentSkillListToolResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/only available/i);
    }
  });

  it("lists global skills from ~/.mux/skills", async () => {
    using tempDir = new TestTempDir("test-agent-skill-list-global");

    const workspaceSessionDir = await createWorkspaceSessionDir(
      tempDir.path,
      MUX_HELP_CHAT_WORKSPACE_ID
    );

    await writeGlobalSkill(tempDir.path, "zeta-skill");
    await writeGlobalSkill(tempDir.path, "alpha-skill");

    const config = createTestToolConfig(tempDir.path, {
      workspaceId: MUX_HELP_CHAT_WORKSPACE_ID,
      sessionsDir: workspaceSessionDir,
    });

    const tool = createAgentSkillListTool(config);
    const result = (await tool.execute!({}, mockToolCallOptions)) as AgentSkillListToolResult;

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.skills.map((skill) => skill.name)).toEqual(["alpha-skill", "zeta-skill"]);
      expect(result.skills.every((skill) => skill.scope === "global")).toBe(true);
    }
  });

  it("filters unadvertised skills unless includeUnadvertised is true", async () => {
    using tempDir = new TestTempDir("test-agent-skill-list-advertise");

    const workspaceSessionDir = await createWorkspaceSessionDir(
      tempDir.path,
      MUX_HELP_CHAT_WORKSPACE_ID
    );

    await writeGlobalSkill(tempDir.path, "advertised-skill");
    await writeGlobalSkill(tempDir.path, "hidden-skill", { advertise: false });

    const config = createTestToolConfig(tempDir.path, {
      workspaceId: MUX_HELP_CHAT_WORKSPACE_ID,
      sessionsDir: workspaceSessionDir,
    });

    const tool = createAgentSkillListTool(config);

    const defaultResult = (await tool.execute!(
      {},
      mockToolCallOptions
    )) as AgentSkillListToolResult;
    expect(defaultResult.success).toBe(true);
    if (defaultResult.success) {
      expect(defaultResult.skills.map((skill) => skill.name)).toEqual(["advertised-skill"]);
    }

    const includeAllResult = (await tool.execute!(
      { includeUnadvertised: true },
      mockToolCallOptions
    )) as AgentSkillListToolResult;
    expect(includeAllResult.success).toBe(true);
    if (includeAllResult.success) {
      expect(includeAllResult.skills.map((skill) => skill.name)).toEqual([
        "advertised-skill",
        "hidden-skill",
      ]);
    }
  });
});
