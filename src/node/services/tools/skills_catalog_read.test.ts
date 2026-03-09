import { describe, expect, it, spyOn } from "bun:test";
import type { ToolExecutionOptions } from "ai";

import { MUX_HELP_CHAT_WORKSPACE_ID } from "@/common/constants/muxChat";
import type { SkillsCatalogReadToolResult } from "@/common/types/tools";
import { createSkillsCatalogReadTool } from "./skills_catalog_read";
import * as catalogFetch from "./skillsCatalogFetch";
import { createTestToolConfig, TestTempDir } from "./testHelpers";

const mockToolCallOptions: ToolExecutionOptions = {
  toolCallId: "test-call-id",
  messages: [],
};

const VALID_SKILL_MD = `---
name: test-skill
description: A test skill for unit testing
---
# Test Skill

This is the body of the skill.
`;

const SKILL_MD_WITH_ADVERTISE = `---
name: hidden-skill
description: A skill that should not be advertised
advertise: false
---
# Hidden Skill

This skill is not advertised.
`;

describe("skills_catalog_read", () => {
  it("rejects read outside Chat with Mux workspace", async () => {
    using tempDir = new TestTempDir("test-skills-catalog-read-reject");
    const config = createTestToolConfig(tempDir.path, {
      workspaceId: "regular-workspace",
    });

    const tool = createSkillsCatalogReadTool(config);
    const result = (await tool.execute!(
      { owner: "test", repo: "test", skillId: "test" },
      mockToolCallOptions
    )) as SkillsCatalogReadToolResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/only available/i);
    }
  });

  it("returns parsed skill content on success", async () => {
    using tempDir = new TestTempDir("test-skills-catalog-read-success");
    const config = createTestToolConfig(tempDir.path, {
      workspaceId: MUX_HELP_CHAT_WORKSPACE_ID,
    });

    const fetchContentSpy = spyOn(catalogFetch, "fetchSkillContent").mockResolvedValue({
      content: VALID_SKILL_MD,
      path: "skills/test-skill/SKILL.md",
      branch: "main",
    });

    const tool = createSkillsCatalogReadTool(config);
    const result = (await tool.execute!(
      { owner: "test-owner", repo: "test-repo", skillId: "test-skill" },
      mockToolCallOptions
    )) as SkillsCatalogReadToolResult;

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.frontmatter.name).toBe("test-skill");
      expect(result.frontmatter.description).toContain("test skill");
      expect(result.body).toContain("Test Skill");
      expect(result.url).toContain("test-owner/test-repo");
    }

    fetchContentSpy.mockRestore();
  });

  it("preserves canonical frontmatter fields such as advertise", async () => {
    using tempDir = new TestTempDir("test-skills-catalog-read-advertise");
    const config = createTestToolConfig(tempDir.path, {
      workspaceId: MUX_HELP_CHAT_WORKSPACE_ID,
    });

    const fetchContentSpy = spyOn(catalogFetch, "fetchSkillContent").mockResolvedValue({
      content: SKILL_MD_WITH_ADVERTISE,
      path: "skills/hidden-skill/SKILL.md",
      branch: "main",
    });

    const tool = createSkillsCatalogReadTool(config);
    const result = (await tool.execute!(
      { owner: "test-owner", repo: "test-repo", skillId: "hidden-skill" },
      mockToolCallOptions
    )) as SkillsCatalogReadToolResult;

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.frontmatter.name).toBe("hidden-skill");
      expect(result.frontmatter.advertise).toBe(false);
    }

    fetchContentSpy.mockRestore();
  });

  it("returns error when fetch fails", async () => {
    using tempDir = new TestTempDir("test-skills-catalog-read-fetch-fail");
    const config = createTestToolConfig(tempDir.path, {
      workspaceId: MUX_HELP_CHAT_WORKSPACE_ID,
    });

    const fetchContentSpy = spyOn(catalogFetch, "fetchSkillContent").mockRejectedValue(
      new Error("Could not find SKILL.md for skill 'missing-skill' in test-owner/test-repo")
    );

    const tool = createSkillsCatalogReadTool(config);
    const result = (await tool.execute!(
      { owner: "test-owner", repo: "test-repo", skillId: "missing-skill" },
      mockToolCallOptions
    )) as SkillsCatalogReadToolResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.length).toBeGreaterThan(0);
    }

    fetchContentSpy.mockRestore();
  });

  it("returns error on invalid SKILL.md content", async () => {
    using tempDir = new TestTempDir("test-skills-catalog-read-invalid-skill-md");
    const config = createTestToolConfig(tempDir.path, {
      workspaceId: MUX_HELP_CHAT_WORKSPACE_ID,
    });

    const fetchContentSpy = spyOn(catalogFetch, "fetchSkillContent").mockResolvedValue({
      content: "not valid yaml frontmatter",
      path: "skills/test-skill/SKILL.md",
      branch: "main",
    });

    const tool = createSkillsCatalogReadTool(config);
    const result = (await tool.execute!(
      { owner: "test-owner", repo: "test-repo", skillId: "test-skill" },
      mockToolCallOptions
    )) as SkillsCatalogReadToolResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.length).toBeGreaterThan(0);
    }

    fetchContentSpy.mockRestore();
  });
});
