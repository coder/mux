import { stat, readFile } from "fs/promises";
import { computeDiff } from "@/node/utils/diff";

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
 * Tracks file content state and detects external modifications.
 *
 * Used to inject diffs of externally-edited files as context attachments
 * before each LLM query.
 */
export class FileChangeTracker {
  private readonly fileState = new Map<string, FileState>();

  /** Record a file's current content and mtime. */
  record(filePath: string, state: FileState): void {
    this.fileState.set(filePath, state);
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
    const checks = Array.from(this.fileState.entries()).map(
      async ([filePath, state]): Promise<EditedFileAttachment | null> => {
        try {
          const currentMtime = (await stat(filePath)).mtimeMs;
          if (currentMtime <= state.timestamp) return null; // No change

          const currentContent = await readFile(filePath, "utf-8");
          const diff = computeDiff(state.content, currentContent);
          if (!diff) return null; // Content identical despite mtime change

          // Update stored state
          this.fileState.set(filePath, { content: currentContent, timestamp: currentMtime });

          return {
            type: "edited_text_file",
            filename: filePath,
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
