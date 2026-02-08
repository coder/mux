import * as path from "path";
import * as fsPromises from "fs/promises";
import { log } from "@/node/services/log";
import { getErrorMessage } from "@/common/utils/errors";
import { coerceThinkingLevel, type ThinkingLevel } from "@/common/types/thinking";
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

function isErrnoWithCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}

function isPathInsideDir(dirPath: string, filePath: string): boolean {
  const resolvedDir = path.resolve(dirPath);
  const resolvedFile = path.resolve(filePath);
  const relative = path.relative(resolvedDir, resolvedFile);

  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
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

export async function archiveChildSessionArtifactsIntoParentSessionDir(params: {
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
