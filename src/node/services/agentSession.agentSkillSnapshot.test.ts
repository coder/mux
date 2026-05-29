import { describe, expect, it, mock, afterEach, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { createMuxMessage, type MuxMessage } from "@/common/types/message";
import { Ok } from "@/common/types/result";

import { createAgentSessionHarness } from "./agentSession.testHarness";

describe("AgentSession.sendMessage (agent skill snapshots)", () => {
  async function createTestWorkspaceWithSkills(args: {
    skills: Array<{ skillName: string; skillBody: string }>;
  }) {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mux-agent-skill-"));

    for (const skill of args.skills) {
      const skillDir = path.join(tmp, ".mux", "skills", skill.skillName);
      await fs.mkdir(skillDir, { recursive: true });

      const skillMarkdown = `---\nname: ${skill.skillName}\ndescription: Test skill\n---\n\n${skill.skillBody}\n`;
      await fs.writeFile(path.join(skillDir, "SKILL.md"), skillMarkdown, "utf-8");
    }

    return { workspacePath: tmp };
  }

  async function createTestWorkspaceWithSkill(args: { skillName: string; skillBody: string }) {
    return createTestWorkspaceWithSkills({ skills: [args] });
  }

  let historyCleanup: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await historyCleanup?.();
  });

  function getMessageText(message: MuxMessage): string {
    const textPart = message.parts.find((part) => part.type === "text");
    if (textPart?.type !== "text") {
      throw new Error(`Expected text part for message ${message.id}`);
    }
    return textPart.text;
  }

  async function createSessionHarness(args: {
    workspacePath: string;
    workspaceId?: string;
    runtimeConfig?: FrontendWorkspaceMetadata["runtimeConfig"];
  }) {
    const workspaceId = args.workspaceId ?? "ws-test";
    const workspaceMeta: FrontendWorkspaceMetadata = {
      id: workspaceId,
      name: "ws",
      projectName: "proj",
      projectPath: args.workspacePath,
      namedWorkspacePath: args.workspacePath,
      runtimeConfig: args.runtimeConfig ?? { type: "local" },
    } as unknown as FrontendWorkspaceMetadata;
    const { session, historyService, cleanup } = await createAgentSessionHarness({
      workspaceId,
      aiServiceOverrides: {
        getWorkspaceMetadata: mock((_workspaceId: string) => Promise.resolve(Ok(workspaceMeta))),
      },
    });
    historyCleanup = cleanup;

    const messages: MuxMessage[] = [];
    const realAppend = historyService.appendToHistory.bind(historyService);
    const appendToHistory = spyOn(historyService, "appendToHistory").mockImplementation(
      async (wId: string, message: MuxMessage) => {
        messages.push(message);
        return realAppend(wId, message);
      }
    );

    return { session, appendToHistory, messages, historyService };
  }

  it("persists a synthetic agent skill snapshot before the user message", async () => {
    const workspaceId = "ws-test";

    const { workspacePath } = await createTestWorkspaceWithSkill({
      skillName: "test-skill",
      skillBody: "Follow this skill.",
    });

    const { session, appendToHistory, messages } = await createSessionHarness({
      workspaceId,
      workspacePath,
    });

    const result = await session.sendMessage("do X", {
      model: "anthropic:claude-3-5-sonnet-latest",
      agentId: "exec",
      muxMetadata: {
        type: "agent-skill",
        rawCommand: "/test-skill do X",
        skillName: "test-skill",
        scope: "project",
      },
    });

    expect(result.success).toBe(true);

    expect(appendToHistory.mock.calls).toHaveLength(2);
    const [snapshotMessage, userMessage] = messages;

    expect(snapshotMessage.role).toBe("user");
    expect(snapshotMessage.metadata?.synthetic).toBe(true);
    expect(snapshotMessage.metadata?.agentSkillSnapshot?.skillName).toBe("test-skill");
    expect(snapshotMessage.metadata?.agentSkillSnapshot?.sha256).toBeTruthy();

    const frontmatterYaml = snapshotMessage.metadata?.agentSkillSnapshot?.frontmatterYaml;
    expect(frontmatterYaml).toBeTruthy();
    expect(frontmatterYaml ?? "").toContain("name:");
    expect(frontmatterYaml ?? "").toContain("description:");

    const snapshotText = snapshotMessage.parts.find((p) => p.type === "text")?.text;
    expect(snapshotText).toContain("<agent-skill");
    expect(snapshotText).toContain("Follow this skill.");

    expect(userMessage.role).toBe("user");
    const userText = userMessage.parts.find((p) => p.type === "text")?.text;
    expect(userText).toBe("do X");
  });

  it("honors disableWorkspaceAgents when resolving skill snapshots", async () => {
    const workspaceId = "ws-test";

    const { workspacePath: projectPath } = await createTestWorkspaceWithSkill({
      // Built-in: use a project-local override to ensure we don't accidentally fall back.
      skillName: "init",
      skillBody: "Project override for init skill.",
    });

    const srcBaseDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-agent-skill-src-"));

    const { session, appendToHistory, messages } = await createSessionHarness({
      workspaceId,
      workspacePath: projectPath,
      runtimeConfig: { type: "worktree", srcBaseDir },
    });

    const result = await session.sendMessage("do X", {
      model: "anthropic:claude-3-5-sonnet-latest",
      agentId: "exec",
      disableWorkspaceAgents: true,
      muxMetadata: {
        type: "agent-skill",
        rawCommand: "/init",
        skillName: "init",
        scope: "project",
      },
    });

    expect(result.success).toBe(true);

    expect(appendToHistory.mock.calls).toHaveLength(2);
    const [snapshotMessage] = messages;

    const snapshotText = snapshotMessage.parts.find((p) => p.type === "text")?.text;
    expect(snapshotText).toContain("Project override for init skill.");
  });

  it("dedupes identical skill snapshots when recently inserted", async () => {
    const workspaceId = "ws-test";

    const { workspacePath } = await createTestWorkspaceWithSkill({
      skillName: "test-skill",
      skillBody: "Follow this skill.",
    });

    const { session, appendToHistory } = await createSessionHarness({
      workspaceId,
      workspacePath,
    });

    const baseOptions = {
      model: "anthropic:claude-3-5-sonnet-latest",
      agentId: "exec",
      muxMetadata: {
        type: "agent-skill",
        rawCommand: "/test-skill do X",
        skillName: "test-skill",
        scope: "project",
      },
    };

    const first = await session.sendMessage("do X", baseOptions);
    expect(first.success).toBe(true);
    expect(appendToHistory.mock.calls).toHaveLength(2);

    const second = await session.sendMessage("do Y", {
      ...baseOptions,
      muxMetadata: {
        ...baseOptions.muxMetadata,
        rawCommand: "/test-skill do Y",
      },
    });

    expect(second.success).toBe(true);
    // First send: snapshot + user. Second send: user only.
    expect(appendToHistory.mock.calls).toHaveLength(3);

    const appendedIds = appendToHistory.mock.calls.map((call) => call[1].id);
    const secondSendAppendedIds = appendedIds.slice(2);
    expect(secondSendAppendedIds).toHaveLength(1);
    expect(secondSendAppendedIds[0]).toStartWith("user-");
  });

  it("persists a new skill snapshot when frontmatter changes (body unchanged)", async () => {
    const workspaceId = "ws-test";

    const skillName = "test-skill";
    const skillBody = "Follow this skill.";

    const { workspacePath } = await createTestWorkspaceWithSkill({
      skillName,
      skillBody,
    });

    const { session, appendToHistory, messages } = await createSessionHarness({
      workspaceId,
      workspacePath,
    });

    const baseOptions = {
      model: "anthropic:claude-3-5-sonnet-latest",
      agentId: "exec",
      muxMetadata: {
        type: "agent-skill",
        rawCommand: "/test-skill do X",
        skillName,
        scope: "project",
      },
    };

    const first = await session.sendMessage("do X", baseOptions);
    expect(first.success).toBe(true);
    expect(appendToHistory.mock.calls).toHaveLength(2);

    const firstSnapshot = messages[0];
    expect(firstSnapshot.id).toStartWith("agent-skill-snapshot-");

    const firstSnapshotText = firstSnapshot.parts.find((p) => p.type === "text")?.text;
    expect(firstSnapshotText).toBeTruthy();

    const firstSha = firstSnapshot.metadata?.agentSkillSnapshot?.sha256;
    expect(firstSha).toBeTruthy();

    // Update frontmatter only.
    const skillFilePath = path.join(workspacePath, ".mux", "skills", skillName, "SKILL.md");
    const updatedSkillMarkdown = `---\nname: ${skillName}\ndescription: Updated description\n---\n\n${skillBody}\n`;
    await fs.writeFile(skillFilePath, updatedSkillMarkdown, "utf-8");

    const second = await session.sendMessage("do Y", {
      ...baseOptions,
      muxMetadata: {
        ...baseOptions.muxMetadata,
        rawCommand: "/test-skill do Y",
      },
    });

    expect(second.success).toBe(true);

    // Second send should persist a new snapshot (frontmatter differs) + user message.
    expect(appendToHistory.mock.calls).toHaveLength(4);

    const secondSnapshot = messages[2];
    expect(secondSnapshot.id).toStartWith("agent-skill-snapshot-");

    const secondSnapshotText = secondSnapshot.parts.find((p) => p.type === "text")?.text;
    expect(secondSnapshotText).toBe(firstSnapshotText);

    const secondSha = secondSnapshot.metadata?.agentSkillSnapshot?.sha256;
    expect(secondSha).toBeTruthy();
    expect(secondSha).not.toBe(firstSha);

    const secondFrontmatter = secondSnapshot.metadata?.agentSkillSnapshot?.frontmatterYaml;
    expect(secondFrontmatter ?? "").toContain("Updated description");
  });

  it("materializes multiple snapshots for plural agentSkillRefs", async () => {
    const { workspacePath } = await createTestWorkspaceWithSkills({
      skills: [
        { skillName: "alpha-skill", skillBody: "Follow alpha." },
        { skillName: "beta-skill", skillBody: "Follow beta." },
      ],
    });
    const { session, appendToHistory, messages } = await createSessionHarness({ workspacePath });

    const result = await session.sendMessage("do X", {
      model: "anthropic:claude-3-5-sonnet-latest",
      agentId: "exec",
      muxMetadata: {
        type: "normal",
        agentSkillRefs: [
          { skillName: "alpha-skill", scope: "project", source: "inline" },
          { skillName: "beta-skill", scope: "project", source: "inline" },
        ],
      },
    });

    expect(result.success).toBe(true);
    expect(appendToHistory.mock.calls).toHaveLength(3);

    const [alphaSnapshot, betaSnapshot, userMessage] = messages;
    expect(alphaSnapshot.metadata?.synthetic).toBe(true);
    expect(alphaSnapshot.metadata?.agentSkillSnapshot?.skillName).toBe("alpha-skill");
    expect(getMessageText(alphaSnapshot)).toContain("Follow alpha.");

    expect(betaSnapshot.metadata?.synthetic).toBe(true);
    expect(betaSnapshot.metadata?.agentSkillSnapshot?.skillName).toBe("beta-skill");
    expect(getMessageText(betaSnapshot)).toContain("Follow beta.");

    expect(userMessage.role).toBe("user");
    expect(getMessageText(userMessage)).toBe("do X");
  });

  it("dedupes slash + inline refs for the same skill, slash wins", async () => {
    const { workspacePath } = await createTestWorkspaceWithSkill({
      skillName: "test-skill",
      skillBody: "Follow slash skill.",
    });
    const { session, appendToHistory, messages } = await createSessionHarness({ workspacePath });

    const result = await session.sendMessage("do X", {
      model: "anthropic:claude-3-5-sonnet-latest",
      agentId: "exec",
      muxMetadata: {
        type: "agent-skill",
        rawCommand: "/test-skill do X",
        skillName: "test-skill",
        scope: "project",
        agentSkillRefs: [{ skillName: "test-skill", scope: "global", source: "inline" }],
      },
    });

    expect(result.success).toBe(true);
    expect(appendToHistory.mock.calls).toHaveLength(2);

    const [snapshotMessage, userMessage] = messages;
    expect(snapshotMessage.metadata?.synthetic).toBe(true);
    expect(snapshotMessage.metadata?.agentSkillSnapshot?.skillName).toBe("test-skill");
    expect(snapshotMessage.metadata?.agentSkillSnapshot?.scope).toBe("project");
    expect(getMessageText(snapshotMessage)).toContain("Follow slash skill.");
    expect(getMessageText(userMessage)).toBe("do X");
  });

  it("skips inline refs with invalid skill names silently", async () => {
    const { workspacePath } = await createTestWorkspaceWithSkill({
      skillName: "valid-skill",
      skillBody: "Follow valid skill.",
    });
    const { session, appendToHistory, messages } = await createSessionHarness({ workspacePath });

    const result = await session.sendMessage("do X", {
      model: "anthropic:claude-3-5-sonnet-latest",
      agentId: "exec",
      muxMetadata: {
        type: "normal",
        agentSkillRefs: [
          { skillName: "Invalid_Name", scope: "project", source: "inline" },
          { skillName: "valid-skill", scope: "project", source: "inline" },
        ],
      },
    });

    expect(result.success).toBe(true);
    expect(appendToHistory.mock.calls).toHaveLength(2);
    expect(messages[0].metadata?.agentSkillSnapshot?.skillName).toBe("valid-skill");
    expect(getMessageText(messages[0])).toContain("Follow valid skill.");
    expect(getMessageText(messages[1])).toBe("do X");
  });

  it("skips inline refs whose skill cannot be read silently", async () => {
    const { workspacePath } = await createTestWorkspaceWithSkill({
      skillName: "alpha-skill",
      skillBody: "Follow alpha.",
    });
    const { session, appendToHistory, messages } = await createSessionHarness({ workspacePath });

    const result = await session.sendMessage("do X", {
      model: "anthropic:claude-3-5-sonnet-latest",
      agentId: "exec",
      muxMetadata: {
        type: "normal",
        agentSkillRefs: [
          { skillName: "alpha-skill", scope: "project", source: "inline" },
          { skillName: "missing-skill", scope: "project", source: "inline" },
        ],
      },
    });

    expect(result.success).toBe(true);
    expect(appendToHistory.mock.calls).toHaveLength(2);
    expect(messages[0].metadata?.agentSkillSnapshot?.skillName).toBe("alpha-skill");
    expect(getMessageText(messages[0])).toContain("Follow alpha.");
    expect(getMessageText(messages[1])).toBe("do X");
  });

  it("still throws when a slash skill name is invalid", async () => {
    const { workspacePath } = await createTestWorkspaceWithSkills({ skills: [] });
    const { session, appendToHistory } = await createSessionHarness({ workspacePath });

    const result = await session.sendMessage("do X", {
      model: "anthropic:claude-3-5-sonnet-latest",
      agentId: "exec",
      muxMetadata: {
        type: "agent-skill",
        rawCommand: "/Invalid_Name do X",
        skillName: "Invalid_Name",
        scope: "project",
      },
    });

    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error("Expected invalid slash skill send to fail");
    }
    expect(result.error.type).toBe("unknown");
    if (result.error.type !== "unknown") {
      throw new Error("Expected invalid slash skill failure to use unknown error shape");
    }
    expect(result.error.raw).toContain("Invalid agent skill name");
    expect(appendToHistory.mock.calls).toHaveLength(0);
  });

  it("still throws when a slash skill is missing", async () => {
    const { workspacePath } = await createTestWorkspaceWithSkills({ skills: [] });
    const { session, appendToHistory } = await createSessionHarness({ workspacePath });

    const result = await session.sendMessage("do X", {
      model: "anthropic:claude-3-5-sonnet-latest",
      agentId: "exec",
      muxMetadata: {
        type: "agent-skill",
        rawCommand: "/missing-skill do X",
        skillName: "missing-skill",
        scope: "project",
      },
    });

    expect(result.success).toBe(false);
    expect(appendToHistory.mock.calls).toHaveLength(0);
  });

  it("dedupes against recent history per-skill", async () => {
    const { workspacePath } = await createTestWorkspaceWithSkills({
      skills: [
        { skillName: "alpha-skill", skillBody: "Follow alpha." },
        { skillName: "beta-skill", skillBody: "Follow beta." },
      ],
    });
    const { session, appendToHistory, messages } = await createSessionHarness({ workspacePath });

    const first = await session.sendMessage("first", {
      model: "anthropic:claude-3-5-sonnet-latest",
      agentId: "exec",
      muxMetadata: {
        type: "normal",
        agentSkillRefs: [{ skillName: "alpha-skill", scope: "project", source: "inline" }],
      },
    });
    expect(first.success).toBe(true);
    expect(appendToHistory.mock.calls).toHaveLength(2);

    const second = await session.sendMessage("second", {
      model: "anthropic:claude-3-5-sonnet-latest",
      agentId: "exec",
      muxMetadata: {
        type: "normal",
        agentSkillRefs: [
          { skillName: "alpha-skill", scope: "project", source: "inline" },
          { skillName: "beta-skill", scope: "project", source: "inline" },
        ],
      },
    });

    expect(second.success).toBe(true);
    expect(appendToHistory.mock.calls).toHaveLength(4);
    expect(messages[2].metadata?.agentSkillSnapshot?.skillName).toBe("beta-skill");
    expect(getMessageText(messages[2])).toContain("Follow beta.");
    expect(getMessageText(messages[3])).toBe("second");
  });

  it("truncates edits starting from preceding skill/file snapshots", async () => {
    const workspaceId = "ws-test";

    const fileSnapshotId = "file-snapshot-0";
    const skillSnapshotId = "agent-skill-snapshot-0";
    const userMessageId = "user-0";

    const historyMessages: MuxMessage[] = [
      createMuxMessage(fileSnapshotId, "user", "<file>...</file>", {
        historySequence: 0,
        synthetic: true,
        fileAtMentionSnapshot: ["@file:foo.txt"],
      }),
      createMuxMessage(skillSnapshotId, "user", "<agent-skill>...</agent-skill>", {
        historySequence: 1,
        synthetic: true,
        agentSkillSnapshot: {
          skillName: "test-skill",
          scope: "project",
          sha256: "abc",
        },
      }),
      createMuxMessage(userMessageId, "user", "do X", {
        historySequence: 2,
        muxMetadata: {
          type: "agent-skill",
          rawCommand: "/test-skill do X",
          skillName: "test-skill",
          scope: "project",
        },
      }),
    ];

    const { session, historyService, cleanup } = await createAgentSessionHarness({ workspaceId });
    historyCleanup = cleanup;

    // Seed history messages before setting up spies
    for (const msg of historyMessages) {
      await historyService.appendToHistory(workspaceId, msg);
    }

    const truncateAfterMessage = spyOn(historyService, "truncateAfterMessage");
    spyOn(historyService, "appendToHistory");

    const result = await session.sendMessage("edited", {
      model: "anthropic:claude-3-5-sonnet-latest",
      agentId: "exec",
      editMessageId: userMessageId,
    });

    expect(result.success).toBe(true);
    expect(truncateAfterMessage.mock.calls).toHaveLength(1);
    // Should truncate from the earliest contiguous snapshot (file snapshot).
    expect(truncateAfterMessage.mock.calls[0][1]).toBe(fileSnapshotId);
  });
});
