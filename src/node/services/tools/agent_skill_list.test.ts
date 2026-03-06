import * as fs from "node:fs/promises";
import * as path from "node:path";

import { describe, expect, it } from "bun:test";
import type { ToolExecutionOptions } from "ai";

import type { AgentSkillDescriptor } from "@/common/types/agentSkill";
import type { AgentSkillListToolResult } from "@/common/types/tools";
import { createAgentSkillListTool } from "./agent_skill_list";
import { createTestToolConfig, TestTempDir } from "./testHelpers";

const mockToolCallOptions: ToolExecutionOptions = {
  toolCallId: "test-call-id",
  messages: [],
};

async function writeSkill(
  skillsRoot: string,
  name: string,
  options?: { description?: string; advertise?: boolean }
): Promise<void> {
  const skillDir = path.join(skillsRoot, name);
  await fs.mkdir(skillDir, { recursive: true });

  const advertiseLine =
    options?.advertise === undefined ? "" : `advertise: ${options.advertise ? "true" : "false"}\n`;

  await fs.writeFile(
    path.join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${options?.description ?? `description for ${name}`}\n${advertiseLine}---\nBody\n`,
    "utf-8"
  );
}

async function withMuxRoot(muxRoot: string, callback: () => Promise<void>): Promise<void> {
  const previousMuxRoot = process.env.MUX_ROOT;
  process.env.MUX_ROOT = muxRoot;

  try {
    await callback();
  } finally {
    if (previousMuxRoot === undefined) {
      delete process.env.MUX_ROOT;
    } else {
      process.env.MUX_ROOT = previousMuxRoot;
    }
  }
}

function getSkill(skills: AgentSkillDescriptor[], name: string): AgentSkillDescriptor {
  const skill = skills.find((candidate) => candidate.name === name);
  expect(skill).toBeDefined();
  return skill!;
}

describe("agent_skill_list", () => {
  it("lists effective available skills across project, global, and built-in scopes", async () => {
    using project = new TestTempDir("test-agent-skill-list-project");
    using muxHome = new TestTempDir("test-agent-skill-list-mux-home");

    await withMuxRoot(muxHome.path, async () => {
      await writeSkill(path.join(project.path, ".agents", "skills"), "project-only", {
        description: "from project",
      });
      await writeSkill(path.join(muxHome.path, "skills"), "global-only", {
        description: "from global",
      });

      const tool = createAgentSkillListTool(createTestToolConfig(project.path));
      const result = (await tool.execute!({}, mockToolCallOptions)) as AgentSkillListToolResult;

      expect(result.success).toBe(true);
      if (!result.success) {
        return;
      }

      expect(getSkill(result.skills, "project-only")).toMatchObject({
        name: "project-only",
        description: "from project",
        scope: "project",
      });
      expect(getSkill(result.skills, "global-only")).toMatchObject({
        name: "global-only",
        description: "from global",
        scope: "global",
      });
      expect(getSkill(result.skills, "init")).toMatchObject({
        name: "init",
        scope: "built-in",
      });
    });
  });

  it("returns only the winning descriptor when project skills shadow global skills", async () => {
    using project = new TestTempDir("test-agent-skill-list-shadow-project");
    using muxHome = new TestTempDir("test-agent-skill-list-shadow-home");

    await withMuxRoot(muxHome.path, async () => {
      await writeSkill(path.join(project.path, ".mux", "skills"), "shared-skill", {
        description: "from project",
      });
      await writeSkill(path.join(muxHome.path, "skills"), "shared-skill", {
        description: "from global",
      });

      const tool = createAgentSkillListTool(createTestToolConfig(project.path));
      const result = (await tool.execute!({}, mockToolCallOptions)) as AgentSkillListToolResult;

      expect(result.success).toBe(true);
      if (!result.success) {
        return;
      }

      const sharedSkills = result.skills.filter((skill) => skill.name === "shared-skill");
      expect(sharedSkills.length).toBe(1);
      expect(sharedSkills[0]).toMatchObject({
        name: "shared-skill",
        description: "from project",
        scope: "project",
      });
    });
  });

  it("filters unadvertised skills by default across scopes", async () => {
    using project = new TestTempDir("test-agent-skill-list-hidden-project");
    using muxHome = new TestTempDir("test-agent-skill-list-hidden-home");

    await withMuxRoot(muxHome.path, async () => {
      await writeSkill(path.join(project.path, ".mux", "skills"), "visible-project");
      await writeSkill(path.join(project.path, ".agents", "skills"), "hidden-project", {
        advertise: false,
      });
      await writeSkill(path.join(muxHome.path, "skills"), "hidden-global", {
        advertise: false,
      });

      const tool = createAgentSkillListTool(createTestToolConfig(project.path));
      const result = (await tool.execute!({}, mockToolCallOptions)) as AgentSkillListToolResult;

      expect(result.success).toBe(true);
      if (!result.success) {
        return;
      }

      expect(result.skills.some((skill) => skill.name === "visible-project")).toBe(true);
      expect(result.skills.some((skill) => skill.name === "hidden-project")).toBe(false);
      expect(result.skills.some((skill) => skill.name === "hidden-global")).toBe(false);
    });
  });

  it("includes unadvertised winning descriptors when includeUnadvertised is true", async () => {
    using project = new TestTempDir("test-agent-skill-list-include-hidden-project");
    using muxHome = new TestTempDir("test-agent-skill-list-include-hidden-home");

    await withMuxRoot(muxHome.path, async () => {
      await writeSkill(path.join(project.path, ".mux", "skills"), "project-hidden", {
        description: "hidden project winner",
        advertise: false,
      });
      await writeSkill(path.join(muxHome.path, "skills"), "global-hidden", {
        description: "hidden global winner",
        advertise: false,
      });
      await writeSkill(path.join(project.path, ".mux", "skills"), "shared-hidden", {
        description: "hidden project winner",
        advertise: false,
      });
      await writeSkill(path.join(muxHome.path, "skills"), "shared-hidden", {
        description: "hidden global loser",
        advertise: false,
      });

      const tool = createAgentSkillListTool(createTestToolConfig(project.path));
      const result = (await tool.execute!(
        { includeUnadvertised: true },
        mockToolCallOptions
      )) as AgentSkillListToolResult;

      expect(result.success).toBe(true);
      if (!result.success) {
        return;
      }

      expect(getSkill(result.skills, "project-hidden")).toMatchObject({
        name: "project-hidden",
        description: "hidden project winner",
        scope: "project",
        advertise: false,
      });
      expect(getSkill(result.skills, "global-hidden")).toMatchObject({
        name: "global-hidden",
        description: "hidden global winner",
        scope: "global",
        advertise: false,
      });
      expect(getSkill(result.skills, "shared-hidden")).toMatchObject({
        name: "shared-hidden",
        description: "hidden project winner",
        scope: "project",
        advertise: false,
      });
    });
  });

  it("returns a clear error when cwd is missing", async () => {
    using project = new TestTempDir("test-agent-skill-list-misconfigured");

    const config = {
      ...createTestToolConfig(project.path),
      cwd: "",
    };

    const tool = createAgentSkillListTool(config);
    const result = (await tool.execute!({}, mockToolCallOptions)) as AgentSkillListToolResult;

    expect(result).toEqual({
      success: false,
      error: "Tool misconfigured: cwd is required.",
    });
  });
});
