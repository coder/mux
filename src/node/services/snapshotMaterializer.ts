/**
 * Snapshot materializers for @file mentions and agent skills.
 *
 * These stateless functions read external content (files, skills) and produce
 * synthetic MuxMessages that are persisted to history for prompt-cache stability.
 * Extracted from AgentSession to keep that class focused on stream orchestration.
 */
import { createHash } from "crypto";
import YAML from "yaml";
import { SkillNameSchema } from "@/common/orpc/schemas";
import {
  createMuxMessage,
  type MuxFrontendMetadata,
  type MuxMessage,
} from "@/common/types/message";
import { createRuntime } from "@/node/runtime/runtimeFactory";
import { createRuntimeForWorkspace } from "@/node/runtime/runtimeHelpers";
import { readAgentSkill } from "@/node/services/agentSkills/agentSkillsService";
import { materializeFileAtMentions } from "@/node/services/fileAtMentions";
import {
  createFileSnapshotMessageId,
  createAgentSkillSnapshotMessageId,
} from "@/node/services/utils/messageIds";
import { log } from "@/node/services/log";
import type { FileState } from "@/node/services/utils/fileChangeTracker";
import type { AIService } from "@/node/services/aiService";
import type { HistoryService } from "@/node/services/historyService";

const MAX_AGENT_SKILL_SNAPSHOT_CHARS = 50_000;

/**
 * Materialize @file mentions from a user message into a persisted snapshot message.
 *
 * Reads the referenced files once and creates a synthetic message containing
 * their content. The snapshot is persisted to history so subsequent sends don't
 * re-read the files (which would bust prompt cache if files changed).
 *
 * Also registers file state for change detection via <system-file-update> diffs.
 *
 * @returns The snapshot message and list of materialized mentions, or null if no mentions found
 */
export async function materializeFileAtMentionsSnapshot(
  messageText: string,
  workspaceId: string,
  aiService: AIService,
  recordFileState: (filePath: string, state: FileState) => void
): Promise<{ snapshotMessage: MuxMessage; materializedTokens: string[] } | null> {
  // Guard for test mocks that may not implement getWorkspaceMetadata
  if (typeof aiService.getWorkspaceMetadata !== "function") {
    return null;
  }

  const metadataResult = await aiService.getWorkspaceMetadata(workspaceId);
  if (!metadataResult.success) {
    log.debug("Cannot materialize @file mentions: workspace metadata not found", {
      workspaceId,
    });
    return null;
  }

  const metadata = metadataResult.data;
  const runtime = createRuntimeForWorkspace(metadata);
  const workspacePath = runtime.getWorkspacePath(metadata.projectPath, metadata.name);

  const materialized = await materializeFileAtMentions(messageText, {
    runtime,
    workspacePath,
  });

  if (materialized.length === 0) {
    return null;
  }

  // Register file state for each successfully read file (for change detection)
  for (const mention of materialized) {
    if (
      mention.content !== undefined &&
      mention.modifiedTimeMs !== undefined &&
      mention.resolvedPath
    ) {
      recordFileState(mention.resolvedPath, {
        content: mention.content,
        timestamp: mention.modifiedTimeMs,
      });
    }
  }

  // Create a synthetic snapshot message (not persisted here — caller handles persistence)
  const tokens = materialized.map((m) => m.token);
  const blocks = materialized.map((m) => m.block).join("\n\n");

  const snapshotId = createFileSnapshotMessageId();
  const snapshotMessage = createMuxMessage(snapshotId, "user", blocks, {
    timestamp: Date.now(),
    synthetic: true,
    fileAtMentionSnapshot: tokens,
  });

  return { snapshotMessage, materializedTokens: tokens };
}

/**
 * Materialize an agent skill reference into a persisted snapshot message.
 *
 * Reads the skill YAML + body, creates a synthetic message containing the skill
 * content, and deduplicates against the last 5 history messages to avoid
 * inserting identical snapshots on consecutive sends.
 *
 * @returns The snapshot message, or null if no skill reference or duplicate detected
 */
export async function materializeAgentSkillSnapshot(
  muxMetadata: MuxFrontendMetadata | undefined,
  disableWorkspaceAgents: boolean | undefined,
  workspaceId: string,
  aiService: AIService,
  historyService: HistoryService
): Promise<{ snapshotMessage: MuxMessage } | null> {
  if (!muxMetadata || muxMetadata.type !== "agent-skill") {
    return null;
  }

  // Guard for test mocks that may not implement getWorkspaceMetadata.
  if (typeof aiService.getWorkspaceMetadata !== "function") {
    return null;
  }

  const parsedName = SkillNameSchema.safeParse(muxMetadata.skillName);
  if (!parsedName.success) {
    throw new Error(`Invalid agent skill name: ${muxMetadata.skillName}`);
  }

  const metadataResult = await aiService.getWorkspaceMetadata(workspaceId);
  if (!metadataResult.success) {
    throw new Error("Cannot materialize agent skill: workspace metadata not found");
  }

  const metadata = metadataResult.data;
  const runtime = createRuntime(metadata.runtimeConfig, {
    projectPath: metadata.projectPath,
    workspaceName: metadata.name,
  });

  // In-place workspaces (CLI/benchmarks) have projectPath === name.
  // Use the path directly instead of reconstructing via getWorkspacePath.
  const isInPlace = metadata.projectPath === metadata.name;
  const workspacePath = isInPlace
    ? metadata.projectPath
    : runtime.getWorkspacePath(metadata.projectPath, metadata.name);

  // When workspace agents are disabled, resolve skills from the project path instead of
  // the worktree so skill invocation uses the same precedence/discovery root as the UI.
  const skillDiscoveryPath = disableWorkspaceAgents ? metadata.projectPath : workspacePath;

  const resolved = await readAgentSkill(runtime, skillDiscoveryPath, parsedName.data);
  const skill = resolved.package;

  const frontmatterYaml = YAML.stringify(skill.frontmatter).trimEnd();

  const body =
    skill.body.length > MAX_AGENT_SKILL_SNAPSHOT_CHARS
      ? `${skill.body.slice(0, MAX_AGENT_SKILL_SNAPSHOT_CHARS)}\n\n[Skill body truncated to ${MAX_AGENT_SKILL_SNAPSHOT_CHARS} characters]`
      : skill.body;

  const snapshotText = `<agent-skill name="${skill.frontmatter.name}" scope="${skill.scope}">\n${body}\n</agent-skill>`;

  // Include the parsed YAML frontmatter in the hash so frontmatter-only edits (e.g. description)
  // generate a new snapshot and keep the UI hover preview in sync.
  const sha256 = createHash("sha256")
    .update(JSON.stringify({ snapshotText, frontmatterYaml }))
    .digest("hex");

  // Dedupe: if we recently persisted the same snapshot, avoid inserting again.
  const historyResult = await historyService.getHistory(workspaceId);
  if (historyResult.success) {
    const recentMessages = historyResult.data.slice(Math.max(0, historyResult.data.length - 5));
    const recentSnapshot = [...recentMessages]
      .reverse()
      .find((msg) => msg.metadata?.synthetic && msg.metadata?.agentSkillSnapshot);
    const recentMeta = recentSnapshot?.metadata?.agentSkillSnapshot;

    if (recentMeta?.skillName === skill.frontmatter.name && recentMeta.sha256 === sha256) {
      return null;
    }
  }

  const snapshotId = createAgentSkillSnapshotMessageId();
  const snapshotMessage = createMuxMessage(snapshotId, "user", snapshotText, {
    timestamp: Date.now(),
    synthetic: true,
    agentSkillSnapshot: {
      skillName: skill.frontmatter.name,
      scope: skill.scope,
      sha256,
      frontmatterYaml,
    },
  });

  return { snapshotMessage };
}
