import { EventEmitter } from "events";
import * as path from "path";
import * as fsPromises from "fs/promises";
import assert from "@/common/utils/assert";
import { isWorkspaceArchived } from "@/common/utils/archive";
import { MUX_HELP_CHAT_WORKSPACE_ID } from "@/common/constants/muxChat";
import { getMuxHelpChatProjectPath } from "@/node/constants/muxChat";
import type { Config } from "@/node/config";
import type { Result } from "@/common/types/result";
import { Ok, Err } from "@/common/types/result";
import { askUserQuestionManager } from "@/node/services/askUserQuestionManager";
import { delegatedToolCallManager } from "@/node/services/delegatedToolCallManager";
import { log } from "@/node/services/log";
import { AgentSession } from "@/node/services/agentSession";
import type { HistoryService } from "@/node/services/historyService";
import type { AIService } from "@/node/services/aiService";
import type { InitStateManager } from "@/node/services/initStateManager";
import type { ExtensionMetadataService } from "@/node/services/ExtensionMetadataService";
import type { TelemetryService } from "@/node/services/telemetryService";
import type { ExperimentsService } from "@/node/services/experimentsService";
import { EXPERIMENT_IDS, EXPERIMENTS } from "@/common/constants/experiments";
import type { PolicyService } from "@/node/services/policyService";
import type { MCPServerManager } from "@/node/services/mcpServerManager";
import {
  createRuntime,
  IncompatibleRuntimeError,
  runBackgroundInit,
} from "@/node/runtime/runtimeFactory";
import { createRuntimeForWorkspace } from "@/node/runtime/runtimeHelpers";
import { validateWorkspaceName } from "@/common/utils/validation/workspaceValidation";
import { stripTrailingSlashes } from "@/node/utils/pathUtils";
import { getPlanFilePath, getLegacyPlanFilePath } from "@/common/utils/planStorage";
import { listLocalBranches } from "@/node/git";
import { shellQuote } from "@/node/runtime/backgroundCommands";
import { extractEditedFilePaths } from "@/common/utils/messages/extractEditedFiles";
import { buildCompactionMessageText } from "@/common/utils/compaction/compactionPrompt";
import { fileExists } from "@/node/utils/runtime/fileExists";
import { orchestrateFork } from "@/node/services/utils/forkOrchestrator";
import { generateWorkspaceIdentity } from "@/node/services/workspaceTitleGenerator";
import { NAME_GEN_PREFERRED_MODELS } from "@/common/constants/nameGeneration";
import type { DevcontainerRuntime } from "@/node/runtime/DevcontainerRuntime";
import { getDevcontainerContainerName } from "@/node/runtime/devcontainerCli";
import { expandTilde, expandTildeForSSH } from "@/node/runtime/tildeExpansion";

import type { PostCompactionExclusions } from "@/common/types/attachment";
import type {
  SendMessageOptions,
  DeleteMessage,
  FilePart,
  WorkspaceChatMessage,
} from "@/common/orpc/types";

import type { z } from "zod";
import type { SendMessageError } from "@/common/types/errors";
import type {
  FrontendWorkspaceMetadata,
  WorkspaceActivitySnapshot,
  WorkspaceMetadata,
} from "@/common/types/workspace";
import { isDynamicToolPart } from "@/common/types/toolParts";
import { buildAskUserQuestionSummary } from "@/common/utils/tools/askUserQuestionSummary";
import {
  AskUserQuestionToolArgsSchema,
  AskUserQuestionToolResultSchema,
} from "@/common/utils/tools/toolDefinitions";
import type { UIMode } from "@/common/types/mode";
import type { MuxMessageMetadata, MuxMessage } from "@/common/types/message";
import type { RuntimeConfig } from "@/common/types/runtime";
import {
  hasSrcBaseDir,
  getSrcBaseDir,
  isSSHRuntime,
  isDockerRuntime,
} from "@/common/types/runtime";
import { isValidModelFormat, normalizeGatewayModel } from "@/common/utils/ai/models";
import { coerceThinkingLevel, type ThinkingLevel } from "@/common/types/thinking";
import { enforceThinkingPolicy } from "@/common/utils/thinking/policy";
import { WORKSPACE_DEFAULTS } from "@/constants/workspaceDefaults";
import type { StreamEndEvent, StreamAbortEvent, ToolCallEndEvent } from "@/common/types/stream";
import type { TerminalService } from "@/node/services/terminalService";
import type { WorkspaceAISettingsSchema } from "@/common/orpc/schemas";
import type { SessionTimingService } from "@/node/services/sessionTimingService";
import type { SessionUsageService } from "@/node/services/sessionUsageService";
import type { BackgroundProcessManager } from "@/node/services/backgroundProcessManager";
import type { WorkspaceLifecycleHooks } from "@/node/services/workspaceLifecycleHooks";
import type { TaskService } from "@/node/services/taskService";

import { DisposableTempDir } from "@/node/services/tempDir";
import { createBashTool } from "@/node/services/tools/bash";
import type { AskUserQuestionToolSuccessResult, BashToolResult } from "@/common/types/tools";
import { secretsToRecord } from "@/common/types/secrets";

import {
  copyPlanFileAcrossRuntimes,
  execBuffered,
  movePlanFile,
} from "@/node/utils/runtime/helpers";
import {
  buildFileCompletionsIndex,
  EMPTY_FILE_COMPLETIONS_INDEX,
  searchFileCompletions,
  type FileCompletionsIndex,
} from "@/node/services/fileCompletionsIndex";
import { taskQueueDebug } from "@/node/services/taskQueueDebug";
import {
  getSubagentGitPatchMboxPath,
  readSubagentGitPatchArtifactsFile,
  updateSubagentGitPatchArtifactsFile,
} from "@/node/services/subagentGitPatchArtifacts";
import {
  getSubagentReportArtifactPath,
  readSubagentReportArtifactsFile,
  updateSubagentReportArtifactsFile,
} from "@/node/services/subagentReportArtifacts";
import {
  getSubagentTranscriptChatPath,
  getSubagentTranscriptPartialPath,
  readSubagentTranscriptArtifactsFile,
  updateSubagentTranscriptArtifactsFile,
  upsertSubagentTranscriptArtifactIndexEntry,
} from "@/node/services/subagentTranscriptArtifacts";
import { getErrorMessage } from "@/common/utils/errors";

/** Maximum number of retry attempts when workspace name collides */
const MAX_WORKSPACE_NAME_COLLISION_RETRIES = 3;

// Keep short to feel instant, but debounce bursts of file_edit_* tool calls.

// Shared type for workspace-scoped AI settings (model + thinking)
type WorkspaceAISettings = z.infer<typeof WorkspaceAISettingsSchema>;
type WorkspaceAgentStatus = NonNullable<WorkspaceActivitySnapshot["agentStatus"]>;
const POST_COMPACTION_METADATA_REFRESH_DEBOUNCE_MS = 100;

interface FileCompletionsCacheEntry {
  index: FileCompletionsIndex;
  fetchedAt: number;
  refreshing?: Promise<void>;
}

interface ArchiveMergedInProjectResult {
  archivedWorkspaceIds: string[];
  skippedWorkspaceIds: string[];
  errors: Array<{ workspaceId: string; error: string }>;
}

/**
 * Checks if an error indicates a workspace name collision
 */
function isWorkspaceNameCollision(error: string | undefined): boolean {
  return error?.includes("Workspace already exists") ?? false;
}

/**
 * Generates a unique workspace name by appending a random suffix
 */
function appendCollisionSuffix(baseName: string): string {
  const suffix = Math.random().toString(36).substring(2, 6);
  return `${baseName}-${suffix}`;
}

const MAX_REGENERATE_TITLE_RECENT_TURNS = 3;

interface WorkspaceTitleContextTurn {
  role: "user" | "assistant";
  text: string;
}

interface WorkspaceTitleConversationContext {
  conversationContext: string | undefined;
  latestUserText: string | undefined;
}

function extractMuxMessageText(message: MuxMessage): string {
  const text =
    message.parts
      ?.filter((part) => part.type === "text")
      .map((part) => part.text.trim())
      .filter((partText) => partText.length > 0)
      .join("\n") ?? "";
  return text;
}

function collectWorkspaceTitleContextTurns(
  messages: readonly MuxMessage[]
): WorkspaceTitleContextTurn[] {
  const turns: WorkspaceTitleContextTurn[] = [];

  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant") {
      continue;
    }

    const text = extractMuxMessageText(message);
    if (!text) {
      continue;
    }

    turns.push({ role: message.role, text });
  }

  return turns;
}

function formatWorkspaceTitleContextTurns(turns: readonly WorkspaceTitleContextTurn[]): string {
  return turns
    .map(
      (turn, index) =>
        `Turn ${index + 1} (${turn.role === "user" ? "User" : "Assistant"}):\n${turn.text}`
    )
    .join("\n\n");
}

function buildWorkspaceTitleConversationContext(
  turns: readonly WorkspaceTitleContextTurn[]
): WorkspaceTitleConversationContext {
  const firstUserIndex = turns.findIndex((turn) => turn.role === "user");

  let latestUserText: string | undefined;
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].role === "user") {
      latestUserText = turns[i].text;
      break;
    }
  }

  const selectedIndexes = new Set<number>();
  if (firstUserIndex >= 0) {
    selectedIndexes.add(firstUserIndex);
  }
  const recentStartIndex = Math.max(0, turns.length - MAX_REGENERATE_TITLE_RECENT_TURNS);
  for (let i = recentStartIndex; i < turns.length; i++) {
    selectedIndexes.add(i);
  }

  const selectedTurns = [...selectedIndexes].sort((a, b) => a - b).map((index) => turns[index]);
  const omittedTurns = turns.length - selectedTurns.length;

  // If there is only the first user message, avoid adding a redundant conversation block.
  if (selectedTurns.length <= 1 && omittedTurns === 0) {
    return { conversationContext: undefined, latestUserText };
  }

  const formattedTurns = formatWorkspaceTitleContextTurns(selectedTurns);
  const omissionSummary =
    omittedTurns > 0
      ? `Note: ${omittedTurns} earlier conversation turn${omittedTurns === 1 ? "" : "s"} omitted for brevity.`
      : undefined;

  return {
    conversationContext: omissionSummary
      ? `${omissionSummary}\n\n${formattedTurns}`
      : formattedTurns,
    latestUserText,
  };
}

/**
 * Generate a unique fork branch name from the parent workspace name.
 * Scans existing workspace names for the `{parentName}-fork-N` pattern
 * and picks N+1, guaranteeing a valid git-safe branch name.
 */
export function generateForkBranchName(parentName: string, existingNames: string[]): string {
  const prefix = `${parentName}-fork-`;
  let max = 0;
  for (const name of existingNames) {
    if (!name.startsWith(prefix)) {
      continue;
    }

    const suffix = name.slice(prefix.length);
    if (!/^\d+$/.test(suffix)) {
      continue;
    }

    const n = Number(suffix);
    if (n > max) {
      max = n;
    }
  }
  return `${prefix}${max + 1}`;
}

/**
 * Generate a forked workspace title by appending a " (N)" suffix to the parent title.
 * Scans existing titles in the same project to pick the next available number.
 */
export function generateForkTitle(parentTitle: string, existingTitles: string[]): string {
  // Strip any existing " (N)" suffix from the parent title to get the base
  const base = parentTitle.replace(/ \(\d+\)$/, "");
  const prefix = `${base} (`;

  let max = 0;
  for (const title of existingTitles) {
    if (!title.startsWith(prefix) || !title.endsWith(")")) {
      continue;
    }

    const suffix = title.slice(prefix.length, -1);
    if (!/^\d+$/.test(suffix)) {
      continue;
    }

    const n = Number(suffix);
    if (n > max) {
      max = n;
    }
  }
  // If parent title itself exists in the list (without suffix), start at (1)
  // Otherwise continue from the highest found suffix
  return `${base} (${max + 1})`;
}

function isErrnoWithCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}

async function copyIfExists(sourcePath: string, destinationPath: string): Promise<void> {
  try {
    await fsPromises.copyFile(sourcePath, destinationPath);
  } catch (error) {
    if (!isErrnoWithCode(error, "ENOENT")) {
      throw error;
    }
  }
}

function isPathInsideDir(dirPath: string, filePath: string): boolean {
  const resolvedDir = path.resolve(dirPath);
  const resolvedFile = path.resolve(filePath);
  const relative = path.relative(resolvedDir, resolvedFile);

  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isPositiveInteger(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value > 0
  );
}

function isNonNegativeInteger(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0
  );
}

function getOldestSequencedMessage(
  messages: readonly MuxMessage[]
): { message: MuxMessage; historySequence: number } | null {
  let oldest: { message: MuxMessage; historySequence: number } | null = null;

  for (const message of messages) {
    const historySequence = message.metadata?.historySequence;
    if (!isNonNegativeInteger(historySequence)) {
      continue;
    }

    if (oldest === null || historySequence < oldest.historySequence) {
      oldest = { message, historySequence };
    }
  }

  return oldest;
}

interface WorkspaceHistoryLoadMoreCursor {
  beforeHistorySequence: number;
  beforeMessageId?: string | null;
}

interface WorkspaceHistoryLoadMoreResult {
  messages: WorkspaceChatMessage[];
  nextCursor: WorkspaceHistoryLoadMoreCursor | null;
  hasOlder: boolean;
}

function hasDurableCompactedMarker(value: unknown): value is true | "user" | "idle" {
  return value === true || value === "user" || value === "idle";
}

function isCompactedSummaryMessage(message: MuxMessage): boolean {
  return hasDurableCompactedMarker(message.metadata?.compacted);
}

function getNextCompactionEpochForAppendBoundary(
  workspaceId: string,
  messages: MuxMessage[]
): number {
  let epochCursor = 0;

  for (const message of messages) {
    const metadata = message.metadata;
    if (!metadata) {
      continue;
    }

    const isCompactedSummary = isCompactedSummaryMessage(message);
    const hasBoundaryMarker = metadata.compactionBoundary === true;
    const epoch = metadata.compactionEpoch;

    if (hasBoundaryMarker && !isCompactedSummary) {
      // Self-healing read path: skip malformed persisted boundary markers.
      // Boundary markers are only valid on compacted summaries.
      log.warn("Skipping malformed compaction boundary while deriving next epoch", {
        workspaceId,
        messageId: message.id,
        reason: "compactionBoundary set on non-compacted message",
      });
      continue;
    }

    if (!isCompactedSummary) {
      continue;
    }

    if (hasBoundaryMarker) {
      if (!isPositiveInteger(epoch)) {
        // Self-healing read path: invalid boundary metadata should not brick compaction.
        log.warn("Skipping malformed compaction boundary while deriving next epoch", {
          workspaceId,
          messageId: message.id,
          reason: "compactionBoundary missing positive integer compactionEpoch",
        });
        continue;
      }
      epochCursor = Math.max(epochCursor, epoch);
      continue;
    }

    if (epoch === undefined) {
      // Legacy compacted summaries predate compactionEpoch metadata.
      epochCursor += 1;
      continue;
    }

    if (!isPositiveInteger(epoch)) {
      // Self-healing read path: malformed compactionEpoch should not crash compaction.
      log.warn("Skipping malformed compactionEpoch while deriving next epoch", {
        workspaceId,
        messageId: message.id,
        reason: "compactionEpoch must be a positive integer when present",
      });
      continue;
    }

    epochCursor = Math.max(epochCursor, epoch);
  }

  const nextEpoch = epochCursor + 1;
  assert(nextEpoch > 0, "next compaction epoch must be positive");
  return nextEpoch;
}

async function copyFileBestEffort(params: {
  srcPath: string;
  destPath: string;
  logContext: Record<string, unknown>;
}): Promise<boolean> {
  try {
    await fsPromises.mkdir(path.dirname(params.destPath), { recursive: true });
    await fsPromises.copyFile(params.srcPath, params.destPath);
    return true;
  } catch (error: unknown) {
    if (isErrnoWithCode(error, "ENOENT")) {
      return false;
    }

    log.error("Failed to copy session artifact file", {
      ...params.logContext,
      srcPath: params.srcPath,
      destPath: params.destPath,
      error: getErrorMessage(error),
    });
    return false;
  }
}

async function copyDirIfMissingBestEffort(params: {
  srcDir: string;
  destDir: string;
  logContext: Record<string, unknown>;
}): Promise<void> {
  try {
    try {
      const stat = await fsPromises.stat(params.destDir);
      if (stat.isDirectory()) {
        return;
      }
      // If it's a file, fall through and try to copy (will likely fail).
    } catch (error: unknown) {
      if (!isErrnoWithCode(error, "ENOENT")) {
        throw error;
      }
    }

    await fsPromises.mkdir(path.dirname(params.destDir), { recursive: true });
    await fsPromises.cp(params.srcDir, params.destDir, { recursive: true });
  } catch (error: unknown) {
    if (isErrnoWithCode(error, "ENOENT")) {
      return;
    }

    log.error("Failed to copy session artifact directory", {
      ...params.logContext,
      srcDir: params.srcDir,
      destDir: params.destDir,
      error: getErrorMessage(error),
    });
  }
}

function coerceUpdatedAtMs(entry: { createdAtMs?: number; updatedAtMs?: number }): number {
  if (typeof entry.updatedAtMs === "number" && Number.isFinite(entry.updatedAtMs)) {
    return entry.updatedAtMs;
  }

  if (typeof entry.createdAtMs === "number" && Number.isFinite(entry.createdAtMs)) {
    return entry.createdAtMs;
  }

  return 0;
}

function rollUpAncestorWorkspaceIds(params: {
  ancestorWorkspaceIds: string[];
  removedWorkspaceId: string;
  newParentWorkspaceId: string;
}): string[] {
  const filtered = params.ancestorWorkspaceIds.filter((id) => id !== params.removedWorkspaceId);

  // Ensure the roll-up target is first (parent-first ordering).
  if (filtered[0] === params.newParentWorkspaceId) {
    return filtered;
  }

  return [
    params.newParentWorkspaceId,
    ...filtered.filter((id) => id !== params.newParentWorkspaceId),
  ];
}

async function archiveChildSessionArtifactsIntoParentSessionDir(params: {
  parentWorkspaceId: string;
  parentSessionDir: string;
  childWorkspaceId: string;
  childSessionDir: string;
  /** Task-level model string for the child workspace (optional; persists into transcript artifacts). */
  childTaskModelString?: string;
  /** Task-level thinking/reasoning level for the child workspace (optional; persists into transcript artifacts). */
  childTaskThinkingLevel?: ThinkingLevel;
}): Promise<void> {
  if (params.parentWorkspaceId.length === 0) {
    return;
  }

  if (params.childWorkspaceId.length === 0) {
    return;
  }

  if (params.parentSessionDir.length === 0 || params.childSessionDir.length === 0) {
    return;
  }

  // 1) Archive the child session transcript (chat.jsonl + partial.json) into the parent session dir
  // BEFORE deleting ~/.mux/sessions/<childWorkspaceId>.
  try {
    const childChatPath = path.join(params.childSessionDir, "chat.jsonl");
    const childPartialPath = path.join(params.childSessionDir, "partial.json");

    const archivedChatPath = getSubagentTranscriptChatPath(
      params.parentSessionDir,
      params.childWorkspaceId
    );
    const archivedPartialPath = getSubagentTranscriptPartialPath(
      params.parentSessionDir,
      params.childWorkspaceId
    );

    // Defensive: avoid path traversal in workspace IDs.
    if (!isPathInsideDir(params.parentSessionDir, archivedChatPath)) {
      log.error("Refusing to archive session transcript outside parent session dir", {
        parentWorkspaceId: params.parentWorkspaceId,
        childWorkspaceId: params.childWorkspaceId,
        parentSessionDir: params.parentSessionDir,
        archivedChatPath,
      });
    } else {
      const didCopyChat = await copyFileBestEffort({
        srcPath: childChatPath,
        destPath: archivedChatPath,
        logContext: {
          parentWorkspaceId: params.parentWorkspaceId,
          childWorkspaceId: params.childWorkspaceId,
          artifact: "chat.jsonl",
        },
      });

      const didCopyPartial = await copyFileBestEffort({
        srcPath: childPartialPath,
        destPath: archivedPartialPath,
        logContext: {
          parentWorkspaceId: params.parentWorkspaceId,
          childWorkspaceId: params.childWorkspaceId,
          artifact: "partial.json",
        },
      });

      const childMetadataPath = path.join(params.childSessionDir, "metadata.json");
      const archivedMetadataPath = path.join(
        params.parentSessionDir,
        "subagent-transcripts",
        params.childWorkspaceId,
        "metadata.json"
      );
      await copyFileBestEffort({
        srcPath: childMetadataPath,
        destPath: archivedMetadataPath,
        logContext: {
          parentWorkspaceId: params.parentWorkspaceId,
          childWorkspaceId: params.childWorkspaceId,
          artifact: "metadata.json",
        },
      });

      if (didCopyChat || didCopyPartial) {
        const nowMs = Date.now();

        const model =
          typeof params.childTaskModelString === "string" &&
          params.childTaskModelString.trim().length > 0
            ? params.childTaskModelString.trim()
            : undefined;
        const thinkingLevel = coerceThinkingLevel(params.childTaskThinkingLevel);

        await upsertSubagentTranscriptArtifactIndexEntry({
          workspaceId: params.parentWorkspaceId,
          workspaceSessionDir: params.parentSessionDir,
          childTaskId: params.childWorkspaceId,
          updater: (existing) => ({
            childTaskId: params.childWorkspaceId,
            parentWorkspaceId: params.parentWorkspaceId,
            createdAtMs: existing?.createdAtMs ?? nowMs,
            updatedAtMs: nowMs,
            model: model ?? existing?.model,
            thinkingLevel: thinkingLevel ?? existing?.thinkingLevel,
            chatPath: didCopyChat ? archivedChatPath : existing?.chatPath,
            partialPath: didCopyPartial ? archivedPartialPath : existing?.partialPath,
          }),
        });
      }
    }
  } catch (error: unknown) {
    log.error("Failed to archive child transcript into parent session dir", {
      parentWorkspaceId: params.parentWorkspaceId,
      childWorkspaceId: params.childWorkspaceId,
      error: getErrorMessage(error),
    });
  }

  // 2) Roll up nested subagent artifacts from the child session dir into the parent session dir.
  // This preserves grandchild artifacts when intermediate subagent workspaces are cleaned up.

  // --- subagent-patches.json + subagent-patches/<taskId>/...
  try {
    const childArtifacts = await readSubagentGitPatchArtifactsFile(params.childSessionDir);
    const childEntries = Object.entries(childArtifacts.artifactsByChildTaskId);

    for (const [taskId] of childEntries) {
      if (!taskId) continue;

      const srcDir = path.dirname(getSubagentGitPatchMboxPath(params.childSessionDir, taskId));
      const destDir = path.dirname(getSubagentGitPatchMboxPath(params.parentSessionDir, taskId));

      if (!isPathInsideDir(params.childSessionDir, srcDir)) {
        log.error("Refusing to roll up patch artifact outside child session dir", {
          parentWorkspaceId: params.parentWorkspaceId,
          childWorkspaceId: params.childWorkspaceId,
          taskId,
          childSessionDir: params.childSessionDir,
          srcDir,
        });
        continue;
      }

      if (!isPathInsideDir(params.parentSessionDir, destDir)) {
        log.error("Refusing to roll up patch artifact outside parent session dir", {
          parentWorkspaceId: params.parentWorkspaceId,
          childWorkspaceId: params.childWorkspaceId,
          taskId,
          parentSessionDir: params.parentSessionDir,
          destDir,
        });
        continue;
      }

      await copyDirIfMissingBestEffort({
        srcDir,
        destDir,
        logContext: {
          parentWorkspaceId: params.parentWorkspaceId,
          childWorkspaceId: params.childWorkspaceId,
          artifact: "subagent-patches",
          taskId,
        },
      });
    }

    if (childEntries.length > 0) {
      await updateSubagentGitPatchArtifactsFile({
        workspaceId: params.parentWorkspaceId,
        workspaceSessionDir: params.parentSessionDir,
        update: (parentFile) => {
          for (const [taskId, childEntry] of childEntries) {
            if (!taskId) continue;
            const existing = parentFile.artifactsByChildTaskId[taskId] ?? null;

            const childUpdated = coerceUpdatedAtMs(childEntry);
            const existingUpdated = existing ? coerceUpdatedAtMs(existing) : -1;

            if (!existing || childUpdated > existingUpdated) {
              parentFile.artifactsByChildTaskId[taskId] = {
                ...childEntry,
                childTaskId: taskId,
                parentWorkspaceId: params.parentWorkspaceId,
                mboxPath: getSubagentGitPatchMboxPath(params.parentSessionDir, taskId),
              };
            }
          }
        },
      });
    }
  } catch (error: unknown) {
    log.error("Failed to roll up subagent patch artifacts into parent", {
      parentWorkspaceId: params.parentWorkspaceId,
      childWorkspaceId: params.childWorkspaceId,
      error: getErrorMessage(error),
    });
  }

  // --- subagent-reports.json + subagent-reports/<taskId>/...
  try {
    const childArtifacts = await readSubagentReportArtifactsFile(params.childSessionDir);
    const childEntries = Object.entries(childArtifacts.artifactsByChildTaskId);

    for (const [taskId] of childEntries) {
      if (!taskId) continue;

      const srcDir = path.dirname(getSubagentReportArtifactPath(params.childSessionDir, taskId));
      const destDir = path.dirname(getSubagentReportArtifactPath(params.parentSessionDir, taskId));

      if (!isPathInsideDir(params.childSessionDir, srcDir)) {
        log.error("Refusing to roll up report artifact outside child session dir", {
          parentWorkspaceId: params.parentWorkspaceId,
          childWorkspaceId: params.childWorkspaceId,
          taskId,
          childSessionDir: params.childSessionDir,
          srcDir,
        });
        continue;
      }

      if (!isPathInsideDir(params.parentSessionDir, destDir)) {
        log.error("Refusing to roll up report artifact outside parent session dir", {
          parentWorkspaceId: params.parentWorkspaceId,
          childWorkspaceId: params.childWorkspaceId,
          taskId,
          parentSessionDir: params.parentSessionDir,
          destDir,
        });
        continue;
      }

      await copyDirIfMissingBestEffort({
        srcDir,
        destDir,
        logContext: {
          parentWorkspaceId: params.parentWorkspaceId,
          childWorkspaceId: params.childWorkspaceId,
          artifact: "subagent-reports",
          taskId,
        },
      });
    }

    if (childEntries.length > 0) {
      await updateSubagentReportArtifactsFile({
        workspaceId: params.parentWorkspaceId,
        workspaceSessionDir: params.parentSessionDir,
        update: (parentFile) => {
          for (const [taskId, childEntry] of childEntries) {
            if (!taskId) continue;

            const existing = parentFile.artifactsByChildTaskId[taskId] ?? null;
            const childUpdated = coerceUpdatedAtMs(childEntry);
            const existingUpdated = existing ? coerceUpdatedAtMs(existing) : -1;

            if (!existing || childUpdated > existingUpdated) {
              parentFile.artifactsByChildTaskId[taskId] = {
                ...childEntry,
                childTaskId: taskId,
                parentWorkspaceId: params.parentWorkspaceId,
                ancestorWorkspaceIds: rollUpAncestorWorkspaceIds({
                  ancestorWorkspaceIds: childEntry.ancestorWorkspaceIds,
                  removedWorkspaceId: params.childWorkspaceId,
                  newParentWorkspaceId: params.parentWorkspaceId,
                }),
              };
            }
          }
        },
      });
    }
  } catch (error: unknown) {
    log.error("Failed to roll up subagent report artifacts into parent", {
      parentWorkspaceId: params.parentWorkspaceId,
      childWorkspaceId: params.childWorkspaceId,
      error: getErrorMessage(error),
    });
  }

  // --- subagent-transcripts.json + subagent-transcripts/<taskId>/...
  try {
    const childArtifacts = await readSubagentTranscriptArtifactsFile(params.childSessionDir);
    const childEntries = Object.entries(childArtifacts.artifactsByChildTaskId);

    for (const [taskId] of childEntries) {
      if (!taskId) continue;

      const srcDir = path.dirname(getSubagentTranscriptChatPath(params.childSessionDir, taskId));
      const destDir = path.dirname(getSubagentTranscriptChatPath(params.parentSessionDir, taskId));

      if (!isPathInsideDir(params.childSessionDir, srcDir)) {
        log.error("Refusing to roll up transcript artifact outside child session dir", {
          parentWorkspaceId: params.parentWorkspaceId,
          childWorkspaceId: params.childWorkspaceId,
          taskId,
          childSessionDir: params.childSessionDir,
          srcDir,
        });
        continue;
      }

      if (!isPathInsideDir(params.parentSessionDir, destDir)) {
        log.error("Refusing to roll up transcript artifact outside parent session dir", {
          parentWorkspaceId: params.parentWorkspaceId,
          childWorkspaceId: params.childWorkspaceId,
          taskId,
          parentSessionDir: params.parentSessionDir,
          destDir,
        });
        continue;
      }

      await copyDirIfMissingBestEffort({
        srcDir,
        destDir,
        logContext: {
          parentWorkspaceId: params.parentWorkspaceId,
          childWorkspaceId: params.childWorkspaceId,
          artifact: "subagent-transcripts",
          taskId,
        },
      });
    }

    if (childEntries.length > 0) {
      await updateSubagentTranscriptArtifactsFile({
        workspaceId: params.parentWorkspaceId,
        workspaceSessionDir: params.parentSessionDir,
        update: (parentFile) => {
          for (const [taskId, childEntry] of childEntries) {
            if (!taskId) continue;

            const existing = parentFile.artifactsByChildTaskId[taskId] ?? null;
            const childUpdated = coerceUpdatedAtMs(childEntry);
            const existingUpdated = existing ? coerceUpdatedAtMs(existing) : -1;

            if (!existing || childUpdated > existingUpdated) {
              parentFile.artifactsByChildTaskId[taskId] = {
                ...childEntry,
                childTaskId: taskId,
                parentWorkspaceId: params.parentWorkspaceId,
                chatPath: childEntry.chatPath
                  ? getSubagentTranscriptChatPath(params.parentSessionDir, taskId)
                  : undefined,
                partialPath: childEntry.partialPath
                  ? getSubagentTranscriptPartialPath(params.parentSessionDir, taskId)
                  : undefined,
              };
            }
          }
        },
      });
    }
  } catch (error: unknown) {
    log.error("Failed to roll up subagent transcript artifacts into parent", {
      parentWorkspaceId: params.parentWorkspaceId,
      childWorkspaceId: params.childWorkspaceId,
      error: getErrorMessage(error),
    });
  }
}

async function forEachWithConcurrencyLimit<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  assert(Number.isInteger(limit) && limit > 0, "Concurrency limit must be a positive integer");

  let nextIndex = 0;
  const workerCount = Math.min(limit, items.length);

  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) {
        return;
      }
      await fn(items[index]);
    }
  });

  await Promise.all(workers);
}

export interface WorkspaceServiceEvents {
  chat: (event: { workspaceId: string; message: WorkspaceChatMessage }) => void;
  metadata: (event: { workspaceId: string; metadata: FrontendWorkspaceMetadata | null }) => void;
  activity: (event: { workspaceId: string; activity: WorkspaceActivitySnapshot | null }) => void;
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export declare interface WorkspaceService {
  on<U extends keyof WorkspaceServiceEvents>(event: U, listener: WorkspaceServiceEvents[U]): this;
  emit<U extends keyof WorkspaceServiceEvents>(
    event: U,
    ...args: Parameters<WorkspaceServiceEvents[U]>
  ): boolean;
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export class WorkspaceService extends EventEmitter {
  private readonly sessions = new Map<string, AgentSession>();
  private readonly sessionSubscriptions = new Map<
    string,
    { chat: () => void; metadata: () => void }
  >();

  // Debounce post-compaction metadata refreshes (file_edit_* can fire rapidly)
  private readonly postCompactionRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // Tracks workspaces currently being renamed to prevent streaming during rename
  private readonly renamingWorkspaces = new Set<string>();

  // Cache for @file mention autocomplete (git ls-files output).
  private readonly fileCompletionsCache = new Map<string, FileCompletionsCacheEntry>();
  // Tracks workspaces currently being removed to prevent new sessions/streams during deletion.
  private readonly removingWorkspaces = new Set<string>();

  // Tracks workspaces currently being archived to prevent runtime-affecting operations (e.g. SSH)
  // from waking a dedicated workspace during archive().
  private readonly archivingWorkspaces = new Set<string>();

  // Tracks workspaces undergoing idle (background) compaction so the activity snapshot
  // can tag the stream, letting the frontend suppress notifications for maintenance work.
  private readonly idleCompactingWorkspaces = new Set<string>();

  // AbortControllers for in-progress workspace initialization (postCreateSetup + initWorkspace).
  //
  // Why this lives here: archive/remove are the user-facing lifecycle operations that should
  // cancel any fire-and-forget init work to avoid orphaned processes (e.g., SSH sync, .mux/init).
  private readonly initAbortControllers = new Map<string, AbortController>();

  // ExtensionMetadataService now serializes all mutations globally because every
  // workspace shares the same extensionMetadata.json file.

  /** Check if a workspace is currently being removed. */
  isRemoving(workspaceId: string): boolean {
    return this.removingWorkspaces.has(workspaceId);
  }

  constructor(
    private readonly config: Config,
    private readonly historyService: HistoryService,
    private readonly aiService: AIService,
    private readonly initStateManager: InitStateManager,
    private readonly extensionMetadata: ExtensionMetadataService,
    private readonly backgroundProcessManager: BackgroundProcessManager,
    private readonly sessionUsageService?: SessionUsageService,
    policyService?: PolicyService,
    telemetryService?: TelemetryService,
    experimentsService?: ExperimentsService,
    sessionTimingService?: SessionTimingService
  ) {
    super();
    this.policyService = policyService;
    this.telemetryService = telemetryService;
    this.experimentsService = experimentsService;
    this.sessionTimingService = sessionTimingService;
    this.setupMetadataListeners();
    this.setupInitMetadataListeners();
  }

  private readonly policyService?: PolicyService;
  private readonly telemetryService?: TelemetryService;
  private readonly experimentsService?: ExperimentsService;
  private mcpServerManager?: MCPServerManager;
  // Optional terminal service for cleanup on workspace removal
  private terminalService?: TerminalService;
  private readonly sessionTimingService?: SessionTimingService;
  private workspaceLifecycleHooks?: WorkspaceLifecycleHooks;
  private taskService?: TaskService;

  /**
   * Set the MCP server manager for tool access.
   * Called after construction due to circular dependency.
   */
  setMCPServerManager(manager: MCPServerManager): void {
    this.mcpServerManager = manager;
  }

  /**
   * Set the terminal service for cleanup on workspace removal.
   */
  setTerminalService(terminalService: TerminalService): void {
    this.terminalService = terminalService;
  }

  setWorkspaceLifecycleHooks(hooks: WorkspaceLifecycleHooks): void {
    this.workspaceLifecycleHooks = hooks;
  }

  /**
   * Set the task service for auto-resume counter resets.
   * Called after construction due to circular dependency.
   */
  setTaskService(taskService: TaskService): void {
    this.taskService = taskService;
  }

  /**
   * DEBUG ONLY: Trigger an artificial stream error for testing.
   * This is used by integration tests to simulate network errors mid-stream.
   * @returns true if an active stream was found and error was triggered
   */
  debugTriggerStreamError(workspaceId: string, errorMessage?: string): Promise<boolean> {
    return this.aiService.debugTriggerStreamError(workspaceId, errorMessage);
  }

  /**
   * Setup listeners to update metadata store based on AIService events.
   * This tracks workspace recency and streaming status for VS Code extension integration.
   */
  private setupMetadataListeners(): void {
    const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
    const isWorkspaceEvent = (v: unknown): v is { workspaceId: string } =>
      isObj(v) && "workspaceId" in v && typeof v.workspaceId === "string";
    const isStreamStartEvent = (
      v: unknown
    ): v is { workspaceId: string; model: string; agentId?: string } =>
      isWorkspaceEvent(v) && "model" in v && typeof v.model === "string";
    const isStreamEndEvent = (v: unknown): v is StreamEndEvent =>
      isWorkspaceEvent(v) &&
      (!("metadata" in (v as Record<string, unknown>)) || isObj((v as StreamEndEvent).metadata));
    const isStreamAbortEvent = (v: unknown): v is StreamAbortEvent => isWorkspaceEvent(v);
    const isErrorEvent = (v: unknown): v is { workspaceId: string; error: string } =>
      isWorkspaceEvent(v) && "error" in v && typeof (v as { error: unknown }).error === "string";
    const isToolCallEndEvent = (v: unknown): v is ToolCallEndEvent =>
      isWorkspaceEvent(v) &&
      "toolName" in v &&
      typeof (v as { toolName: unknown }).toolName === "string" &&
      "result" in v;
    const extractStatusSetResult = (result: unknown): WorkspaceAgentStatus | null => {
      if (!isObj(result)) {
        return null;
      }

      if (
        result.success !== true ||
        typeof result.emoji !== "string" ||
        typeof result.message !== "string"
      ) {
        return null;
      }

      if (result.url !== undefined && typeof result.url !== "string") {
        return null;
      }

      return {
        emoji: result.emoji,
        message: result.message,
        ...(typeof result.url === "string" ? { url: result.url } : {}),
      };
    };
    const extractTimestamp = (event: StreamEndEvent | { metadata?: { timestamp?: number } }) => {
      const raw = event.metadata?.timestamp;
      return typeof raw === "number" && Number.isFinite(raw) ? raw : Date.now();
    };

    // Update streaming status and recency on stream start
    this.aiService.on("stream-start", (data: unknown) => {
      if (isStreamStartEvent(data)) {
        void this.updateStreamingStatus(data.workspaceId, true, data.model, data.agentId);
      }
    });

    this.aiService.on("stream-end", (data: unknown) => {
      if (isStreamEndEvent(data)) {
        void this.handleStreamCompletion(data.workspaceId, extractTimestamp(data));
      }
    });

    this.aiService.on("stream-abort", (data: unknown) => {
      if (isStreamAbortEvent(data)) {
        void this.updateStreamingStatus(data.workspaceId, false);
      }
    });

    this.aiService.on("error", (data: unknown) => {
      if (isErrorEvent(data)) {
        void this.updateStreamingStatus(data.workspaceId, false);
      }
    });

    this.aiService.on("tool-call-end", (data: unknown) => {
      if (!isToolCallEndEvent(data) || data.replay === true || data.toolName !== "status_set") {
        return;
      }

      const agentStatus = extractStatusSetResult(data.result);
      if (!agentStatus) {
        return;
      }

      void this.updateAgentStatus(data.workspaceId, agentStatus);
    });
  }

  private setupInitMetadataListeners(): void {
    const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
    const isWorkspaceEvent = (v: unknown): v is { workspaceId: string } =>
      isObj(v) && "workspaceId" in v && typeof v.workspaceId === "string";

    // When init completes, refresh metadata so the UI can clear isInitializing and swap
    // "Cancel creation" back to the normal archive affordance.
    this.initStateManager.on("init-end", (event: unknown) => {
      if (!isWorkspaceEvent(event)) {
        return;
      }
      void this.refreshAndEmitMetadata(event.workspaceId);
    });
  }

  private emitWorkspaceActivity(
    workspaceId: string,
    snapshot: WorkspaceActivitySnapshot | null
  ): void {
    this.emit("activity", { workspaceId, activity: snapshot });
  }

  private async updateRecencyTimestamp(workspaceId: string, timestamp?: number): Promise<void> {
    try {
      const snapshot = await this.extensionMetadata.updateRecency(
        workspaceId,
        timestamp ?? Date.now()
      );
      this.emitWorkspaceActivity(workspaceId, snapshot);
    } catch (error) {
      log.error("Failed to update workspace recency", { workspaceId, error });
    }
  }

  public async updateAgentStatus(
    workspaceId: string,
    agentStatus: WorkspaceAgentStatus | null
  ): Promise<void> {
    try {
      const snapshot = await this.extensionMetadata.setAgentStatus(workspaceId, agentStatus);
      this.emitWorkspaceActivity(workspaceId, snapshot);
    } catch (error) {
      log.error("Failed to update workspace agent status", { workspaceId, error });
    }
  }

  private async updateStreamingStatus(
    workspaceId: string,
    streaming: boolean,
    model?: string,
    agentId?: string
  ): Promise<void> {
    try {
      let thinkingLevel: WorkspaceAISettings["thinkingLevel"] | undefined;
      if (model) {
        const found = this.config.findWorkspace(workspaceId);
        if (found) {
          const config = this.config.loadConfigOrDefault();
          const project = config.projects.get(found.projectPath);
          const workspace =
            project?.workspaces.find((w) => w.id === workspaceId) ??
            project?.workspaces.find((w) => w.path === found.workspacePath);
          const normalizedAgentId =
            typeof agentId === "string" && agentId.trim().length > 0
              ? agentId.trim().toLowerCase()
              : WORKSPACE_DEFAULTS.agentId;
          const aiSettings =
            workspace?.aiSettingsByAgent?.[normalizedAgentId] ?? workspace?.aiSettings;
          thinkingLevel = aiSettings?.thinkingLevel;
        }
      }
      const snapshot = await this.extensionMetadata.setStreaming(
        workspaceId,
        streaming,
        model,
        thinkingLevel
      );
      // Idle compaction tagging is stop-snapshot only. Never tag streaming=true updates,
      // otherwise fast follow-up turns can inherit stale idle metadata before cleanup runs.
      const shouldTagIdleCompaction = !streaming && this.idleCompactingWorkspaces.has(workspaceId);
      this.emitWorkspaceActivity(
        workspaceId,
        shouldTagIdleCompaction ? { ...snapshot, isIdleCompaction: true } : snapshot
      );
    } catch (error) {
      log.error("Failed to update workspace streaming status", { workspaceId, error });
    } finally {
      // Idle compaction marker is turn-scoped. Always clear on streaming=false transitions,
      // even when metadata writes fail, so stale state cannot leak into future user streams.
      if (!streaming) {
        this.idleCompactingWorkspaces.delete(workspaceId);
      }
    }
  }

  private async handleStreamCompletion(workspaceId: string, timestamp: number): Promise<void> {
    await this.updateRecencyTimestamp(workspaceId, timestamp);
    await this.updateStreamingStatus(workspaceId, false);
  }

  private createInitLogger(workspaceId: string) {
    const hasInitState = () => this.initStateManager.getInitState(workspaceId) !== undefined;

    return {
      logStep: (message: string) => {
        if (!hasInitState()) {
          return;
        }
        this.initStateManager.appendOutput(workspaceId, message, false);
      },
      logStdout: (line: string) => {
        if (!hasInitState()) {
          return;
        }
        this.initStateManager.appendOutput(workspaceId, line, false);
      },
      logStderr: (line: string) => {
        if (!hasInitState()) {
          return;
        }
        this.initStateManager.appendOutput(workspaceId, line, true);
      },
      logComplete: (exitCode: number) => {
        this.initAbortControllers.delete(workspaceId);

        // WorkspaceService.remove() clears in-memory init state early so waiters/tools can bail out.
        // If init completes after deletion, avoid noisy logs (endInit() would report missing state).
        if (!hasInitState()) {
          return;
        }

        void this.initStateManager.endInit(workspaceId, exitCode);
      },
      enterHookPhase: () => {
        if (!hasInitState()) {
          return;
        }
        this.initStateManager.enterHookPhase(workspaceId);
      },
    };
  }

  private schedulePostCompactionMetadataRefresh(workspaceId: string): void {
    assert(typeof workspaceId === "string", "workspaceId must be a string");
    const trimmed = workspaceId.trim();
    assert(trimmed.length > 0, "workspaceId must not be empty");

    const existing = this.postCompactionRefreshTimers.get(trimmed);
    if (existing) {
      clearTimeout(existing);
    }

    const timer = setTimeout(() => {
      this.postCompactionRefreshTimers.delete(trimmed);
      void this.emitPostCompactionMetadata(trimmed);
    }, POST_COMPACTION_METADATA_REFRESH_DEBOUNCE_MS);

    this.postCompactionRefreshTimers.set(trimmed, timer);
  }

  private async emitPostCompactionMetadata(workspaceId: string): Promise<void> {
    try {
      const session = this.sessions.get(workspaceId);
      if (!session) {
        return;
      }

      const metadata = await this.getInfo(workspaceId);
      if (!metadata) {
        return;
      }

      const postCompaction = await this.getPostCompactionState(workspaceId);
      const enrichedMetadata = { ...metadata, postCompaction };
      session.emitMetadata(enrichedMetadata);
    } catch (error) {
      // Workspace runtime unavailable (e.g., SSH unreachable) - skip emitting post-compaction state.
      log.debug("Failed to emit post-compaction metadata", { workspaceId, error });
    }
  }

  // Clear persisted sidebar status only after the user turn is accepted and emitted.
  // sendMessage can fail before acceptance (for example invalid_model_string), so
  // clearing inside sendMessage would drop status for turns that never entered history.
  private shouldClearAgentStatusFromChatMessage(message: WorkspaceChatMessage): boolean {
    return (
      message.type === "message" && message.role === "user" && message.metadata?.synthetic !== true
    );
  }

  public getOrCreateSession(workspaceId: string): AgentSession {
    assert(typeof workspaceId === "string", "workspaceId must be a string");
    const trimmed = workspaceId.trim();
    assert(trimmed.length > 0, "workspaceId must not be empty");

    let session = this.sessions.get(trimmed);
    if (session) {
      return session;
    }

    session = new AgentSession({
      workspaceId: trimmed,
      config: this.config,
      historyService: this.historyService,
      aiService: this.aiService,
      telemetryService: this.telemetryService,
      initStateManager: this.initStateManager,
      backgroundProcessManager: this.backgroundProcessManager,
      onCompactionComplete: () => {
        this.schedulePostCompactionMetadataRefresh(trimmed);
      },
      onPostCompactionStateChange: () => {
        this.schedulePostCompactionMetadataRefresh(trimmed);
      },
    });

    const chatUnsubscribe = session.onChatEvent((event) => {
      this.emit("chat", { workspaceId: event.workspaceId, message: event.message });
      if (this.shouldClearAgentStatusFromChatMessage(event.message)) {
        void this.updateAgentStatus(event.workspaceId, null);
      }
    });

    const metadataUnsubscribe = session.onMetadataEvent((event) => {
      this.emit("metadata", {
        workspaceId: event.workspaceId,
        metadata: event.metadata!,
      });
    });

    this.sessions.set(trimmed, session);
    this.sessionSubscriptions.set(trimmed, {
      chat: chatUnsubscribe,
      metadata: metadataUnsubscribe,
    });

    return session;
  }

  /**
   * Register an externally-created AgentSession so that WorkspaceService
   * operations (sendMessage, resumeStream, remove, etc.) reuse it instead of
   * creating a duplicate. Used by `mux run` CLI to keep a single session
   * instance for the parent workspace.
   */
  public registerSession(workspaceId: string, session: AgentSession): void {
    workspaceId = workspaceId.trim();
    assert(workspaceId.length > 0, "workspaceId must not be empty");
    assert(!this.sessions.has(workspaceId), `session already registered for ${workspaceId}`);

    this.sessions.set(workspaceId, session);

    const chatUnsubscribe = session.onChatEvent((event) => {
      this.emit("chat", { workspaceId: event.workspaceId, message: event.message });
      if (this.shouldClearAgentStatusFromChatMessage(event.message)) {
        void this.updateAgentStatus(event.workspaceId, null);
      }
    });

    const metadataUnsubscribe = session.onMetadataEvent((event) => {
      this.emit("metadata", {
        workspaceId: event.workspaceId,
        metadata: event.metadata!,
      });
    });

    this.sessionSubscriptions.set(workspaceId, {
      chat: chatUnsubscribe,
      metadata: metadataUnsubscribe,
    });
  }

  public disposeSession(workspaceId: string): void {
    const trimmed = workspaceId.trim();
    const session = this.sessions.get(trimmed);
    const refreshTimer = this.postCompactionRefreshTimers.get(trimmed);
    if (refreshTimer) {
      clearTimeout(refreshTimer);
      this.postCompactionRefreshTimers.delete(trimmed);
    }

    if (!session) {
      return;
    }

    const subscriptions = this.sessionSubscriptions.get(trimmed);
    if (subscriptions) {
      subscriptions.chat();
      subscriptions.metadata();
      this.sessionSubscriptions.delete(trimmed);
    }

    session.dispose();
    this.sessions.delete(trimmed);
  }

  private async getPersistedPostCompactionDiffPaths(workspaceId: string): Promise<string[] | null> {
    const postCompactionPath = path.join(
      this.config.getSessionDir(workspaceId),
      "post-compaction.json"
    );

    try {
      const raw = await fsPromises.readFile(postCompactionPath, "utf-8");
      const parsed: unknown = JSON.parse(raw);
      const diffsRaw = (parsed as { diffs?: unknown }).diffs;
      if (!Array.isArray(diffsRaw)) {
        return null;
      }

      const result: string[] = [];
      for (const diff of diffsRaw) {
        if (!diff || typeof diff !== "object") continue;
        const p = (diff as { path?: unknown }).path;
        if (typeof p !== "string") continue;
        const trimmed = p.trim();
        if (trimmed.length === 0) continue;
        result.push(trimmed);
      }

      return result;
    } catch {
      return null;
    }
  }

  /**
   * Get post-compaction context state for a workspace.
   * Returns info about what will be injected after compaction.
   * Prefers cached paths from pending compaction, falls back to history extraction.
   */
  public async getPostCompactionState(workspaceId: string): Promise<{
    planPath: string | null;
    trackedFilePaths: string[];
    excludedItems: string[];
  }> {
    // Get workspace metadata to create runtime for plan file check
    const metadata = await this.getInfo(workspaceId);
    if (!metadata) {
      // Can't get metadata, return empty state
      const exclusions = await this.getPostCompactionExclusions(workspaceId);
      return { planPath: null, trackedFilePaths: [], excludedItems: exclusions.excludedItems };
    }

    const runtime = createRuntimeForWorkspace(metadata);
    const muxHome = runtime.getMuxHome();
    const planPath = getPlanFilePath(metadata.name, metadata.projectName, muxHome);
    // For local/SSH: expand tilde for comparison with message history paths
    // For Docker: paths are already absolute (/var/mux/...), no expansion needed
    const expandedPlanPath = muxHome.startsWith("~") ? expandTilde(planPath) : planPath;
    // Legacy plan path (stored by workspace ID) for filtering
    const legacyPlanPath = getLegacyPlanFilePath(workspaceId);
    const expandedLegacyPlanPath = expandTilde(legacyPlanPath);

    // Check both new and legacy plan paths, prefer new path
    const newPlanExists = await fileExists(runtime, planPath);
    const legacyPlanExists = !newPlanExists && (await fileExists(runtime, legacyPlanPath));
    // Resolve plan path via runtime to get correct absolute path for deep links.
    // Local: expands ~ to local home. SSH: expands ~ on remote host.
    const activePlanPath = newPlanExists
      ? await runtime.resolvePath(planPath)
      : legacyPlanExists
        ? await runtime.resolvePath(legacyPlanPath)
        : null;

    // Load exclusions
    const exclusions = await this.getPostCompactionExclusions(workspaceId);

    // Helper to check if a path is a plan file (new or legacy format)
    const isPlanPath = (p: string) =>
      p === planPath ||
      p === expandedPlanPath ||
      p === legacyPlanPath ||
      p === expandedLegacyPlanPath;

    // If session has pending compaction attachments, use cached paths
    // (history is cleared after compaction, but cache survives)
    const session = this.sessions.get(workspaceId);
    const pendingPaths = session?.getPendingTrackedFilePaths();
    if (pendingPaths) {
      // Filter out both new and legacy plan file paths
      const trackedFilePaths = pendingPaths.filter((p) => !isPlanPath(p));
      return {
        planPath: activePlanPath,
        trackedFilePaths,
        excludedItems: exclusions.excludedItems,
      };
    }

    // Fallback (crash-safe): if a post-compaction snapshot exists on disk, use it.
    const persistedPaths = await this.getPersistedPostCompactionDiffPaths(workspaceId);
    if (persistedPaths !== null) {
      const trackedFilePaths = persistedPaths.filter((p) => !isPlanPath(p));
      return {
        planPath: activePlanPath,
        trackedFilePaths,
        excludedItems: exclusions.excludedItems,
      };
    }

    // Fallback: compute tracked files from message history (survives reloads).
    // Only the current compaction epoch matters — post-compaction files are from
    // the active epoch only.
    const historyResult = await this.historyService.getHistoryFromLatestBoundary(workspaceId);
    const messages = historyResult.success ? historyResult.data : [];
    const allPaths = extractEditedFilePaths(messages);

    // Exclude plan file from tracked files since it has its own section
    // Filter out both new and legacy plan file paths
    const trackedFilePaths = allPaths.filter((p) => !isPlanPath(p));
    return {
      planPath: activePlanPath,
      trackedFilePaths,
      excludedItems: exclusions.excludedItems,
    };
  }

  /**
   * Get post-compaction exclusions for a workspace.
   * Returns empty exclusions if file doesn't exist.
   */
  public async getPostCompactionExclusions(workspaceId: string): Promise<PostCompactionExclusions> {
    const exclusionsPath = path.join(this.config.getSessionDir(workspaceId), "exclusions.json");
    try {
      const data = await fsPromises.readFile(exclusionsPath, "utf-8");
      return JSON.parse(data) as PostCompactionExclusions;
    } catch {
      return { excludedItems: [] };
    }
  }

  /**
   * Set whether an item is excluded from post-compaction context.
   * Item IDs: "plan" for plan file, "file:<path>" for tracked files.
   */
  public async setPostCompactionExclusion(
    workspaceId: string,
    itemId: string,
    excluded: boolean
  ): Promise<Result<void>> {
    try {
      const exclusions = await this.getPostCompactionExclusions(workspaceId);
      const set = new Set(exclusions.excludedItems);

      if (excluded) {
        set.add(itemId);
      } else {
        set.delete(itemId);
      }

      const sessionDir = this.config.getSessionDir(workspaceId);
      await fsPromises.mkdir(sessionDir, { recursive: true });
      const exclusionsPath = path.join(sessionDir, "exclusions.json");
      await fsPromises.writeFile(
        exclusionsPath,
        JSON.stringify({ excludedItems: [...set] }, null, 2)
      );
      return Ok(undefined);
    } catch (error) {
      const message = getErrorMessage(error);
      return Err(`Failed to set exclusion: ${message}`);
    }
  }

  async create(
    projectPath: string,
    branchName: string,
    trunkBranch: string | undefined,
    title?: string,
    runtimeConfig?: RuntimeConfig,
    sectionId?: string
  ): Promise<Result<{ metadata: FrontendWorkspaceMetadata }>> {
    // Chat with Mux is a built-in system workspace; it cannot host additional workspaces.
    if (projectPath === getMuxHelpChatProjectPath(this.config.rootDir)) {
      return Err("Cannot create workspaces in the Chat with Mux system project");
    }

    // Validate workspace name
    const validation = validateWorkspaceName(branchName);
    if (!validation.valid) {
      return Err(validation.error ?? "Invalid workspace name");
    }

    // Trust gate: block workspace creation for untrusted projects.
    // The frontend shows a confirmation dialog before reaching here,
    // but this guards secondary paths (slash commands, forking).
    const projectConfig = this.config
      .loadConfigOrDefault()
      .projects.get(stripTrailingSlashes(projectPath));
    if (!projectConfig?.trusted) {
      return Err(
        "This project must be trusted before creating workspaces. Trust the project in Settings → Security, or create a workspace from the project page."
      );
    }

    // Generate stable workspace ID
    const workspaceId = this.config.generateStableId();

    // Create runtime for workspace creation
    // Default to worktree runtime for backward compatibility
    let finalRuntimeConfig: RuntimeConfig = runtimeConfig ?? {
      type: "worktree",
      srcBaseDir: this.config.srcDir,
    };

    if (this.policyService?.isEnforced()) {
      if (!this.policyService.isRuntimeAllowed(finalRuntimeConfig)) {
        return Err("Selected runtime is not allowed by policy");
      }
    }

    // Local runtime doesn't need a trunk branch; worktree/SSH runtimes require it
    const isLocalRuntime = finalRuntimeConfig.type === "local";
    const normalizedTrunkBranch = trunkBranch?.trim() ?? "";
    if (!isLocalRuntime && normalizedTrunkBranch.length === 0) {
      return Err("Trunk branch is required for worktree and SSH runtimes");
    }

    let runtime;
    try {
      runtime = createRuntime(finalRuntimeConfig, { projectPath });

      // Resolve srcBaseDir path if the config has one.
      // Skip if runtime has deferredRuntimeAccess flag (runtime doesn't exist yet, e.g., Coder).
      const srcBaseDir = getSrcBaseDir(finalRuntimeConfig);
      if (srcBaseDir && !runtime.createFlags?.deferredRuntimeAccess) {
        const resolvedSrcBaseDir = await runtime.resolvePath(srcBaseDir);
        if (resolvedSrcBaseDir !== srcBaseDir && hasSrcBaseDir(finalRuntimeConfig)) {
          finalRuntimeConfig = {
            ...finalRuntimeConfig,
            srcBaseDir: resolvedSrcBaseDir,
          };
          runtime = createRuntime(finalRuntimeConfig, { projectPath });
        }
      }
    } catch (error) {
      const errorMsg = getErrorMessage(error);
      return Err(errorMsg);
    }

    const session = this.getOrCreateSession(workspaceId);
    this.initStateManager.startInit(workspaceId, projectPath);

    // Create abort controller immediately so workspace lifecycle operations (e.g., cancel/remove)
    // can reliably interrupt init even if the UI deletes the workspace during create().
    const initAbortController = new AbortController();
    this.initAbortControllers.set(workspaceId, initAbortController);

    const initLogger = this.createInitLogger(workspaceId);

    try {
      // Create workspace with automatic collision retry
      let finalBranchName = branchName;
      let createResult: { success: boolean; workspacePath?: string; error?: string };

      // If runtime uses config-level collision detection (e.g., Coder - can't reach host),
      // check against existing workspace names before createWorkspace.
      if (runtime.createFlags?.configLevelCollisionDetection) {
        const existingNames = new Set(
          (this.config.loadConfigOrDefault().projects.get(projectPath)?.workspaces ?? []).map(
            (w) => w.name
          )
        );
        for (
          let i = 0;
          i < MAX_WORKSPACE_NAME_COLLISION_RETRIES && existingNames.has(finalBranchName);
          i++
        ) {
          log.debug(`Workspace name collision for "${finalBranchName}", adding suffix`);
          finalBranchName = appendCollisionSuffix(branchName);
        }
      }

      for (let attempt = 0; attempt <= MAX_WORKSPACE_NAME_COLLISION_RETRIES; attempt++) {
        createResult = await runtime.createWorkspace({
          projectPath,
          branchName: finalBranchName,
          trunkBranch: normalizedTrunkBranch,
          directoryName: finalBranchName,
          initLogger,
          abortSignal: initAbortController.signal,
          trusted: projectConfig.trusted ?? false,
        });

        if (createResult.success) break;

        // If collision and not last attempt, retry with suffix
        if (
          isWorkspaceNameCollision(createResult.error) &&
          attempt < MAX_WORKSPACE_NAME_COLLISION_RETRIES
        ) {
          log.debug(`Workspace name collision for "${finalBranchName}", retrying with suffix`);
          finalBranchName = appendCollisionSuffix(branchName);
          continue;
        }
        break;
      }

      if (!createResult!.success || !createResult!.workspacePath) {
        initLogger.logComplete(-1);
        return Err(createResult!.error ?? "Failed to create workspace");
      }

      // Let runtime finalize config (e.g., derive names, compute host) after collision handling
      if (runtime.finalizeConfig) {
        const finalizeResult = await runtime.finalizeConfig(finalBranchName, finalRuntimeConfig);
        if (!finalizeResult.success) {
          initLogger.logComplete(-1);
          return Err(finalizeResult.error);
        }
        finalRuntimeConfig = finalizeResult.data;
        runtime = createRuntime(finalRuntimeConfig, { projectPath });
      }

      // Let runtime validate before persisting (e.g., external collision checks)
      if (runtime.validateBeforePersist) {
        const validateResult = await runtime.validateBeforePersist(
          finalBranchName,
          finalRuntimeConfig
        );
        if (!validateResult.success) {
          initLogger.logComplete(-1);
          return Err(validateResult.error);
        }
      }

      const projectName =
        projectPath.split("/").pop() ?? projectPath.split("\\").pop() ?? "unknown";

      const metadata = {
        id: workspaceId,
        name: finalBranchName,
        title,
        projectName,
        projectPath,
        createdAt: new Date().toISOString(),
      };

      await this.config.editConfig((config) => {
        let projectConfig = config.projects.get(projectPath);
        if (!projectConfig) {
          projectConfig = { workspaces: [] };
          config.projects.set(projectPath, projectConfig);
        }
        projectConfig.workspaces.push({
          path: createResult!.workspacePath!,
          id: workspaceId,
          name: finalBranchName,
          title,
          createdAt: metadata.createdAt,
          runtimeConfig: finalRuntimeConfig,
          sectionId,
        });
        return config;
      });

      const allMetadata = await this.config.getAllWorkspaceMetadata();
      const completeMetadata = allMetadata.find((m) => m.id === workspaceId);
      if (!completeMetadata) {
        initLogger.logComplete(-1);
        return Err("Failed to retrieve workspace metadata");
      }

      session.emitMetadata(this.enrichFrontendMetadata(completeMetadata));

      // Background init: run postCreateSetup (if present) then initWorkspace
      const secrets = secretsToRecord(this.config.getEffectiveSecrets(projectPath));
      // Background init: postCreateSetup (provisioning) + initWorkspace (sync/checkout/hook)
      //
      // If the user cancelled creation while create() was still in flight, avoid spawning
      // additional background work for a workspace that's already being removed.
      if (!this.removingWorkspaces.has(workspaceId) && !initAbortController.signal.aborted) {
        runBackgroundInit(
          runtime,
          {
            projectPath,
            branchName: finalBranchName,
            trunkBranch: normalizedTrunkBranch,
            workspacePath: createResult!.workspacePath,
            initLogger,
            env: secrets,
            abortSignal: initAbortController.signal,
            trusted: projectConfig.trusted ?? false,
          },
          workspaceId,
          log
        );
      } else {
        initAbortController.abort();
        this.initAbortControllers.delete(workspaceId);

        // Background init will never run, so init-end won’t fire.
        // Clear init state + re-emit metadata so the sidebar doesn’t stay stuck on isInitializing.
        this.initStateManager.clearInMemoryState(workspaceId);
        session.emitMetadata(this.enrichFrontendMetadata(completeMetadata));
      }

      return Ok({ metadata: this.enrichFrontendMetadata(completeMetadata) });
    } catch (error) {
      initLogger.logComplete(-1);
      const message = getErrorMessage(error);
      return Err(`Failed to create workspace: ${message}`);
    }
  }

  async remove(workspaceId: string, force = false): Promise<Result<void>> {
    if (workspaceId === MUX_HELP_CHAT_WORKSPACE_ID) {
      return Err("Cannot remove the Chat with Mux system workspace");
    }

    // Idempotent: if already removing, return success to prevent race conditions
    if (this.removingWorkspaces.has(workspaceId)) {
      return Ok(undefined);
    }
    this.removingWorkspaces.add(workspaceId);

    // If this workspace is mid-init, cancel the fire-and-forget init work (postCreateSetup,
    // sync/checkout, .mux/init hook, etc.) so removal doesn't leave orphaned background work.
    const initAbortController = this.initAbortControllers.get(workspaceId);
    if (initAbortController) {
      initAbortController.abort();
      this.initAbortControllers.delete(workspaceId);
    }

    // Try to remove from runtime (filesystem)
    try {
      // Stop any active stream before deleting metadata/config to avoid tool calls racing with removal.
      //
      // IMPORTANT: AIService forwards "stream-abort" asynchronously after partial cleanup. If we roll up
      // session timing (or delete session files) immediately after stopStream(), we can race the final
      // abort timing write.
      const wasStreaming = this.aiService.isStreaming(workspaceId);
      const streamStoppedEvent: Promise<"abort" | "end" | undefined> | undefined = wasStreaming
        ? new Promise((resolve) => {
            const aiService = this.aiService;
            const targetWorkspaceId = workspaceId;
            const timeoutMs = 5000;

            let settled = false;
            let timer: ReturnType<typeof setTimeout> | undefined;

            const cleanup = (result: "abort" | "end" | undefined) => {
              if (settled) return;
              settled = true;
              if (timer) {
                clearTimeout(timer);
                timer = undefined;
              }
              aiService.off("stream-abort", onAbort);
              aiService.off("stream-end", onEnd);
              resolve(result);
            };

            function onAbort(data: StreamAbortEvent): void {
              if (data.workspaceId !== targetWorkspaceId) return;
              cleanup("abort");
            }

            function onEnd(data: StreamEndEvent): void {
              if (data.workspaceId !== targetWorkspaceId) return;
              cleanup("end");
            }

            aiService.on("stream-abort", onAbort);
            aiService.on("stream-end", onEnd);

            timer = setTimeout(() => cleanup(undefined), timeoutMs);
          })
        : undefined;

      try {
        const stopResult = await this.aiService.stopStream(workspaceId, { abandonPartial: true });
        if (!stopResult.success) {
          log.debug("Failed to stop stream during workspace removal", {
            workspaceId,
            error: stopResult.error,
          });
        }
      } catch (error: unknown) {
        log.debug("Failed to stop stream during workspace removal (threw)", { workspaceId, error });
      }

      if (streamStoppedEvent) {
        const stopEvent = await streamStoppedEvent;
        if (!stopEvent) {
          log.debug("Timed out waiting for stream to stop during workspace removal", {
            workspaceId,
          });
        }

        // If session timing is enabled, make sure no pending writes can recreate session files after
        // we delete the session directory.
        if (this.sessionTimingService) {
          await this.sessionTimingService.waitForIdle(workspaceId);
        }
      }

      let parentWorkspaceId: string | null = null;
      let childTaskModelString: string | undefined;
      let childTaskThinkingLevel: ThinkingLevel | undefined;

      const metadataResult = await this.aiService.getWorkspaceMetadata(workspaceId);
      if (metadataResult.success) {
        const metadata = metadataResult.data;
        const projectPath = metadata.projectPath;

        const runtime = createRuntime(metadata.runtimeConfig, {
          projectPath,
          workspaceName: metadata.name,
        });

        // Delete workspace from runtime first - if this fails with force=false, we abort
        // and keep workspace in config so user can retry. This prevents orphaned directories.
        const trusted =
          this.config.loadConfigOrDefault().projects.get(stripTrailingSlashes(projectPath))
            ?.trusted ?? false;
        const deleteResult = await runtime.deleteWorkspace(
          projectPath,
          metadata.name, // use branch name
          force,
          undefined, // abortSignal
          trusted
        );

        if (!deleteResult.success) {
          // If force is true, we continue to remove from config even if fs removal failed
          if (!force) {
            return Err(deleteResult.error ?? "Failed to delete workspace from disk");
          }
          log.error(
            `Failed to delete workspace from disk, but force=true. Removing from config. Error: ${deleteResult.error}`
          );
        }

        // Note: Coder workspace deletion is handled by CoderSSHRuntime.deleteWorkspace()

        parentWorkspaceId = metadata.parentWorkspaceId ?? null;
        childTaskModelString = metadata.taskModelString;
        childTaskThinkingLevel = coerceThinkingLevel(metadata.taskThinkingLevel);

        // If this workspace is a sub-agent/task, roll its accumulated timing into the parent BEFORE
        // deleting ~/.mux/sessions/<workspaceId>/session-timing.json.
        if (parentWorkspaceId && this.sessionTimingService) {
          try {
            // Flush any last timing write (e.g. from stream-abort) before reading.
            await this.sessionTimingService.waitForIdle(workspaceId);
            await this.sessionTimingService.rollUpTimingIntoParent(parentWorkspaceId, workspaceId);
          } catch (error: unknown) {
            log.error("Failed to roll up child session timing into parent", {
              workspaceId,
              parentWorkspaceId,
              error: getErrorMessage(error),
            });
          }
        }

        // If this workspace is a sub-agent/task, roll its accumulated usage into the parent BEFORE
        // deleting ~/.mux/sessions/<workspaceId>/session-usage.json.
        if (parentWorkspaceId && this.sessionUsageService) {
          try {
            const childUsage = await this.sessionUsageService.getSessionUsage(workspaceId);
            if (childUsage && Object.keys(childUsage.byModel).length > 0) {
              const rollup = await this.sessionUsageService.rollUpUsageIntoParent(
                parentWorkspaceId,
                workspaceId,
                childUsage.byModel,
                {
                  agentType: metadata.agentType,
                  model: metadata.taskModelString,
                }
              );

              if (rollup.didRollUp) {
                // Live UI update (best-effort): only emit if the parent session is already active.
                this.sessions.get(parentWorkspaceId)?.emitChatEvent({
                  type: "session-usage-delta",
                  workspaceId: parentWorkspaceId,
                  sourceWorkspaceId: workspaceId,
                  byModelDelta: childUsage.byModel,
                  timestamp: Date.now(),
                });
              }
            }
          } catch (error: unknown) {
            log.error("Failed to roll up child session usage into parent", {
              workspaceId,
              parentWorkspaceId,
              error: getErrorMessage(error),
            });
          }
        }
      } else {
        log.error(`Could not find metadata for workspace ${workspaceId}, creating phantom cleanup`);
      }

      // Avoid leaking init waiters/logs after workspace deletion.
      // Must happen before deleting the session directory so queued init-status writes don't
      // recreate ~/.mux/sessions/<workspaceId>/ after removal.
      //
      // Intentionally deferred until we're committed to removal: if runtime deletion fails with
      // force=false we return early and keep init state intact so init-end can refresh metadata.
      this.initStateManager.clearInMemoryState(workspaceId);
      // Remove session data
      try {
        const sessionDir = this.config.getSessionDir(workspaceId);

        if (parentWorkspaceId) {
          try {
            const parentSessionDir = this.config.getSessionDir(parentWorkspaceId);
            await archiveChildSessionArtifactsIntoParentSessionDir({
              parentWorkspaceId,
              parentSessionDir,
              childWorkspaceId: workspaceId,
              childSessionDir: sessionDir,
              childTaskModelString,
              childTaskThinkingLevel,
            });
          } catch (error: unknown) {
            log.error("Failed to roll up child session artifacts into parent", {
              workspaceId,
              parentWorkspaceId,
              error: getErrorMessage(error),
            });
          }
        }

        await fsPromises.rm(sessionDir, { recursive: true, force: true });
      } catch (error) {
        log.error(`Failed to remove session directory for ${workspaceId}:`, error);
      }

      // Stop MCP servers for this workspace
      if (this.mcpServerManager) {
        await this.mcpServerManager.stopServers(workspaceId);
      }

      // Dispose session
      this.disposeSession(workspaceId);

      // Close any terminal sessions for this workspace
      this.terminalService?.closeWorkspaceSessions(workspaceId);

      // Remove from config
      await this.config.removeWorkspace(workspaceId);

      this.emit("metadata", { workspaceId, metadata: null });

      return Ok(undefined);
    } catch (error) {
      const message = getErrorMessage(error);
      return Err(`Failed to remove workspace: ${message}`);
    } finally {
      this.removingWorkspaces.delete(workspaceId);
    }
  }

  private enrichFrontendMetadata(metadata: FrontendWorkspaceMetadata): FrontendWorkspaceMetadata {
    const isInitializing =
      this.initStateManager.getInitState(metadata.id)?.status === "running" || undefined;
    return {
      ...metadata,
      isRemoving: this.removingWorkspaces.has(metadata.id) || undefined,
      isInitializing,
    };
  }

  private enrichMaybeFrontendMetadata(
    metadata: FrontendWorkspaceMetadata | null
  ): FrontendWorkspaceMetadata | null {
    if (!metadata) {
      return null;
    }
    return this.enrichFrontendMetadata(metadata);
  }

  async list(): Promise<FrontendWorkspaceMetadata[]> {
    try {
      const workspaces = await this.config.getAllWorkspaceMetadata();
      return workspaces.map((w) => this.enrichFrontendMetadata(w));
    } catch (error) {
      log.error("Failed to list workspaces:", error);
      return [];
    }
  }

  /**
   * Get devcontainer info for deep link generation.
   * Returns null if not a devcontainer workspace or container is not running.
   *
   * This queries Docker for the container name (on-demand discovery) and
   * calls ensureReady to get the container workspace path.
   */
  async getDevcontainerInfo(workspaceId: string): Promise<{
    containerName: string;
    containerWorkspacePath: string;
    hostWorkspacePath: string;
  } | null> {
    const metadata = await this.getInfo(workspaceId);
    if (metadata?.runtimeConfig?.type !== "devcontainer") {
      return null;
    }

    const workspace = this.config.findWorkspace(workspaceId);
    if (!workspace) {
      return null;
    }

    // Get the host workspace path
    const runtimeConfig = metadata.runtimeConfig;
    const runtime = createRuntime(runtimeConfig, {
      projectPath: metadata.projectPath,
      workspaceName: metadata.name,
    });

    const hostWorkspacePath = runtime.getWorkspacePath(metadata.projectPath, metadata.name);

    // Query Docker for container name (on-demand discovery)
    const containerName = await getDevcontainerContainerName(hostWorkspacePath);
    if (!containerName) {
      return null; // Container not running
    }

    // Get container workspace path via ensureReady (idempotent if already running)
    const readyResult = await runtime.ensureReady();
    if (!readyResult.ready) {
      return null;
    }

    // Access the cached remoteWorkspaceFolder from DevcontainerRuntime
    const devRuntime = runtime as DevcontainerRuntime;
    const containerWorkspacePath = devRuntime.getRemoteWorkspaceFolder();
    if (!containerWorkspacePath) {
      return null;
    }

    return { containerName, containerWorkspacePath, hostWorkspacePath };
  }
  async getInfo(workspaceId: string): Promise<FrontendWorkspaceMetadata | null> {
    const allMetadata = await this.config.getAllWorkspaceMetadata();
    const found = allMetadata.find((m) => m.id === workspaceId) ?? null;
    return this.enrichMaybeFrontendMetadata(found);
  }

  /**
   * Refresh workspace metadata from config and emit to subscribers.
   * Useful when external changes (like section assignment) modify workspace config.
   */
  async refreshAndEmitMetadata(workspaceId: string): Promise<void> {
    const metadata = await this.getInfo(workspaceId);
    if (metadata) {
      this.emit("metadata", { workspaceId, metadata });
    }
  }

  async rename(workspaceId: string, newName: string): Promise<Result<{ newWorkspaceId: string }>> {
    try {
      if (this.aiService.isStreaming(workspaceId)) {
        return Err(
          "Cannot rename workspace while AI stream is active. Please wait for the stream to complete."
        );
      }

      const validation = validateWorkspaceName(newName);
      if (!validation.valid) {
        return Err(validation.error ?? "Invalid workspace name");
      }

      // Mark workspace as renaming to block new streams during the rename operation
      this.renamingWorkspaces.add(workspaceId);

      const metadataResult = await this.aiService.getWorkspaceMetadata(workspaceId);
      if (!metadataResult.success) {
        return Err(`Failed to get workspace metadata: ${metadataResult.error}`);
      }
      const oldMetadata = metadataResult.data;
      const oldName = oldMetadata.name;

      if (newName === oldName) {
        return Ok({ newWorkspaceId: workspaceId });
      }

      const allWorkspaces = await this.config.getAllWorkspaceMetadata();
      const collision = allWorkspaces.find(
        (ws) => (ws.name === newName || ws.id === newName) && ws.id !== workspaceId
      );
      if (collision) {
        return Err(`Workspace with name "${newName}" already exists`);
      }

      const workspace = this.config.findWorkspace(workspaceId);
      if (!workspace) {
        return Err("Failed to find workspace in config");
      }
      const { projectPath } = workspace;

      const runtime = createRuntime(oldMetadata.runtimeConfig, {
        projectPath,
        workspaceName: oldName,
      });

      const trusted =
        this.config.loadConfigOrDefault().projects.get(stripTrailingSlashes(projectPath))
          ?.trusted ?? false;
      const renameResult = await runtime.renameWorkspace(
        projectPath,
        oldName,
        newName,
        undefined, // abortSignal
        trusted
      );

      if (!renameResult.success) {
        return Err(renameResult.error);
      }

      const { oldPath, newPath } = renameResult;

      await this.config.editConfig((config) => {
        const projectConfig = config.projects.get(projectPath);
        if (projectConfig) {
          const workspaceEntry =
            projectConfig.workspaces.find((w) => w.id === workspaceId) ??
            projectConfig.workspaces.find((w) => w.path === oldPath);
          if (workspaceEntry) {
            workspaceEntry.name = newName;
            workspaceEntry.path = newPath;
          }
        }
        return config;
      });

      // Rename plan file if it exists (uses workspace name, not ID)
      await movePlanFile(runtime, oldName, newName, oldMetadata.projectName);

      const allMetadataUpdated = await this.config.getAllWorkspaceMetadata();
      const updatedMetadata = allMetadataUpdated.find((m) => m.id === workspaceId);
      if (!updatedMetadata) {
        return Err("Failed to retrieve updated workspace metadata");
      }

      const enrichedMetadata = this.enrichFrontendMetadata(updatedMetadata);

      const session = this.sessions.get(workspaceId);
      if (session) {
        session.emitMetadata(enrichedMetadata);
      } else {
        this.emit("metadata", { workspaceId, metadata: enrichedMetadata });
      }

      return Ok({ newWorkspaceId: workspaceId });
    } catch (error) {
      const message = getErrorMessage(error);
      return Err(`Failed to rename workspace: ${message}`);
    } finally {
      // Always clear renaming flag, even on error
      this.renamingWorkspaces.delete(workspaceId);
    }
  }

  /**
   * Update workspace title without affecting the filesystem name.
   * Unlike rename(), this can be called even while streaming is active.
   */
  async updateTitle(workspaceId: string, title: string): Promise<Result<void>> {
    try {
      const workspace = this.config.findWorkspace(workspaceId);
      if (!workspace) {
        return Err("Workspace not found");
      }
      const { projectPath, workspacePath } = workspace;

      await this.config.editConfig((config) => {
        const projectConfig = config.projects.get(projectPath);
        if (projectConfig) {
          const workspaceEntry =
            projectConfig.workspaces.find((w) => w.id === workspaceId) ??
            projectConfig.workspaces.find((w) => w.path === workspacePath);
          if (workspaceEntry) {
            workspaceEntry.title = title;
          }
        }
        return config;
      });

      // Emit updated metadata
      const allMetadata = await this.config.getAllWorkspaceMetadata();
      const updatedMetadata = allMetadata.find((m) => m.id === workspaceId);
      if (updatedMetadata) {
        const enrichedMetadata = this.enrichFrontendMetadata(updatedMetadata);
        const session = this.sessions.get(workspaceId);
        if (session) {
          session.emitMetadata(enrichedMetadata);
        } else {
          this.emit("metadata", { workspaceId, metadata: enrichedMetadata });
        }
      }

      return Ok(undefined);
    } catch (error) {
      const message = getErrorMessage(error);
      return Err(`Failed to update workspace title: ${message}`);
    }
  }

  /**
   * Regenerate the workspace title from chat history using AI.
   * Uses the first user message as the durable objective, plus a context block with
   * that first user message and the latest turns, then persists the generated title.
   */
  async regenerateTitle(workspaceId: string): Promise<Result<{ title: string }>> {
    const historyResult = await this.historyService.getHistoryFromLatestBoundary(workspaceId);
    if (!historyResult.success) {
      return Err("Could not read workspace history");
    }

    let contextTurns = collectWorkspaceTitleContextTurns(historyResult.data);
    let firstUserText = contextTurns.find((turn) => turn.role === "user")?.text;

    if (!firstUserText) {
      // Compaction boundaries can leave the latest epoch with only an assistant summary.
      // Fall back to scanning full history so regenerateTitle still works for compacted chats.
      const fallbackTurns: WorkspaceTitleContextTurn[] = [];
      let fallbackFirstUserText: string | undefined;
      const fullHistoryResult = await this.historyService.iterateFullHistory(
        workspaceId,
        "forward",
        (messages) => {
          const chunkTurns = collectWorkspaceTitleContextTurns(messages);
          for (const turn of chunkTurns) {
            if (!fallbackFirstUserText && turn.role === "user") {
              fallbackFirstUserText = turn.text;
            }
            fallbackTurns.push(turn);
          }
        }
      );
      if (!fullHistoryResult.success) {
        return Err("Could not read workspace history");
      }

      firstUserText = fallbackFirstUserText;
      contextTurns = fallbackTurns;
    }

    if (!firstUserText) {
      return Err("No user messages in workspace history");
    }

    const { conversationContext, latestUserText } =
      buildWorkspaceTitleConversationContext(contextTurns);

    const candidates: string[] = [...NAME_GEN_PREFERRED_MODELS];
    const metadataResult = await this.aiService.getWorkspaceMetadata(workspaceId);
    if (metadataResult.success) {
      const fallbackModels = [
        metadataResult.data.aiSettings?.model,
        ...Object.values(metadataResult.data.aiSettingsByAgent ?? {}).map(
          (settings) => settings.model
        ),
      ];
      for (const model of fallbackModels) {
        if (model && !candidates.includes(model)) {
          candidates.push(model);
        }
      }
    }

    const result = await generateWorkspaceIdentity(
      firstUserText,
      candidates,
      this.aiService,
      conversationContext,
      latestUserText
    );
    if (!result.success) {
      return Err("Title generation failed");
    }

    const updateTitleResult = await this.updateTitle(workspaceId, result.data.title);
    if (!updateTitleResult.success) {
      return Err(updateTitleResult.error);
    }

    return Ok({ title: result.data.title });
  }

  /**
   * Archive a workspace. Archived workspaces are hidden from the main sidebar
   * but can be viewed on the project page.
   *
   * If init is still running, we abort it before archiving so we don't leave
   * orphaned post-create work running in the background.
   */
  async archive(workspaceId: string): Promise<Result<void>> {
    if (workspaceId === MUX_HELP_CHAT_WORKSPACE_ID) {
      return Err("Cannot archive the Chat with Mux system workspace");
    }

    this.archivingWorkspaces.add(workspaceId);

    try {
      const workspace = this.config.findWorkspace(workspaceId);
      if (!workspace) {
        return Err("Workspace not found");
      }
      const initState = this.initStateManager.getInitState(workspaceId);
      if (initState?.status === "running") {
        // Archiving should not leave post-create setup running in the background.
        const initAbortController = this.initAbortControllers.get(workspaceId);
        if (initAbortController) {
          initAbortController.abort();
          this.initAbortControllers.delete(workspaceId);
        }

        this.initStateManager.clearInMemoryState(workspaceId);

        // Clearing init state prevents init-end from firing (createInitLogger.logComplete() bails when
        // state is missing). If archiving fails before we persist archivedAt (e.g., beforeArchive hook
        // error), ensure the sidebar doesn't stay stuck on isInitializing/"Cancel creation".
        try {
          const allMetadata = await this.config.getAllWorkspaceMetadata();
          const updatedMetadata = allMetadata.find((m) => m.id === workspaceId);
          if (updatedMetadata) {
            const enrichedMetadata = this.enrichFrontendMetadata(updatedMetadata);
            const session = this.sessions.get(workspaceId);
            if (session) {
              session.emitMetadata(enrichedMetadata);
            } else {
              this.emit("metadata", { workspaceId, metadata: enrichedMetadata });
            }
          }
        } catch (error) {
          log.debug("Failed to emit metadata after init cancellation during archive", {
            workspaceId,
            error: getErrorMessage(error),
          });
        }
      }

      const { projectPath, workspacePath } = workspace;

      // Lifecycle hooks run *before* we persist archivedAt.
      //
      // NOTE: Archiving is typically a quick UI action, but it can fail if a hook needs to perform
      // cleanup (e.g., stopping a dedicated mux-created Coder workspace) and that cleanup fails.
      if (this.workspaceLifecycleHooks) {
        const metadataResult = await this.aiService.getWorkspaceMetadata(workspaceId);
        if (!metadataResult.success) {
          return Err(metadataResult.error);
        }

        const hookResult = await this.workspaceLifecycleHooks.runBeforeArchive({
          workspaceId,
          workspaceMetadata: metadataResult.data,
        });
        if (!hookResult.success) {
          return Err(hookResult.error);
        }
      }

      // Archiving removes the workspace from the sidebar; ensure we don't leave a stream running
      // "headless" with no obvious UI affordance to interrupt it.
      //
      // NOTE: We only interrupt after beforeArchive hooks succeed, so a hook failure doesn't stop
      // an active stream.
      if (this.aiService.isStreaming(workspaceId)) {
        const stopResult = await this.interruptStream(workspaceId);
        if (!stopResult.success) {
          log.debug("Failed to stop stream during workspace archive", {
            workspaceId,
            error: stopResult.error,
          });
        }
      }

      // Archiving hides workspace UI; do not leave terminal PTYs running headless.
      this.terminalService?.closeWorkspaceSessions(workspaceId);

      await this.config.editConfig((config) => {
        const projectConfig = config.projects.get(projectPath);
        if (projectConfig) {
          const workspaceEntry =
            projectConfig.workspaces.find((w) => w.id === workspaceId) ??
            projectConfig.workspaces.find((w) => w.path === workspacePath);
          if (workspaceEntry) {
            // Just set archivedAt - archived state is derived from archivedAt > unarchivedAt
            workspaceEntry.archivedAt = new Date().toISOString();
          }
        }
        return config;
      });

      // Emit updated metadata
      const allMetadata = await this.config.getAllWorkspaceMetadata();
      const updatedMetadata = allMetadata.find((m) => m.id === workspaceId);
      if (updatedMetadata) {
        const enrichedMetadata = this.enrichFrontendMetadata(updatedMetadata);
        const session = this.sessions.get(workspaceId);
        if (session) {
          session.emitMetadata(enrichedMetadata);
        } else {
          this.emit("metadata", { workspaceId, metadata: enrichedMetadata });
        }
      }

      return Ok(undefined);
    } catch (error) {
      const message = getErrorMessage(error);
      return Err(`Failed to archive workspace: ${message}`);
    } finally {
      this.archivingWorkspaces.delete(workspaceId);
    }
  }

  /**
   * Unarchive a workspace. Restores it to the main sidebar view.
   */
  async unarchive(workspaceId: string): Promise<Result<void>> {
    if (workspaceId === MUX_HELP_CHAT_WORKSPACE_ID) {
      return Err("Cannot unarchive the Chat with Mux system workspace");
    }

    try {
      const workspace = this.config.findWorkspace(workspaceId);
      if (!workspace) {
        return Err("Workspace not found");
      }
      const { projectPath, workspacePath } = workspace;

      let didUnarchive = false;

      await this.config.editConfig((config) => {
        const projectConfig = config.projects.get(projectPath);
        if (projectConfig) {
          const workspaceEntry =
            projectConfig.workspaces.find((w) => w.id === workspaceId) ??
            projectConfig.workspaces.find((w) => w.path === workspacePath);
          if (workspaceEntry) {
            const wasArchived = isWorkspaceArchived(
              workspaceEntry.archivedAt,
              workspaceEntry.unarchivedAt
            );
            if (wasArchived) {
              // Just set unarchivedAt - archived state is derived from archivedAt > unarchivedAt.
              // This also bumps workspace to top of recency.
              workspaceEntry.unarchivedAt = new Date().toISOString();
              didUnarchive = true;
            }
          }
        }
        return config;
      });

      // Only run hooks when the workspace is transitioning from archived → unarchived.
      if (!didUnarchive) {
        return Ok(undefined);
      }

      // Emit updated metadata
      const allMetadata = await this.config.getAllWorkspaceMetadata();
      const updatedMetadata = allMetadata.find((m) => m.id === workspaceId);
      if (updatedMetadata) {
        const enrichedMetadata = this.enrichFrontendMetadata(updatedMetadata);
        const session = this.sessions.get(workspaceId);
        if (session) {
          session.emitMetadata(enrichedMetadata);
        } else {
          this.emit("metadata", { workspaceId, metadata: enrichedMetadata });
        }
      }

      // Lifecycle hooks run *after* we persist unarchivedAt.
      //
      // Why best-effort: Unarchive is a quick UI action and should not fail permanently due to a
      // start error (e.g., Coder workspace start).
      if (this.workspaceLifecycleHooks) {
        let hookMetadata: WorkspaceMetadata | undefined = updatedMetadata;
        if (!hookMetadata) {
          const metadataResult = await this.aiService.getWorkspaceMetadata(workspaceId);
          if (metadataResult.success) {
            hookMetadata = metadataResult.data;
          } else {
            log.debug("Failed to load workspace metadata for afterUnarchive hooks", {
              workspaceId,
              error: metadataResult.error,
            });
          }
        }

        if (hookMetadata) {
          await this.workspaceLifecycleHooks.runAfterUnarchive({
            workspaceId,
            workspaceMetadata: hookMetadata,
          });
        }
      }

      return Ok(undefined);
    } catch (error) {
      const message = getErrorMessage(error);
      return Err(`Failed to unarchive workspace: ${message}`);
    }
  }

  /**
   * Archive all non-archived workspaces within a project whose GitHub PR is merged.
   *
   * This is intended for a single command-palette action (one backend call), to avoid
   * O(n) frontend→backend loops.
   */
  async archiveMergedInProject(projectPath: string): Promise<Result<ArchiveMergedInProjectResult>> {
    const targetProjectPath = projectPath.trim();
    if (!targetProjectPath) {
      return Err("projectPath is required");
    }

    const archivedWorkspaceIds: string[] = [];
    const skippedWorkspaceIds: string[] = [];
    const errors: Array<{ workspaceId: string; error: string }> = [];

    try {
      const allMetadata = await this.config.getAllWorkspaceMetadata();

      const candidates = allMetadata.filter((metadata) => {
        if (metadata.id === MUX_HELP_CHAT_WORKSPACE_ID) {
          return false;
        }
        if (metadata.projectPath !== targetProjectPath) {
          return false;
        }
        return !isWorkspaceArchived(metadata.archivedAt, metadata.unarchivedAt);
      });

      const mergedWorkspaceIds: string[] = [];

      const GH_CONCURRENCY_LIMIT = 4;
      const GH_TIMEOUT_SECS = 15;

      await forEachWithConcurrencyLimit(candidates, GH_CONCURRENCY_LIMIT, async (metadata) => {
        const workspaceId = metadata.id;

        try {
          const result = await this.executeBash(
            workspaceId,
            `gh pr view --json state 2>/dev/null || echo '{"no_pr":true}'`,
            { timeout_secs: GH_TIMEOUT_SECS }
          );

          if (!result.success) {
            errors.push({ workspaceId, error: result.error });
            return;
          }

          if (!result.data.success) {
            errors.push({ workspaceId, error: result.data.error });
            return;
          }

          const output = result.data.output;
          if (!output || output.trim().length === 0) {
            errors.push({ workspaceId, error: "gh pr view returned empty output" });
            return;
          }

          let parsed: unknown;
          try {
            parsed = JSON.parse(output);
          } catch (error) {
            const message = getErrorMessage(error);
            errors.push({ workspaceId, error: `Failed to parse gh output: ${message}` });
            return;
          }

          if (typeof parsed !== "object" || parsed === null) {
            errors.push({ workspaceId, error: "Unexpected gh output: not a JSON object" });
            return;
          }

          const record = parsed as Record<string, unknown>;

          if ("no_pr" in record) {
            skippedWorkspaceIds.push(workspaceId);
            return;
          }

          if (record.state === "MERGED") {
            mergedWorkspaceIds.push(workspaceId);
            return;
          }

          skippedWorkspaceIds.push(workspaceId);
        } catch (error) {
          const message = getErrorMessage(error);
          errors.push({ workspaceId, error: message });
        }
      });

      // Archive sequentially: config.editConfig is not mutex-protected.
      for (const workspaceId of mergedWorkspaceIds) {
        const result = await this.archive(workspaceId);
        if (!result.success) {
          errors.push({ workspaceId, error: result.error });
          continue;
        }
        archivedWorkspaceIds.push(workspaceId);
      }

      archivedWorkspaceIds.sort();
      skippedWorkspaceIds.sort();
      errors.sort((a, b) => a.workspaceId.localeCompare(b.workspaceId));

      return Ok({
        archivedWorkspaceIds,
        skippedWorkspaceIds,
        errors,
      });
    } catch (error) {
      const message = getErrorMessage(error);
      return Err(`Failed to archive merged workspaces: ${message}`);
    }
  }

  private normalizeWorkspaceAISettings(
    aiSettings: WorkspaceAISettings
  ): Result<WorkspaceAISettings, string> {
    const rawModel = aiSettings.model;
    const model = normalizeGatewayModel(rawModel).trim();
    if (!model) {
      return Err("Model is required");
    }
    if (!isValidModelFormat(model)) {
      return Err(`Invalid model format: ${rawModel}`);
    }

    return Ok({
      model,
      thinkingLevel: aiSettings.thinkingLevel,
    });
  }

  private normalizeSendMessageAgentId(options: SendMessageOptions): SendMessageOptions {
    // agentId is required by the schema, so this just normalizes the value.
    const rawAgentId = options.agentId;
    const normalizedAgentId =
      typeof rawAgentId === "string" && rawAgentId.trim().length > 0
        ? rawAgentId.trim().toLowerCase()
        : WORKSPACE_DEFAULTS.agentId;

    if (normalizedAgentId === options.agentId) {
      return options;
    }

    return {
      ...options,
      agentId: normalizedAgentId,
    };
  }

  private extractWorkspaceAISettingsFromSendOptions(
    options: SendMessageOptions | undefined
  ): WorkspaceAISettings | null {
    const rawModel = options?.model;
    if (typeof rawModel !== "string" || rawModel.trim().length === 0) {
      return null;
    }

    const model = normalizeGatewayModel(rawModel).trim();
    if (!isValidModelFormat(model)) {
      return null;
    }

    const requestedThinking = options?.thinkingLevel;
    // Be defensive: if a (very) old client doesn't send thinkingLevel, don't overwrite
    // any existing workspace-scoped value.
    if (requestedThinking === undefined) {
      return null;
    }

    const thinkingLevel = requestedThinking;

    return { model, thinkingLevel };
  }

  /**
   * Best-effort persist AI settings from send/resume options.
   * Skips requests explicitly marked to avoid persistence.
   */
  private async maybePersistAISettingsFromOptions(
    workspaceId: string,
    options: SendMessageOptions | undefined,
    context: "send" | "resume"
  ): Promise<void> {
    if (options?.skipAiSettingsPersistence) {
      // One-shot/compaction sends shouldn't overwrite workspace defaults.
      return;
    }

    const extractedSettings = this.extractWorkspaceAISettingsFromSendOptions(options);
    if (!extractedSettings) return;

    const rawAgentId = options?.agentId;
    const agentId =
      typeof rawAgentId === "string" && rawAgentId.trim().length > 0
        ? rawAgentId.trim().toLowerCase()
        : WORKSPACE_DEFAULTS.agentId;

    const persistResult = await this.persistWorkspaceAISettingsForAgent(
      workspaceId,
      agentId,
      extractedSettings,
      {
        emitMetadata: false,
      }
    );
    if (!persistResult.success) {
      log.debug(`Failed to persist workspace AI settings from ${context} options`, {
        workspaceId,
        error: persistResult.error,
      });
    }
  }

  private async persistWorkspaceAISettingsForAgent(
    workspaceId: string,
    agentId: string,
    aiSettings: WorkspaceAISettings,
    options?: { emitMetadata?: boolean }
  ): Promise<Result<boolean, string>> {
    const found = this.config.findWorkspace(workspaceId);
    if (!found) {
      return Err("Workspace not found");
    }

    const { projectPath, workspacePath } = found;

    const config = this.config.loadConfigOrDefault();
    const projectConfig = config.projects.get(projectPath);
    if (!projectConfig) {
      return Err(`Project not found: ${projectPath}`);
    }

    const workspaceEntry = projectConfig.workspaces.find((w) => w.id === workspaceId);
    const workspaceEntryWithFallback =
      workspaceEntry ?? projectConfig.workspaces.find((w) => w.path === workspacePath);
    if (!workspaceEntryWithFallback) {
      return Err("Workspace not found");
    }

    const normalizedAgentId = agentId.trim().toLowerCase();
    if (!normalizedAgentId) {
      return Err("Agent ID is required");
    }

    const prev = workspaceEntryWithFallback.aiSettingsByAgent?.[normalizedAgentId];
    const changed =
      prev?.model !== aiSettings.model || prev?.thinkingLevel !== aiSettings.thinkingLevel;
    if (!changed) {
      return Ok(false);
    }

    workspaceEntryWithFallback.aiSettingsByAgent = {
      ...(workspaceEntryWithFallback.aiSettingsByAgent ?? {}),
      [normalizedAgentId]: aiSettings,
    };

    await this.config.saveConfig(config);

    if (options?.emitMetadata !== false) {
      const allMetadata = await this.config.getAllWorkspaceMetadata();
      const updatedMetadata = allMetadata.find((m) => m.id === workspaceId) ?? null;
      const enrichedMetadata = this.enrichMaybeFrontendMetadata(updatedMetadata);

      const session = this.sessions.get(workspaceId);
      if (session) {
        session.emitMetadata(enrichedMetadata);
      } else {
        this.emit("metadata", { workspaceId, metadata: enrichedMetadata });
      }
    }

    return Ok(true);
  }

  async updateModeAISettings(
    workspaceId: string,
    mode: UIMode,
    aiSettings: WorkspaceAISettings
  ): Promise<Result<void, string>> {
    // Mode-based updates use mode as the agentId.
    return this.updateAgentAISettings(workspaceId, mode, aiSettings);
  }

  async updateAgentAISettings(
    workspaceId: string,
    agentId: string,
    aiSettings: WorkspaceAISettings
  ): Promise<Result<void, string>> {
    try {
      const normalized = this.normalizeWorkspaceAISettings(aiSettings);
      if (!normalized.success) {
        return Err(normalized.error);
      }

      const persistResult = await this.persistWorkspaceAISettingsForAgent(
        workspaceId,
        agentId,
        normalized.data,
        {
          emitMetadata: true,
        }
      );
      if (!persistResult.success) {
        return Err(persistResult.error);
      }

      return Ok(undefined);
    } catch (error) {
      const message = getErrorMessage(error);
      return Err(`Failed to update workspace AI settings: ${message}`);
    }
  }

  async fork(
    sourceWorkspaceId: string,
    newName?: string
  ): Promise<Result<{ metadata: FrontendWorkspaceMetadata; projectPath: string }>> {
    try {
      if (sourceWorkspaceId === MUX_HELP_CHAT_WORKSPACE_ID) {
        return Err("Cannot fork the Chat with Mux system workspace");
      }

      if (this.aiService.isStreaming(sourceWorkspaceId)) {
        await this.historyService.commitPartial(sourceWorkspaceId);
      }

      const sourceMetadataResult = await this.aiService.getWorkspaceMetadata(sourceWorkspaceId);
      if (!sourceMetadataResult.success) {
        return Err(`Failed to get source workspace metadata: ${sourceMetadataResult.error}`);
      }
      const sourceMetadata = sourceMetadataResult.data;
      const foundProjectPath = sourceMetadata.projectPath;
      const projectName = sourceMetadata.projectName;
      const sourceRuntimeConfig = sourceMetadata.runtimeConfig;

      // Policy: do not allow creating new workspaces (including via fork) with a disallowed runtime.
      if (this.policyService?.isEnforced()) {
        if (!this.policyService.isRuntimeAllowed(sourceRuntimeConfig)) {
          return Err("Forking this workspace is not allowed by policy (runtime disabled)");
        }
      }

      // Trust gate: block fork for untrusted projects.
      // Same defense-in-depth as create() — the frontend shows a dialog,
      // but forking is a secondary creation path that needs backend gating.
      const projectConfig = this.config
        .loadConfigOrDefault()
        .projects.get(stripTrailingSlashes(foundProjectPath));
      if (!projectConfig?.trusted) {
        return Err(
          "This project must be trusted before creating workspaces. Trust the project in Settings → Security, or create a workspace from the project page."
        );
      }

      // Auto-generate branch name (and title) when user omits one (seamless fork).
      // Uses pattern: {parentName}-fork-{N} for branch, "{parentTitle} (N)" for title.
      const isAutoName = newName == null;
      // Fetch all metadata upfront for both branch name and title collision checks.
      const allMetadata = isAutoName ? await this.config.getAllWorkspaceMetadata() : [];
      let resolvedName: string;
      if (isAutoName) {
        const existingNamesSet = new Set(
          allMetadata.filter((m) => m.projectPath === foundProjectPath).map((m) => m.name)
        );
        // Also include local branch names to avoid silently reusing stale branches that
        // were left behind on disk but no longer exist in config metadata.
        try {
          for (const branchName of await listLocalBranches(foundProjectPath)) {
            existingNamesSet.add(branchName);
          }
        } catch (error) {
          log.debug("Failed to list local branches for fork auto-name preflight", {
            projectPath: foundProjectPath,
            error: getErrorMessage(error),
          });
        }

        const existingNames = [...existingNamesSet];
        resolvedName = generateForkBranchName(sourceMetadata.name, existingNames);

        if (!validateWorkspaceName(resolvedName).valid) {
          // Legacy workspace names can violate current naming rules (invalid
          // chars / length). Normalize and shrink the parent base until the
          // generated fork name satisfies current invariants.
          let normalizedParent = sourceMetadata.name
            .toLowerCase()
            .replace(/[^a-z0-9_-]+/g, "-")
            .replace(/-+/g, "-")
            .replace(/^[-_]+|[-_]+$/g, "");

          if (!normalizedParent) {
            normalizedParent = "workspace";
          }

          let candidateParent = normalizedParent;
          while (candidateParent.length > 1) {
            resolvedName = generateForkBranchName(candidateParent, existingNames);
            if (validateWorkspaceName(resolvedName).valid) {
              break;
            }
            candidateParent = candidateParent.slice(0, -1);
          }

          if (!validateWorkspaceName(resolvedName).valid) {
            resolvedName = generateForkBranchName(candidateParent, existingNames);
          }
        }
      } else {
        resolvedName = newName;
      }

      const resolvedNameValidation = validateWorkspaceName(resolvedName);
      if (!resolvedNameValidation.valid) {
        return Err(resolvedNameValidation.error ?? "Invalid workspace name");
      }

      const sourceRuntime = createRuntime(sourceRuntimeConfig, {
        projectPath: foundProjectPath,
        workspaceName: sourceMetadata.name,
      });

      const newWorkspaceId = this.config.generateStableId();

      const session = this.getOrCreateSession(newWorkspaceId);
      this.initStateManager.startInit(newWorkspaceId, foundProjectPath);
      const initLogger = this.createInitLogger(newWorkspaceId);

      const initAbortController = new AbortController();
      this.initAbortControllers.set(newWorkspaceId, initAbortController);

      let forkResult: Awaited<ReturnType<typeof orchestrateFork>>;
      try {
        forkResult = await orchestrateFork({
          sourceRuntime,
          projectPath: foundProjectPath,
          sourceWorkspaceName: sourceMetadata.name,
          newWorkspaceName: resolvedName,
          initLogger,
          config: this.config,
          sourceWorkspaceId,
          sourceRuntimeConfig,
          allowCreateFallback: false,
          abortSignal: initAbortController.signal,
          trusted: projectConfig.trusted ?? false,
        });
      } catch (error) {
        // Guarantee init lifecycle cleanup when orchestrateFork rejects.
        // initLogger.logComplete deletes from initAbortControllers and ends init state.
        initLogger.logComplete(-1);
        throw error;
      }

      if (!forkResult.success) {
        initLogger.logComplete(-1);
        return Err(forkResult.error);
      }

      const {
        workspacePath,
        trunkBranch,
        forkedRuntimeConfig,
        targetRuntime,
        sourceRuntimeConfigUpdate,
        sourceRuntimeConfigUpdated,
      } = forkResult.data;

      // Run init for forked workspace (fire-and-forget like create())
      const secrets = secretsToRecord(this.config.getEffectiveSecrets(foundProjectPath));
      runBackgroundInit(
        targetRuntime,
        {
          projectPath: foundProjectPath,
          branchName: resolvedName,
          trunkBranch,
          workspacePath,
          initLogger,
          env: secrets,
          abortSignal: initAbortController.signal,
          trusted: projectConfig.trusted ?? false,
        },
        newWorkspaceId,
        log
      );

      const sourceSessionDir = this.config.getSessionDir(sourceWorkspaceId);
      const newSessionDir = this.config.getSessionDir(newWorkspaceId);

      try {
        await fsPromises.mkdir(newSessionDir, { recursive: true });

        const sessionFiles = [
          "chat.jsonl",
          "partial.json",
          "session-timing.json",
          "session-usage.json",
        ] as const;
        for (const fileName of sessionFiles) {
          await copyIfExists(
            path.join(sourceSessionDir, fileName),
            path.join(newSessionDir, fileName)
          );
        }
      } catch (copyError) {
        const forkTrusted = projectConfig.trusted ?? false;
        await targetRuntime.deleteWorkspace(
          foundProjectPath,
          resolvedName,
          true,
          undefined,
          forkTrusted
        );
        try {
          await fsPromises.rm(newSessionDir, { recursive: true, force: true });
        } catch (cleanupError) {
          log.error(`Failed to clean up session dir ${newSessionDir}:`, cleanupError);
        }
        initLogger.logComplete(-1);
        const message = getErrorMessage(copyError);
        return Err(`Failed to copy chat history: ${message}`);
      }

      // Copy plan file using explicit source/target runtimes for cross-runtime safety.
      // Create a fresh source runtime handle because DockerRuntime.forkWorkspace() can
      // mutate the original runtime's container identity to target the new workspace.
      const freshSourceRuntime = createRuntime(sourceRuntimeConfig, {
        projectPath: foundProjectPath,
        workspaceName: sourceMetadata.name,
      });
      await copyPlanFileAcrossRuntimes(
        freshSourceRuntime,
        targetRuntime,
        sourceMetadata.name,
        sourceWorkspaceId,
        resolvedName,
        projectName
      );

      if (sourceRuntimeConfigUpdate) {
        await this.config.updateWorkspaceMetadata(sourceWorkspaceId, {
          runtimeConfig: sourceRuntimeConfigUpdate,
        });
      }

      if (sourceRuntimeConfigUpdated) {
        const allMetadataUpdated = await this.config.getAllWorkspaceMetadata();
        const updatedMetadata = allMetadataUpdated.find((m) => m.id === sourceWorkspaceId) ?? null;
        const enrichedMetadata = this.enrichMaybeFrontendMetadata(updatedMetadata);
        const sourceSession = this.sessions.get(sourceWorkspaceId);
        if (sourceSession) {
          sourceSession.emitMetadata(enrichedMetadata);
        } else {
          this.emit("metadata", { workspaceId: sourceWorkspaceId, metadata: enrichedMetadata });
        }
      }

      // Compute namedWorkspacePath for frontend metadata
      const namedWorkspacePath = targetRuntime.getWorkspacePath(foundProjectPath, resolvedName);

      const metadata: FrontendWorkspaceMetadata = {
        id: newWorkspaceId,
        name: resolvedName,
        projectName,
        projectPath: foundProjectPath,
        createdAt: new Date().toISOString(),
        runtimeConfig: forkedRuntimeConfig,
        namedWorkspacePath,
        // Preserve workspace organization when forking via /fork.
        sectionId: sourceMetadata.sectionId,
        // Seamless fork: generate a numbered title like "Parent Title (1)".
        ...(isAutoName
          ? {
              title: generateForkTitle(
                sourceMetadata.title ?? sourceMetadata.name,
                allMetadata
                  .filter((m) => m.projectPath === foundProjectPath)
                  .map((m) => m.title ?? m.name)
              ),
            }
          : {}),
      };

      await this.config.addWorkspace(foundProjectPath, metadata);

      const enrichedMetadata = this.enrichFrontendMetadata(metadata);
      session.emitMetadata(enrichedMetadata);

      return Ok({ metadata: enrichedMetadata, projectPath: foundProjectPath });
    } catch (error) {
      const message = getErrorMessage(error);
      return Err(`Failed to fork workspace: ${message}`);
    }
  }

  async sendMessage(
    workspaceId: string,
    message: string,
    options: SendMessageOptions & {
      fileParts?: FilePart[];
    },
    internal?: {
      allowQueuedAgentTask?: boolean;
      skipAutoResumeReset?: boolean;
      synthetic?: boolean;
      /** When true, reject instead of queueing if the workspace is busy. */
      requireIdle?: boolean;
    }
  ): Promise<Result<void, SendMessageError>> {
    log.debug("sendMessage handler: Received", {
      workspaceId,
      messagePreview: message.substring(0, 50),
      agentId: options?.agentId,
      options,
    });

    let resumedInterruptedTask = false;
    try {
      // Block streaming while workspace is being renamed to prevent path conflicts
      if (this.renamingWorkspaces.has(workspaceId)) {
        log.debug("sendMessage blocked: workspace is being renamed", { workspaceId });
        return Err({
          type: "unknown",
          raw: "Workspace is being renamed. Please wait and try again.",
        });
      }

      // Block streaming while workspace is being removed to prevent races with config/session deletion.
      if (this.removingWorkspaces.has(workspaceId)) {
        log.debug("sendMessage blocked: workspace is being removed", { workspaceId });
        return Err({
          type: "unknown",
          raw: "Workspace is being deleted. Please wait and try again.",
        });
      }

      // Guard: avoid creating sessions for workspaces that don't exist anymore.
      if (!this.config.findWorkspace(workspaceId)) {
        return Err({
          type: "unknown",
          raw: "Workspace not found. It may have been deleted.",
        });
      }

      // Guard: queued agent tasks must not start streaming via generic sendMessage calls.
      // They should only be started by TaskService once a parallel slot is available.
      if (!internal?.allowQueuedAgentTask) {
        const config = this.config.loadConfigOrDefault();
        for (const [_projectPath, project] of config.projects) {
          const ws = project.workspaces.find((w) => w.id === workspaceId);
          if (!ws) continue;
          if (ws.parentWorkspaceId && ws.taskStatus === "queued") {
            taskQueueDebug("WorkspaceService.sendMessage blocked (queued task)", {
              workspaceId,
              stack: new Error("sendMessage blocked").stack,
            });
            return Err({
              type: "unknown",
              raw: "This agent task is queued and cannot start yet. Wait for a slot to free.",
            });
          }
          break;
        }
      } else {
        taskQueueDebug("WorkspaceService.sendMessage allowed (internal dequeue)", {
          workspaceId,
          stack: new Error("sendMessage internal").stack,
        });
      }

      const session = this.getOrCreateSession(workspaceId);

      // Skip recency update for idle compaction - preserve original "last used" time
      const muxMeta = options?.muxMetadata as { type?: string; source?: string } | undefined;
      const isIdleCompaction =
        muxMeta?.type === "compaction-request" && muxMeta?.source === "idle-compaction";
      // Use current time for recency - this matches the timestamp used on the message
      // in agentSession.sendMessage(). Keeps ExtensionMetadata in sync with chat.jsonl.
      const messageTimestamp = Date.now();
      if (!isIdleCompaction) {
        void this.updateRecencyTimestamp(workspaceId, messageTimestamp);
      }

      // Experiments: resolve flags respecting userOverridable setting.
      // - If userOverridable && frontend provides a value (explicit override) → use frontend value
      // - Else if remote evaluation enabled → use PostHog assignment
      // - Else → use frontend value (dev fallback) or default
      const system1Experiment = EXPERIMENTS[EXPERIMENT_IDS.SYSTEM_1];
      const system1FrontendValue = options?.experiments?.system1;

      let system1Enabled: boolean | undefined;
      if (system1Experiment.userOverridable && system1FrontendValue !== undefined) {
        // User-overridable: trust frontend value (user's explicit choice)
        system1Enabled = system1FrontendValue;
      } else if (this.experimentsService?.isRemoteEvaluationEnabled() === true) {
        // Remote evaluation: use PostHog assignment
        system1Enabled = this.experimentsService.isExperimentEnabled(EXPERIMENT_IDS.SYSTEM_1);
      } else {
        // Fallback to frontend value (dev mode or telemetry disabled)
        system1Enabled = system1FrontendValue;
      }

      const resolvedExperiments: Record<string, boolean> = {};
      if (system1Enabled !== undefined) {
        resolvedExperiments.system1 = system1Enabled;
      }

      const resolvedOptions =
        Object.keys(resolvedExperiments).length === 0
          ? options
          : {
              ...options,
              experiments: {
                ...(options.experiments ?? {}),
                ...resolvedExperiments,
              },
            };

      const normalizedOptions = this.normalizeSendMessageAgentId(resolvedOptions);

      // Persist last-used model + thinking level for cross-device consistency.
      await this.maybePersistAISettingsFromOptions(workspaceId, normalizedOptions, "send");

      const shouldQueue = !normalizedOptions?.editMessageId && session.isBusy();

      if (shouldQueue) {
        const taskStatus = this.taskService?.getAgentTaskStatus?.(workspaceId);
        if (taskStatus === "interrupted") {
          return Err({
            type: "unknown",
            raw: "Interrupted task is still winding down. Wait until it is idle, then try again.",
          });
        }

        if (internal?.requireIdle) {
          return Err({
            type: "unknown",
            raw: "Workspace is busy; idle-only send was skipped.",
          });
        }

        const pendingAskUserQuestion = askUserQuestionManager.getLatestPending(workspaceId);
        if (pendingAskUserQuestion) {
          try {
            askUserQuestionManager.cancel(
              workspaceId,
              pendingAskUserQuestion.toolCallId,
              "User responded in chat; questions canceled"
            );
          } catch (error) {
            log.debug("Failed to cancel pending ask_user_question", {
              workspaceId,
              toolCallId: pendingAskUserQuestion.toolCallId,
              error: getErrorMessage(error),
            });
          }
        }

        // Background any foreground task waits so the queued message can dispatch promptly.
        // This must happen after queueMessage succeeds — if enqueue fails (throws),
        // we must not cancel foreground waits. Use the queue's effective dispatch mode
        // (not incoming options) because MessageQueue makes tool-end sticky.
        const effectiveQueueDispatchMode = session.queueMessage(message, normalizedOptions, {
          synthetic: internal?.synthetic,
        });

        if (effectiveQueueDispatchMode === "tool-end") {
          this.taskService?.backgroundForegroundWaitsForWorkspace(workspaceId);
        }

        return Ok(undefined);
      }

      if (!internal?.skipAutoResumeReset) {
        this.taskService?.resetAutoResumeCount(workspaceId);
      }

      // Non-destructive interrupt cascades preserve descendant task workspaces with
      // taskStatus=interrupted. Transition before starting a new stream so TaskService
      // stream-end handling does not early-return on interrupted status.
      try {
        resumedInterruptedTask =
          (await this.taskService?.markInterruptedTaskRunning?.(workspaceId)) ?? false;
      } catch (error: unknown) {
        log.error("Failed to restore interrupted task status before sendMessage", {
          workspaceId,
          error,
        });
      }

      const result = await session.sendMessage(message, normalizedOptions, {
        synthetic: internal?.synthetic,
      });
      if (!result.success) {
        log.error("sendMessage handler: session returned error", {
          workspaceId,
          error: result.error,
        });

        if (resumedInterruptedTask) {
          try {
            await this.taskService?.restoreInterruptedTaskAfterResumeFailure?.(workspaceId);
          } catch (error: unknown) {
            log.error("Failed to restore interrupted task status after sendMessage failure", {
              workspaceId,
              error,
            });
          }
        }

        return result;
      }

      return result;
    } catch (error) {
      if (resumedInterruptedTask) {
        try {
          await this.taskService?.restoreInterruptedTaskAfterResumeFailure?.(workspaceId);
        } catch (restoreError: unknown) {
          log.error("Failed to restore interrupted task status after sendMessage throw", {
            workspaceId,
            error: restoreError,
          });
        }
      }

      const errorMessage = error instanceof Error ? error.message : JSON.stringify(error, null, 2);
      log.error("Unexpected error in sendMessage handler:", error);

      // Handle incompatible workspace errors from downgraded configs
      if (error instanceof IncompatibleRuntimeError) {
        const sendError: SendMessageError = {
          type: "incompatible_workspace",
          message: error.message,
        };
        return Err(sendError);
      }

      const sendError: SendMessageError = {
        type: "unknown",
        raw: `Failed to send message: ${errorMessage}`,
      };
      return Err(sendError);
    }
  }

  async resumeStream(
    workspaceId: string,
    options: SendMessageOptions,
    internal?: { allowQueuedAgentTask?: boolean }
  ): Promise<Result<{ started: boolean }, SendMessageError>> {
    let resumedInterruptedTask = false;
    try {
      // Block streaming while workspace is being renamed to prevent path conflicts
      if (this.renamingWorkspaces.has(workspaceId)) {
        log.debug("resumeStream blocked: workspace is being renamed", { workspaceId });
        return Err({
          type: "unknown",
          raw: "Workspace is being renamed. Please wait and try again.",
        });
      }

      // Block streaming while workspace is being removed to prevent races with config/session deletion.
      if (this.removingWorkspaces.has(workspaceId)) {
        log.debug("resumeStream blocked: workspace is being removed", { workspaceId });
        return Err({
          type: "unknown",
          raw: "Workspace is being deleted. Please wait and try again.",
        });
      }

      // Guard: avoid creating sessions for workspaces that don't exist anymore.
      if (!this.config.findWorkspace(workspaceId)) {
        return Err({
          type: "unknown",
          raw: "Workspace not found. It may have been deleted.",
        });
      }

      // Guard: queued agent tasks must not be resumed by generic UI/API calls.
      // TaskService is responsible for dequeuing and starting them.
      if (!internal?.allowQueuedAgentTask) {
        const config = this.config.loadConfigOrDefault();
        for (const [_projectPath, project] of config.projects) {
          const ws = project.workspaces.find((w) => w.id === workspaceId);
          if (!ws) continue;
          if (ws.parentWorkspaceId && ws.taskStatus === "queued") {
            taskQueueDebug("WorkspaceService.resumeStream blocked (queued task)", {
              workspaceId,
              stack: new Error("resumeStream blocked").stack,
            });
            return Err({
              type: "unknown",
              raw: "This agent task is queued and cannot start yet. Wait for a slot to free.",
            });
          }
          break;
        }
      } else {
        taskQueueDebug("WorkspaceService.resumeStream allowed (internal dequeue)", {
          workspaceId,
          stack: new Error("resumeStream internal").stack,
        });
      }

      const session = this.getOrCreateSession(workspaceId);

      const taskStatus = this.taskService?.getAgentTaskStatus?.(workspaceId);
      if (taskStatus === "interrupted" && session.isBusy()) {
        return Err({
          type: "unknown",
          raw: "Interrupted task is still winding down. Wait until it is idle, then try again.",
        });
      }

      const normalizedOptions = this.normalizeSendMessageAgentId(options);

      // Persist last-used model + thinking level for cross-device consistency.
      await this.maybePersistAISettingsFromOptions(workspaceId, normalizedOptions, "resume");

      // Non-destructive interrupt cascades preserve descendant task workspaces with
      // taskStatus=interrupted. Transition before stream start so TaskService stream-end
      // handling does not early-return on interrupted status.
      try {
        resumedInterruptedTask =
          (await this.taskService?.markInterruptedTaskRunning?.(workspaceId)) ?? false;
      } catch (error: unknown) {
        log.error("Failed to restore interrupted task status before resumeStream", {
          workspaceId,
          error,
        });
      }

      const result = await session.resumeStream(normalizedOptions);
      if (!result.success) {
        log.error("resumeStream handler: session returned error", {
          workspaceId,
          error: result.error,
        });
        if (resumedInterruptedTask) {
          try {
            await this.taskService?.restoreInterruptedTaskAfterResumeFailure?.(workspaceId);
          } catch (error: unknown) {
            log.error("Failed to restore interrupted task status after resumeStream failure", {
              workspaceId,
              error,
            });
          }
        }
        return result;
      }

      // resumeStream can succeed without starting a new stream when the session is
      // still busy (started=false). Keep interrupted semantics in that case.
      if (!result.data.started) {
        if (resumedInterruptedTask) {
          try {
            await this.taskService?.restoreInterruptedTaskAfterResumeFailure?.(workspaceId);
          } catch (error: unknown) {
            log.error("Failed to restore interrupted task status after no-op resumeStream", {
              workspaceId,
              error,
            });
          }
        }
        return result;
      }

      return result;
    } catch (error) {
      if (resumedInterruptedTask) {
        try {
          await this.taskService?.restoreInterruptedTaskAfterResumeFailure?.(workspaceId);
        } catch (restoreError: unknown) {
          log.error("Failed to restore interrupted task status after resumeStream throw", {
            workspaceId,
            error: restoreError,
          });
        }
      }

      const errorMessage = getErrorMessage(error);
      log.error("Unexpected error in resumeStream handler:", error);

      // Handle incompatible workspace errors from downgraded configs
      if (error instanceof IncompatibleRuntimeError) {
        const sendError: SendMessageError = {
          type: "incompatible_workspace",
          message: error.message,
        };
        return Err(sendError);
      }

      const sendError: SendMessageError = {
        type: "unknown",
        raw: `Failed to resume stream: ${errorMessage}`,
      };
      return Err(sendError);
    }
  }

  async setAutoRetryEnabled(
    workspaceId: string,
    enabled: boolean,
    persist = true
  ): Promise<Result<{ previousEnabled: boolean; enabled: boolean }>> {
    try {
      const session = this.getOrCreateSession(workspaceId);
      const state = await session.setAutoRetryEnabled(enabled, { persist });
      return Ok(state);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error("Unexpected error in setAutoRetryEnabled handler:", error);
      return Err(`Failed to set auto-retry enabled state: ${errorMessage}`);
    }
  }

  async getStartupAutoRetryModel(workspaceId: string): Promise<Result<string | null>> {
    try {
      const session = this.getOrCreateSession(workspaceId);
      const model = await session.getStartupAutoRetryModelHint();
      return Ok(model);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error("Unexpected error in getStartupAutoRetryModel handler:", error);
      return Err(`Failed to inspect startup auto-retry model: ${errorMessage}`);
    }
  }

  setAutoCompactionThreshold(workspaceId: string, threshold: number): Result<void> {
    try {
      const session = this.getOrCreateSession(workspaceId);
      session.setAutoCompactionThreshold(threshold);
      return Ok(undefined);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error("Unexpected error in setAutoCompactionThreshold handler:", error);
      return Err(`Failed to set auto-compaction threshold: ${errorMessage}`);
    }
  }

  async interruptStream(
    workspaceId: string,
    options?: { soft?: boolean; abandonPartial?: boolean; sendQueuedImmediately?: boolean }
  ): Promise<Result<void>> {
    try {
      this.taskService?.resetAutoResumeCount(workspaceId);
      if (!options?.soft) {
        // Mark before attempting the session interrupt to close races where a child
        // could report between stop initiation and descendant cascade termination.
        this.taskService?.markParentWorkspaceInterrupted(workspaceId);
      }

      const session = this.getOrCreateSession(workspaceId);
      const stopResult = await session.interruptStream(options);
      if (!stopResult.success) {
        // Interrupt failed, so clear hard-interrupt suppression we set above.
        if (!options?.soft) {
          this.taskService?.resetAutoResumeCount(workspaceId);
        }
        log.error("Failed to stop stream:", stopResult.error);
        return Err(stopResult.error);
      }

      // For hard interrupts, delete partial immediately. For soft interrupts,
      // defer to stream-abort handler (stream is still running and may recreate partial).
      if (options?.abandonPartial && !options?.soft) {
        log.debug("Abandoning partial for workspace:", workspaceId);
        await this.historyService.deletePartial(workspaceId);
      }

      // Rationale: user-initiated hard interrupts should stop the entire task tree so
      // descendant sub-agents cannot finish later and auto-resume this workspace.
      if (!options?.soft) {
        try {
          const interruptedTaskIds =
            await this.taskService?.terminateAllDescendantAgentTasks?.(workspaceId);
          if (interruptedTaskIds && interruptedTaskIds.length > 0) {
            log.debug("Cascade-interrupted descendant tasks on interrupt", {
              workspaceId,
              interruptedTaskIds,
            });
          }
        } catch (error: unknown) {
          log.error("Failed to cascade-interrupt descendant tasks on interrupt", {
            workspaceId,
            error,
          });
        }
      }

      // Handle queued messages based on option
      if (options?.sendQueuedImmediately) {
        // `sendQueuedMessages()` routes through AgentSession directly, so explicitly
        // clear hard-interrupt suppression first (it won't flow through sendMessage()).
        this.taskService?.resetAutoResumeCount(workspaceId);
        // Send queued messages immediately instead of restoring to input
        session.sendQueuedMessages();
      } else {
        // Restore queued messages to input box for user-initiated interrupts
        session.restoreQueueToInput();
      }

      return Ok(undefined);
    } catch (error) {
      if (!options?.soft) {
        // Keep suppression state consistent if interrupt setup/stop throws.
        this.taskService?.resetAutoResumeCount(workspaceId);
      }
      const errorMessage = getErrorMessage(error);
      log.error("Unexpected error in interruptStream handler:", error);
      return Err(`Failed to interrupt stream: ${errorMessage}`);
    }
  }

  async answerAskUserQuestion(
    workspaceId: string,
    toolCallId: string,
    answers: Record<string, string>
  ): Promise<Result<void>> {
    try {
      // Fast path: normal in-memory execution (stream still running, tool is awaiting input).
      askUserQuestionManager.answer(workspaceId, toolCallId, answers);
      return Ok(undefined);
    } catch (error) {
      // Fallback path: app restart (or other process death) means the in-memory
      // AskUserQuestionManager has no pending entry anymore.
      //
      // In that case we persist the tool result into partial.json or chat.jsonl,
      // then emit a synthetic tool-call-end so the renderer updates immediately.
      try {
        // Helper: update a message in-place if it contains this ask_user_question tool call.
        const tryFinalizeMessage = (
          msg: MuxMessage
        ): Result<{ updated: MuxMessage; output: AskUserQuestionToolSuccessResult }> => {
          let foundToolCall = false;
          let output: AskUserQuestionToolSuccessResult | null = null;
          let errorMessage: string | null = null;

          const updatedParts = msg.parts.map((part) => {
            if (!isDynamicToolPart(part) || part.toolCallId !== toolCallId) {
              return part;
            }

            foundToolCall = true;

            if (part.toolName !== "ask_user_question") {
              errorMessage = `toolCallId=${toolCallId} is toolName=${part.toolName}, expected ask_user_question`;
              return part;
            }

            // Already answered - treat as idempotent.
            if (part.state === "output-available") {
              const parsedOutput = AskUserQuestionToolResultSchema.safeParse(part.output);
              if (!parsedOutput.success) {
                errorMessage = `ask_user_question output validation failed: ${parsedOutput.error.message}`;
                return part;
              }
              output = parsedOutput.data;
              return part;
            }

            const parsedArgs = AskUserQuestionToolArgsSchema.safeParse(part.input);
            if (!parsedArgs.success) {
              errorMessage = `ask_user_question input validation failed: ${parsedArgs.error.message}`;
              return part;
            }

            const nextOutput: AskUserQuestionToolSuccessResult = {
              summary: buildAskUserQuestionSummary(answers),
              ui_only: {
                ask_user_question: {
                  questions: parsedArgs.data.questions,
                  answers,
                },
              },
            };
            output = nextOutput;

            return {
              ...part,
              state: "output-available" as const,
              output: nextOutput,
            };
          });

          if (errorMessage) {
            return Err(errorMessage);
          }
          if (!foundToolCall) {
            return Err("ask_user_question toolCallId not found in message");
          }
          if (!output) {
            return Err("ask_user_question output missing after update");
          }

          return Ok({ updated: { ...msg, parts: updatedParts }, output });
        };

        // 1) Prefer partial.json (most common after restart while waiting)
        const partial = await this.historyService.readPartial(workspaceId);
        if (partial) {
          const finalized = tryFinalizeMessage(partial);
          if (finalized.success) {
            const writeResult = await this.historyService.writePartial(
              workspaceId,
              finalized.data.updated
            );
            if (!writeResult.success) {
              return Err(writeResult.error);
            }

            const session = this.getOrCreateSession(workspaceId);
            session.emitChatEvent({
              type: "tool-call-end",
              workspaceId,
              messageId: finalized.data.updated.id,
              toolCallId,
              toolName: "ask_user_question",
              result: finalized.data.output,
              timestamp: Date.now(),
            });

            return Ok(undefined);
          }
        }

        // 2) Fall back to chat history (partial may have already been committed).
        // Only the current compaction epoch matters — pending tool calls don't survive compaction.
        const historyResult = await this.historyService.getHistoryFromLatestBoundary(workspaceId);
        if (!historyResult.success) {
          return Err(historyResult.error);
        }

        // Find the newest message containing this tool call.
        let best: MuxMessage | null = null;
        let bestSeq = -Infinity;
        for (const msg of historyResult.data) {
          const seq = msg.metadata?.historySequence;
          if (seq === undefined) continue;

          const hasTool = msg.parts.some(
            (p) => isDynamicToolPart(p) && p.toolCallId === toolCallId
          );
          if (hasTool && seq > bestSeq) {
            best = msg;
            bestSeq = seq;
          }
        }

        if (!best) {
          const errorMessage = getErrorMessage(error);
          return Err(`Failed to answer ask_user_question: ${errorMessage}`);
        }

        // Guard against answering stale tool calls.
        const maxSeq = Math.max(
          ...historyResult.data
            .map((m) => m.metadata?.historySequence)
            .filter((n): n is number => typeof n === "number")
        );
        if (bestSeq !== maxSeq) {
          return Err(
            `Refusing to answer ask_user_question: tool call is not the latest message (toolSeq=${bestSeq}, latestSeq=${maxSeq})`
          );
        }

        const finalized = tryFinalizeMessage(best);
        if (!finalized.success) {
          return Err(finalized.error);
        }

        const updateResult = await this.historyService.updateHistory(
          workspaceId,
          finalized.data.updated
        );
        if (!updateResult.success) {
          return Err(updateResult.error);
        }

        const session = this.getOrCreateSession(workspaceId);
        session.emitChatEvent({
          type: "tool-call-end",
          workspaceId,
          messageId: finalized.data.updated.id,
          toolCallId,
          toolName: "ask_user_question",
          result: finalized.data.output,
          timestamp: Date.now(),
        });

        return Ok(undefined);
      } catch (innerError) {
        const errorMessage = getErrorMessage(innerError);
        return Err(errorMessage);
      }
    }
  }

  answerDelegatedToolCall(workspaceId: string, toolCallId: string, result: unknown): Result<void> {
    try {
      delegatedToolCallManager.answer(workspaceId, toolCallId, result);
      return Ok(undefined);
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      return Err(`Failed to answer delegated tool call: ${errorMessage}`);
    }
  }

  clearQueue(workspaceId: string): Result<void> {
    try {
      const session = this.getOrCreateSession(workspaceId);
      session.clearQueue();
      return Ok(undefined);
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      log.error("Unexpected error in clearQueue handler:", error);
      return Err(`Failed to clear queue: ${errorMessage}`);
    }
  }

  /**
   * Best-effort delete of plan files (new + legacy paths) for a workspace.
   *
   * Why best-effort: plan files may not exist yet, or deletion may fail due to permissions.
   */
  private async deletePlanFilesForWorkspace(
    workspaceId: string,
    metadata: FrontendWorkspaceMetadata
  ): Promise<void> {
    // Create runtime to get correct muxHome (Docker uses /var/mux, others use ~/.mux)
    const runtime = createRuntimeForWorkspace(metadata);
    const muxHome = runtime.getMuxHome();
    const planPath = getPlanFilePath(metadata.name, metadata.projectName, muxHome);
    const legacyPlanPath = getLegacyPlanFilePath(workspaceId);

    const isDocker = isDockerRuntime(metadata.runtimeConfig);
    const isSSH = isSSHRuntime(metadata.runtimeConfig);

    // For Docker: paths are already absolute (/var/mux/...), just quote
    // For SSH: use $HOME expansion so the runtime shell resolves to the runtime home directory
    // For local: expand tilde locally since shellQuote prevents shell expansion
    const quotedPlanPath = isDocker
      ? shellQuote(planPath)
      : isSSH
        ? expandTildeForSSH(planPath)
        : shellQuote(expandTilde(planPath));
    // For legacy path: SSH/Docker use $HOME expansion, local expands tilde
    const quotedLegacyPlanPath =
      isDocker || isSSH
        ? expandTildeForSSH(legacyPlanPath)
        : shellQuote(expandTilde(legacyPlanPath));

    if (isDocker || isSSH) {
      try {
        // Use exec to delete files since runtime doesn't have a deleteFile method.
        // Use runtime workspace path (not host projectPath) for Docker containers.
        const workspacePath = runtime.getWorkspacePath(metadata.projectPath, metadata.name);
        const execStream = await runtime.exec(`rm -f ${quotedPlanPath} ${quotedLegacyPlanPath}`, {
          cwd: workspacePath,
          timeout: 10,
        });

        try {
          await execStream.stdin.close();
        } catch {
          // Ignore stdin-close errors (e.g. already closed).
        }

        await execStream.exitCode.catch(() => {
          // Best-effort: ignore failures.
        });
      } catch {
        // Plan files don't exist or can't be deleted - ignore
      }

      return;
    }

    // Local runtimes: delete directly on the local filesystem.
    const planPathAbs = expandTilde(planPath);
    const legacyPlanPathAbs = expandTilde(legacyPlanPath);

    await Promise.allSettled([
      fsPromises.rm(planPathAbs, { force: true }),
      fsPromises.rm(legacyPlanPathAbs, { force: true }),
    ]);
  }

  async truncateHistory(workspaceId: string, percentage?: number): Promise<Result<void>> {
    const session = this.sessions.get(workspaceId);
    if (session?.isBusy() || this.aiService.isStreaming(workspaceId)) {
      return Err(
        "Cannot truncate history while a turn is active. Press Esc to stop the stream first."
      );
    }

    const truncateResult = await this.historyService.truncateHistory(
      workspaceId,
      percentage ?? 1.0
    );
    if (!truncateResult.success) {
      return Err(truncateResult.error);
    }

    const deletedSequences = truncateResult.data;
    if (deletedSequences.length > 0) {
      const deleteMessage: DeleteMessage = {
        type: "delete",
        historySequences: deletedSequences,
      };
      // Emit through the session so ORPC subscriptions receive the event
      if (session) {
        session.emitChatEvent(deleteMessage);
      } else {
        // Fallback to direct emit (legacy path)
        this.emit("chat", { workspaceId, message: deleteMessage });
      }
    }

    // On full clear, also delete plan file and clear file change tracking
    if ((percentage ?? 1.0) === 1.0) {
      const metadata = await this.getInfo(workspaceId);
      if (metadata) {
        await this.deletePlanFilesForWorkspace(workspaceId, metadata);
      }
      this.sessions.get(workspaceId)?.clearFileState();
    }

    return Ok(undefined);
  }

  async replaceHistory(
    workspaceId: string,
    summaryMessage: MuxMessage,
    options?: {
      mode?: "destructive" | "append-compaction-boundary" | null;
      deletePlanFile?: boolean;
    }
  ): Promise<Result<void>> {
    // Support both new enum ("user"|"idle") and legacy boolean (true)
    const isCompaction = !!summaryMessage.metadata?.compacted;
    if (!isCompaction) {
      const session = this.sessions.get(workspaceId);
      if (session?.isBusy() || this.aiService.isStreaming(workspaceId)) {
        return Err(
          "Cannot replace history while a turn is active. Press Esc to stop the stream first."
        );
      }
    }

    const replaceMode = options?.mode ?? "destructive";

    try {
      let messageToAppend = summaryMessage;
      let deletedSequences: number[] = [];

      if (replaceMode === "append-compaction-boundary") {
        assert(
          summaryMessage.role === "assistant",
          "append-compaction-boundary replace mode requires an assistant summary message"
        );

        // Only need the current epoch's messages — the latest boundary marker holds
        // the max compaction epoch, and epochs are monotonically increasing with
        // append-only compaction. Falls back to full history for uncompacted workspaces.
        const historyResult = await this.historyService.getHistoryFromLatestBoundary(workspaceId);
        if (!historyResult.success) {
          return Err(
            `Failed to read history for append-compaction-boundary mode: ${historyResult.error}`
          );
        }

        const nextCompactionEpoch = getNextCompactionEpochForAppendBoundary(
          workspaceId,
          historyResult.data
        );
        assert(
          isPositiveInteger(nextCompactionEpoch),
          "append-compaction-boundary replace mode must compute a positive compaction epoch"
        );

        const compactedMarker = hasDurableCompactedMarker(summaryMessage.metadata?.compacted)
          ? summaryMessage.metadata.compacted
          : "user";

        messageToAppend = {
          ...summaryMessage,
          metadata: {
            ...(summaryMessage.metadata ?? {}),
            compacted: compactedMarker,
            compactionBoundary: true,
            compactionEpoch: nextCompactionEpoch,
          },
        };

        assert(
          hasDurableCompactedMarker(messageToAppend.metadata?.compacted),
          "append-compaction-boundary replace mode requires a durable compacted marker"
        );
        assert(
          messageToAppend.metadata?.compactionBoundary === true,
          "append-compaction-boundary replace mode must persist compactionBoundary=true"
        );
        assert(
          isPositiveInteger(messageToAppend.metadata?.compactionEpoch),
          "append-compaction-boundary replace mode must persist a positive compactionEpoch"
        );
      } else {
        assert(
          replaceMode === "destructive",
          `replaceHistory received unsupported replace mode: ${String(replaceMode)}`
        );

        const clearResult = await this.historyService.clearHistory(workspaceId);
        if (!clearResult.success) {
          return Err(`Failed to clear history: ${clearResult.error}`);
        }
        deletedSequences = clearResult.data;
      }

      const appendResult = await this.historyService.appendToHistory(workspaceId, messageToAppend);
      if (!appendResult.success) {
        return Err(`Failed to append summary message: ${appendResult.error}`);
      }

      // Emit through the session so ORPC subscriptions receive the events
      const session = this.sessions.get(workspaceId);
      if (deletedSequences.length > 0) {
        const deleteMessage: DeleteMessage = {
          type: "delete",
          historySequences: deletedSequences,
        };
        if (session) {
          session.emitChatEvent(deleteMessage);
        } else {
          this.emit("chat", { workspaceId, message: deleteMessage });
        }
      }

      // Add type: "message" for discriminated union (MuxMessage doesn't have it)
      const typedSummaryMessage = { ...messageToAppend, type: "message" as const };
      if (session) {
        session.emitChatEvent(typedSummaryMessage);
      } else {
        this.emit("chat", { workspaceId, message: typedSummaryMessage });
      }

      // Optional cleanup: delete plan file when caller explicitly requests it.
      // Note: the propose_plan UI keeps the plan file on disk; this flag is reserved for
      // explicit reset flows and backwards compatibility.
      if (options?.deletePlanFile === true) {
        const metadata = await this.getInfo(workspaceId);
        if (metadata) {
          await this.deletePlanFilesForWorkspace(workspaceId, metadata);
        }
        this.sessions.get(workspaceId)?.clearFileState();
      }

      return Ok(undefined);
    } catch (error) {
      const message = getErrorMessage(error);
      return Err(`Failed to replace history: ${message}`);
    }
  }

  async getActivityList(): Promise<Record<string, WorkspaceActivitySnapshot>> {
    try {
      const snapshots = await this.extensionMetadata.getAllSnapshots();
      return Object.fromEntries(snapshots.entries());
    } catch (error) {
      log.error("Failed to list activity:", error);
      return {};
    }
  }
  async getChatHistory(workspaceId: string): Promise<MuxMessage[]> {
    try {
      // Only return messages from the latest compaction boundary onward.
      // Pre-boundary messages are summarized in the boundary marker.
      // TODO: allow users to opt in to viewing full pre-boundary history.
      const history = await this.historyService.getHistoryFromLatestBoundary(workspaceId);
      return history.success ? history.data : [];
    } catch (error) {
      log.error("Failed to get chat history:", error);
      return [];
    }
  }

  async getHistoryLoadMore(
    workspaceId: string,
    cursor: WorkspaceHistoryLoadMoreCursor | null | undefined
  ): Promise<WorkspaceHistoryLoadMoreResult> {
    assert(
      typeof workspaceId === "string" && workspaceId.trim().length > 0,
      "workspaceId is required"
    );

    if (cursor !== null && cursor !== undefined) {
      assert(
        isNonNegativeInteger(cursor.beforeHistorySequence),
        "cursor.beforeHistorySequence must be a non-negative integer"
      );
      assert(
        cursor.beforeMessageId === null ||
          cursor.beforeMessageId === undefined ||
          typeof cursor.beforeMessageId === "string",
        "cursor.beforeMessageId must be a string, null, or undefined"
      );
      if (typeof cursor.beforeMessageId === "string") {
        assert(
          cursor.beforeMessageId.trim().length > 0,
          "cursor.beforeMessageId must be non-empty when provided"
        );
      }
    }

    const emptyResult: WorkspaceHistoryLoadMoreResult = {
      messages: [],
      nextCursor: null,
      hasOlder: false,
    };

    try {
      let beforeHistorySequence: number | undefined = cursor?.beforeHistorySequence;

      if (beforeHistorySequence === undefined) {
        // Initial load-more request (no cursor) should page one epoch older than startup replay.
        const latestBoundaryResult = await this.historyService.getHistoryFromLatestBoundary(
          workspaceId,
          0
        );
        if (!latestBoundaryResult.success) {
          log.warn("workspace.history.loadMore: failed to read latest boundary", {
            workspaceId,
            error: latestBoundaryResult.error,
          });
          return emptyResult;
        }

        const oldestFromLatestBoundary = getOldestSequencedMessage(latestBoundaryResult.data);
        if (!oldestFromLatestBoundary) {
          return emptyResult;
        }

        beforeHistorySequence = oldestFromLatestBoundary.historySequence;
      }

      assert(
        isNonNegativeInteger(beforeHistorySequence),
        "resolved beforeHistorySequence must be a non-negative integer"
      );

      const historyWindowResult = await this.historyService.getHistoryBoundaryWindow(
        workspaceId,
        beforeHistorySequence
      );
      if (!historyWindowResult.success) {
        log.warn("workspace.history.loadMore: failed to read boundary window", {
          workspaceId,
          beforeHistorySequence,
          error: historyWindowResult.error,
        });
        return emptyResult;
      }

      const messages: WorkspaceChatMessage[] = historyWindowResult.data.messages.map((message) => ({
        ...message,
        type: "message",
      }));

      if (!historyWindowResult.data.hasOlder) {
        return {
          messages,
          nextCursor: null,
          hasOlder: false,
        };
      }

      const oldestInWindow = getOldestSequencedMessage(historyWindowResult.data.messages);
      if (!oldestInWindow) {
        // Defensive fallback: if we cannot build a stable cursor, stop paging instead of looping.
        log.warn("workspace.history.loadMore: cannot compute next cursor despite hasOlder=true", {
          workspaceId,
          beforeHistorySequence,
        });
        return {
          messages,
          nextCursor: null,
          hasOlder: false,
        };
      }

      return {
        messages,
        nextCursor: {
          beforeHistorySequence: oldestInWindow.historySequence,
          beforeMessageId: oldestInWindow.message.id,
        },
        hasOlder: true,
      };
    } catch (error) {
      log.error("Failed to load more workspace history:", {
        workspaceId,
        error: getErrorMessage(error),
      });
      return emptyResult;
    }
  }

  async getFileCompletions(
    workspaceId: string,
    query: string,
    limit = 20
  ): Promise<{ paths: string[] }> {
    assert(workspaceId, "workspaceId is required");
    assert(typeof query === "string", "query must be a string");

    const resolvedLimit = Math.min(Math.max(1, Math.trunc(limit)), 50);

    const metadata = await this.getInfo(workspaceId);
    if (!metadata) {
      return { paths: [] };
    }

    const runtime = createRuntimeForWorkspace(metadata);
    const isInPlace = metadata.projectPath === metadata.name;
    const workspacePath = isInPlace
      ? metadata.projectPath
      : runtime.getWorkspacePath(metadata.projectPath, metadata.name);

    const now = Date.now();
    const CACHE_TTL_MS = 10_000;

    let cached = this.fileCompletionsCache.get(workspaceId);
    if (!cached) {
      cached = { index: EMPTY_FILE_COMPLETIONS_INDEX, fetchedAt: 0 };
      this.fileCompletionsCache.set(workspaceId, cached);
    }

    const cacheEntry = cached;

    const isStale = cacheEntry.fetchedAt === 0 || now - cacheEntry.fetchedAt > CACHE_TTL_MS;
    if (isStale && !cacheEntry.refreshing) {
      cacheEntry.refreshing = (async () => {
        const previousIndex = cacheEntry.index;

        try {
          const result = await execBuffered(runtime, "git ls-files -co --exclude-standard", {
            cwd: workspacePath,
            timeout: 5,
          });

          if (result.exitCode !== 0) {
            cacheEntry.index = previousIndex;
          } else {
            const files = result.stdout
              .split("\n")
              .map((line) => line.trim())
              // File @mentions are whitespace-delimited, so we exclude spaced paths from autocomplete.
              .filter((filePath) => Boolean(filePath) && !/\s/.test(filePath));
            cacheEntry.index = buildFileCompletionsIndex(files);
          }

          cacheEntry.fetchedAt = Date.now();
        } catch (error) {
          log.debug("getFileCompletions: failed to list files", {
            workspaceId,
            error: getErrorMessage(error),
          });

          // Keep any previously indexed data, but avoid retrying in a tight loop.
          cacheEntry.index = previousIndex;
          cacheEntry.fetchedAt = Date.now();
        }
      })().finally(() => {
        cacheEntry.refreshing = undefined;
      });
    }

    if (cacheEntry.fetchedAt === 0 && cacheEntry.refreshing) {
      await cacheEntry.refreshing;
    }

    return { paths: searchFileCompletions(cacheEntry.index, query, resolvedLimit) };
  }
  async getFullReplay(workspaceId: string): Promise<WorkspaceChatMessage[]> {
    try {
      const session = this.getOrCreateSession(workspaceId);
      const events: WorkspaceChatMessage[] = [];
      await session.replayHistory(({ message }) => {
        events.push(message);
      });
      return events;
    } catch (error) {
      log.error("Failed to get full replay:", error);
      return [];
    }
  }

  async executeBash(
    workspaceId: string,
    script: string,
    options?: {
      timeout_secs?: number;
    }
  ): Promise<Result<BashToolResult>> {
    // Block bash execution while workspace is being removed to prevent races with directory deletion.
    // A common case: subagent calls agent_report → frontend's GitStatusStore triggers a git status
    // refresh → executeBash arrives while remove() is deleting the directory → spawn fails with ENOENT.
    // removingWorkspaces is set for the entire duration of remove(), covering the window between
    // disk deletion and metadata invalidation.
    if (this.removingWorkspaces.has(workspaceId)) {
      return Err(`Workspace ${workspaceId} is being removed`);
    }

    // NOTE: This guard must run before any init/runtime operations that could wake a stopped SSH
    // runtime (e.g., Coder workspaces started via `coder ssh --wait=yes`).
    if (this.archivingWorkspaces.has(workspaceId)) {
      return Err(`Workspace ${workspaceId} is being archived; cannot execute bash`);
    }

    const metadataResult = await this.aiService.getWorkspaceMetadata(workspaceId);
    if (!metadataResult.success) {
      return Err(`Failed to get workspace metadata: ${metadataResult.error}`);
    }

    const metadata = metadataResult.data;
    if (isWorkspaceArchived(metadata.archivedAt, metadata.unarchivedAt)) {
      return Err(`Workspace ${workspaceId} is archived; cannot execute bash`);
    }

    // Wait for workspace initialization (container creation, code sync, etc.)
    // Same behavior as AI tools - 5 min timeout, then proceeds anyway
    await this.initStateManager.waitForInit(workspaceId);

    try {
      // Get actual workspace path from config
      const workspace = this.config.findWorkspace(workspaceId);
      if (!workspace) {
        return Err(`Workspace ${workspaceId} not found in config`);
      }

      // Load project secrets
      const projectSecrets = this.config.getEffectiveSecrets(metadata.projectPath);

      // Create scoped temp directory for this IPC call
      using tempDir = new DisposableTempDir("mux-ipc-bash");

      // Create runtime and compute workspace path
      const runtime = createRuntime(metadata.runtimeConfig, {
        projectPath: metadata.projectPath,
        workspaceName: metadata.name,
      });

      // Ensure runtime is ready (e.g., start Docker container if stopped)
      const readyResult = await runtime.ensureReady();
      if (!readyResult.ready) {
        return Err(readyResult.error ?? "Runtime not ready");
      }

      const workspacePath = runtime.getWorkspacePath(metadata.projectPath, metadata.name);

      // Read trust state so tool_env is sourced for trusted projects
      const projectConfig = this.config
        .loadConfigOrDefault()
        .projects.get(stripTrailingSlashes(metadata.projectPath));

      // Create bash tool
      const bashTool = createBashTool({
        cwd: workspacePath,
        runtime,
        secrets: secretsToRecord(projectSecrets),
        runtimeTempDir: tempDir.path,
        overflow_policy: "truncate",
        trusted: projectConfig?.trusted ?? false,
      });

      // Execute the script
      const result = (await bashTool.execute!(
        {
          script,
          timeout_secs: options?.timeout_secs ?? 120,
        },
        {
          toolCallId: `bash-${Date.now()}`,
          messages: [],
        }
      )) as BashToolResult;

      return Ok(result);
    } catch (error) {
      // bashTool.execute returns error results instead of throwing, so this only catches
      // failures from setup code (getWorkspaceMetadata, findWorkspace, createRuntime, etc.)
      const message = getErrorMessage(error);
      return Err(`Failed to execute bash command: ${message}`);
    }
  }

  /**
   * List background processes for a workspace.
   * Returns process info suitable for UI display (excludes handle).
   */
  async listBackgroundProcesses(workspaceId: string): Promise<
    Array<{
      id: string;
      pid: number;
      script: string;
      displayName?: string;
      startTime: number;
      status: "running" | "exited" | "killed" | "failed";
      exitCode?: number;
    }>
  > {
    const processes = await this.backgroundProcessManager.list(workspaceId);
    return processes.map((p) => ({
      id: p.id,
      pid: p.pid,
      script: p.script,
      displayName: p.displayName,
      startTime: p.startTime,
      status: p.status,
      exitCode: p.exitCode,
    }));
  }

  /**
   * Terminate a background process by ID.
   * Verifies the process belongs to the specified workspace.
   */
  async terminateBackgroundProcess(workspaceId: string, processId: string): Promise<Result<void>> {
    // Get process to verify workspace ownership
    const proc = await this.backgroundProcessManager.getProcess(processId);
    if (!proc) {
      return Err(`Process not found: ${processId}`);
    }
    if (proc.workspaceId !== workspaceId) {
      return Err(`Process ${processId} does not belong to workspace ${workspaceId}`);
    }

    const result = await this.backgroundProcessManager.terminate(processId);
    if (!result.success) {
      return Err(result.error);
    }
    return Ok(undefined);
  }

  /**
   * Peek output for a background bash process.
   *
   * This must not consume the output cursor used by bash_output/task_await.
   */
  async getBackgroundProcessOutput(
    workspaceId: string,
    processId: string,
    options?: { fromOffset?: number; tailBytes?: number }
  ): Promise<
    Result<{
      status: "running" | "exited" | "killed" | "failed";
      output: string;
      nextOffset: number;
      truncatedStart: boolean;
    }>
  > {
    const proc = await this.backgroundProcessManager.getProcess(processId);
    if (!proc) {
      return Err(`Process not found: ${processId}`);
    }
    if (proc.workspaceId !== workspaceId) {
      return Err(`Process ${processId} does not belong to workspace ${workspaceId}`);
    }

    const result = await this.backgroundProcessManager.peekOutput(processId, options);
    if (!result.success) {
      return Err(result.error);
    }

    return Ok({
      status: result.status,
      output: result.output,
      nextOffset: result.nextOffset,
      truncatedStart: result.truncatedStart,
    });
  }

  /**
   * Get the tool call IDs of foreground bash processes for a workspace.
   * Returns empty array if no foreground bashes are running.
   */
  getForegroundToolCallIds(workspaceId: string): string[] {
    return this.backgroundProcessManager.getForegroundToolCallIds(workspaceId);
  }

  /**
   * Send a foreground bash process to background by its tool call ID.
   * The process continues running but the agent stops waiting for it.
   */
  sendToBackground(toolCallId: string): Result<void> {
    const result = this.backgroundProcessManager.sendToBackground(toolCallId);
    if (!result.success) {
      return Err(result.error);
    }
    return Ok(undefined);
  }

  /**
   * Subscribe to background bash state changes.
   */
  onBackgroundBashChange(callback: (workspaceId: string) => void): void {
    this.backgroundProcessManager.on("change", callback);
  }

  /**
   * Unsubscribe from background bash state changes.
   */
  offBackgroundBashChange(callback: (workspaceId: string) => void): void {
    this.backgroundProcessManager.off("change", callback);
  }

  /**
   * Execute idle compaction for a workspace directly from the backend.
   *
   * This path is frontend-independent: compaction still runs even if no UI is open.
   * Throws on failure so IdleCompactionService can log and continue with the next workspace.
   */
  async executeIdleCompaction(workspaceId: string): Promise<void> {
    assert(workspaceId.trim().length > 0, "executeIdleCompaction requires a non-empty workspaceId");

    const sendOptions = await this.buildIdleCompactionSendOptions(workspaceId);

    const muxMetadata: MuxMessageMetadata = {
      type: "compaction-request",
      rawCommand: "/compact",
      commandPrefix: "/compact",
      parsed: {
        model: sendOptions.model,
      },
      requestedModel: sendOptions.model,
      source: "idle-compaction",
      displayStatus: { emoji: "💤", message: "Compacting idle workspace..." },
    };

    const session = this.getOrCreateSession(workspaceId);
    if (session.isBusy()) {
      throw new Error(
        "Failed to execute idle compaction: Workspace is busy; idle-only send was skipped."
      );
    }

    const sendResult = await this.sendMessage(
      workspaceId,
      buildCompactionMessageText({}),
      {
        ...sendOptions,
        muxMetadata,
      },
      {
        // Idle compaction runs in background; avoid mutating auto-resume counters.
        skipAutoResumeReset: true,
        // Backend-initiated maintenance turn: do not treat as explicit user re-engagement.
        synthetic: true,
        // If the workspace became active after eligibility checks, skip instead of queueing
        // stale maintenance work for later.
        requireIdle: true,
      }
    );

    if (!sendResult.success) {
      const rawError = sendResult.error;
      const formattedError =
        typeof rawError === "object" && rawError !== null
          ? "raw" in rawError && typeof rawError.raw === "string"
            ? rawError.raw
            : "message" in rawError && typeof rawError.message === "string"
              ? rawError.message
              : "type" in rawError && typeof rawError.type === "string"
                ? rawError.type
                : JSON.stringify(rawError)
          : String(rawError);
      throw new Error(`Failed to execute idle compaction: ${formattedError}`);
    }

    // Mark idle compaction only while a stream is actually active.
    // sendMessage can succeed on startup-abort paths where no stream is running,
    // and leaking this marker into the next user stream would suppress real notifications.
    if (session.isBusy()) {
      // Marker is added after dispatch to avoid races with concurrent user sends.
      // The streaming=true snapshot was already emitted without the flag, but the
      // streaming=false snapshot (on stream end) picks up the marker.
      this.idleCompactingWorkspaces.add(workspaceId);
      return;
    }

    // Defensive cleanup for startup-abort paths or extremely fast completions that
    // finish before executeIdleCompaction regains control.
    this.idleCompactingWorkspaces.delete(workspaceId);
  }

  private async buildIdleCompactionSendOptions(workspaceId: string): Promise<SendMessageOptions> {
    const config = this.config.loadConfigOrDefault();
    const workspaceMatch = this.config.findWorkspace(workspaceId);

    const workspaceEntry = workspaceMatch
      ? (() => {
          const project = config.projects.get(workspaceMatch.projectPath);
          return (
            project?.workspaces.find((workspace) => workspace.id === workspaceId) ??
            project?.workspaces.find((workspace) => workspace.path === workspaceMatch.workspacePath)
          );
        })()
      : undefined;

    const activity = await this.extensionMetadata.getMetadata(workspaceId);

    const compactAgentSettings = workspaceEntry?.aiSettingsByAgent?.compact;
    const execAgentSettings =
      workspaceEntry?.aiSettingsByAgent?.[WORKSPACE_DEFAULTS.agentId] ?? workspaceEntry?.aiSettings;

    // Compaction defaults now flow through per-agent defaults.
    const globalCompactDefaults = config.agentAiDefaults?.compact;
    const globalCompactDefaultModel = globalCompactDefaults?.modelString;
    const normalizedGlobalCompactDefaultModel =
      typeof globalCompactDefaultModel === "string"
        ? normalizeGatewayModel(globalCompactDefaultModel.trim())
        : undefined;
    const validGlobalCompactDefaultModel =
      normalizedGlobalCompactDefaultModel && isValidModelFormat(normalizedGlobalCompactDefaultModel)
        ? normalizedGlobalCompactDefaultModel
        : undefined;

    const globalExecDefaultModel =
      config.agentAiDefaults?.[WORKSPACE_DEFAULTS.agentId]?.modelString;
    const normalizedGlobalExecDefaultModel =
      typeof globalExecDefaultModel === "string"
        ? normalizeGatewayModel(globalExecDefaultModel.trim())
        : undefined;
    const validGlobalExecDefaultModel =
      normalizedGlobalExecDefaultModel && isValidModelFormat(normalizedGlobalExecDefaultModel)
        ? normalizedGlobalExecDefaultModel
        : undefined;

    const fallbackModel =
      compactAgentSettings?.model ??
      validGlobalCompactDefaultModel ??
      execAgentSettings?.model ??
      validGlobalExecDefaultModel ??
      activity?.lastModel ??
      WORKSPACE_DEFAULTS.model;

    let model = normalizeGatewayModel(fallbackModel);
    if (!isValidModelFormat(model)) {
      log.warn("Idle compaction resolved invalid model; falling back to workspace default", {
        workspaceId,
        model,
      });
      model = WORKSPACE_DEFAULTS.model;
    }

    const globalCompactDefaultThinking = globalCompactDefaults?.thinkingLevel;

    const requestedThinking =
      compactAgentSettings?.thinkingLevel ??
      globalCompactDefaultThinking ??
      execAgentSettings?.thinkingLevel ??
      activity?.lastThinkingLevel ??
      WORKSPACE_DEFAULTS.thinkingLevel;

    const normalizedThinkingLevel =
      coerceThinkingLevel(requestedThinking) ?? WORKSPACE_DEFAULTS.thinkingLevel;

    return {
      model,
      agentId: "compact",
      thinkingLevel: enforceThinkingPolicy(model, normalizedThinkingLevel),
      maxOutputTokens: undefined,
      // Disable all tools during compaction - regex .* matches all tool names.
      toolPolicy: [{ regex_match: ".*", action: "disable" }],
      // Compaction should not mutate persisted workspace AI defaults.
      skipAiSettingsPersistence: true,
    };
  }
}
