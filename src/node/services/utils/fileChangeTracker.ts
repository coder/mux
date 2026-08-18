import { stat, readFile, realpath } from "fs/promises";
import assert from "@/common/utils/assert";
import { computeDiff } from "@/node/utils/diff";
import { createMuxMessage, type MuxMessage } from "@/common/types/message";
import { createFileChangeNotificationMessageId } from "@/node/services/utils/messageIds";

/**
 * Represents a file's content and modification timestamp.
 */
export interface FileState {
  content: string;
  timestamp: number; // mtime in ms
}

/**
 * Attachment for files that were edited externally between messages.
 */
export interface EditedFileAttachment {
  type: "edited_text_file";
  filename: string;
  snippet: string; // diff of changes
}

/**
 * Build the durable <system-file-update> notification for externally edited files.
 *
 * Appended to chat.jsonl at turn start — BEFORE the request is built from
 * history — so the provider request stays a pure function of the session log
 * (anything model-visible must exist as a durable history row first). There is
 * intentionally no request-time injection path for these notifications.
 */
export function createFileChangeNotificationMessage(
  changedFileAttachments: EditedFileAttachment[]
): MuxMessage {
  assert(changedFileAttachments.length > 0, "file change notification requires attachments");

  const notice = changedFileAttachments
    .map(
      (att) =>
        `Note: ${att.filename} was modified, either by the user or by a linter.\n` +
        `This change was intentional, so make sure to take it into account as you proceed ` +
        `(i.e., don't revert it unless the user asks you to). Here are the relevant changes:\n${att.snippet}`
    )
    .join("\n\n");

  return createMuxMessage(
    createFileChangeNotificationMessageId(),
    "user",
    `<system-file-update>\n${notice}\n</system-file-update>`,
    {
      timestamp: Date.now(),
      synthetic: true,
    }
  );
}

/**
 * Tracks file content state and detects external modifications.
 *
 * Used to append diffs of externally-edited files as durable history rows
 * before each LLM query.
 */
export class FileChangeTracker {
  private readonly fileState = new Map<string, FileState>();

  private async canonicalize(filePath: string): Promise<string> {
    try {
      return await realpath(filePath);
    } catch {
      return filePath;
    }
  }

  /** Normalize tracked paths to canonical real paths and deduplicate symlink aliases. */
  private async normalizeTrackedPaths(): Promise<void> {
    const canonicalState = new Map<string, FileState>();

    for (const [filePath, state] of this.fileState.entries()) {
      const canonicalPath = await this.canonicalize(filePath);
      const existingState = canonicalState.get(canonicalPath);
      if (existingState == null || state.timestamp > existingState.timestamp) {
        canonicalState.set(canonicalPath, state);
      }
    }

    this.fileState.clear();
    for (const [canonicalPath, state] of canonicalState.entries()) {
      this.fileState.set(canonicalPath, state);
    }
  }

  /** Record a file's current content and mtime. */
  async record(filePath: string, state: FileState): Promise<void> {
    const canonicalPath = await this.canonicalize(filePath);
    this.fileState.set(canonicalPath, state);
  }

  /** Get count of tracked files. */
  get count(): number {
    return this.fileState.size;
  }

  /** Get paths of all tracked files. */
  get paths(): string[] {
    return Array.from(this.fileState.keys());
  }

  /** Clear all tracked state (e.g., on /clear). */
  clear(): void {
    this.fileState.clear();
  }

  /**
   * Check all tracked files for external modifications.
   * Updates internal state for changed files and returns diff attachments.
   */
  async getChangedAttachments(): Promise<EditedFileAttachment[]> {
    await this.normalizeTrackedPaths();

    const checks = Array.from(this.fileState.entries()).map(
      async ([filePath, state]): Promise<EditedFileAttachment | null> => {
        try {
          const canonicalPath = await this.canonicalize(filePath);
          const trackedState = this.fileState.get(canonicalPath) ?? state;
          const currentMtime = (await stat(canonicalPath)).mtimeMs;
          if (currentMtime <= trackedState.timestamp) return null; // No change

          const currentContent = await readFile(canonicalPath, "utf-8");
          const diff = computeDiff(trackedState.content, currentContent);
          if (!diff) return null; // Content identical despite mtime change

          // Update stored state
          this.fileState.set(canonicalPath, { content: currentContent, timestamp: currentMtime });

          return {
            type: "edited_text_file",
            filename: canonicalPath,
            snippet: diff,
          };
        } catch {
          // File deleted or inaccessible, skip
          return null;
        }
      }
    );

    const results = await Promise.all(checks);
    return results.filter((r): r is EditedFileAttachment => r !== null);
  }
}
