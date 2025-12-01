import * as fs from "fs/promises";
import * as path from "path";
import writeFileAtomic from "write-file-atomic";
import type { Result } from "@/common/types/result";
import { Ok, Err } from "@/common/types/result";
import type { MuxMessage } from "@/common/types/message";
import type { Config } from "@/node/config";
import type { HistoryService } from "./historyService";
import { workspaceFileLocks } from "@/node/utils/concurrency/workspaceFileLocks";
import { normalizeLegacyMuxMetadata } from "@/node/utils/messages/legacy";

/**
 * PartialService - Manages partial message persistence for interrupted streams
 *
 * Responsibilities:
 * - Read/write/delete partial.json for all workspaces
 * - Commit partial messages to history when appropriate
 * - Encapsulate partial message lifecycle logic
 * - Synchronize file operations per workspace using MutexMap
 *
 * Separation of Concerns:
 * - PartialService owns partial.json
 * - HistoryService owns chat.jsonl
 * - StreamManager only interacts with PartialService
 * - AIService orchestrates both services
 *
 * This is a singleton service that manages partials for all workspaces.
 */
export class PartialService {
  private readonly PARTIAL_FILE = "partial.json";
  private readonly historyService: HistoryService;
  // Shared file operation lock across all workspace file services
  // This prevents deadlocks when services call each other (e.g., PartialService → HistoryService)
  private readonly fileLocks = workspaceFileLocks;
  private readonly config: Config;

  constructor(config: Config, historyService: HistoryService) {
    this.config = config;
    this.historyService = historyService;
  }

  private getPartialPath(workspaceId: string): string {
    return path.join(this.config.getSessionDir(workspaceId), this.PARTIAL_FILE);
  }

  /**
   * Read the partial message for a workspace, if it exists
   */
  async readPartial(workspaceId: string): Promise<MuxMessage | null> {
    try {
      const partialPath = this.getPartialPath(workspaceId);
      const data = await fs.readFile(partialPath, "utf-8");
      const message = JSON.parse(data) as MuxMessage;
      return normalizeLegacyMuxMetadata(message);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return null; // No partial exists
      }
      // Log other errors but don't fail
      console.error("Error reading partial:", error);
      return null;
    }
  }

  /**
   * Write a partial message to disk (with file locking per workspace)
   */
  async writePartial(workspaceId: string, message: MuxMessage): Promise<Result<void>> {
    return this.fileLocks.withLock(workspaceId, async () => {
      try {
        const workspaceDir = this.config.getSessionDir(workspaceId);
        await fs.mkdir(workspaceDir, { recursive: true });
        const partialPath = this.getPartialPath(workspaceId);

        // Ensure message has partial flag
        const partialMessage = {
          ...message,
          metadata: {
            ...message.metadata,
            partial: true,
          },
        };

        // Atomic write: writes to temp file then renames, preventing corruption
        // if app crashes mid-write (prevents "Unexpected end of JSON input" on read)
        await writeFileAtomic(partialPath, JSON.stringify(partialMessage, null, 2));
        return Ok(undefined);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return Err(`Failed to write partial: ${message}`);
      }
    });
  }

  /**
   * Delete the partial message file for a workspace (with file locking)
   */
  async deletePartial(workspaceId: string): Promise<Result<void>> {
    return this.fileLocks.withLock(workspaceId, async () => {
      try {
        const partialPath = this.getPartialPath(workspaceId);
        await fs.unlink(partialPath);
        return Ok(undefined);
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
          return Ok(undefined); // Already deleted
        }
        const message = error instanceof Error ? error.message : String(error);
        return Err(`Failed to delete partial: ${message}`);
      }
    });
  }

  /**
   * Commit any existing partial message to chat.jsonl and delete partial.json.
   * This is idempotent - if the partial has already been finalized in history,
   * it won't be committed again (preventing double-commits).
   * After committing (or if already finalized), partial.json is deleted.
   *
   * Smart commit logic:
   * - If no message with this sequence exists in history: APPEND
   * - If message exists but partial has more parts: UPDATE in place
   * - Otherwise: skip commit (already finalized)
   */
  async commitToHistory(workspaceId: string): Promise<Result<void>> {
    try {
      let partial = await this.readPartial(workspaceId);
      if (!partial) {
        return Ok(undefined); // No partial to commit
      }

      // Strip error metadata if present, but commit the accumulated parts
      // Error metadata is transient (UI-only), accumulated parts are persisted
      // This ensures resumptions don't lose progress from failed streams
      if (partial.metadata?.error) {
        const { error, errorType, ...cleanMetadata } = partial.metadata;
        partial = { ...partial, metadata: cleanMetadata };
      }

      const partialSeq = partial.metadata?.historySequence;
      if (partialSeq === undefined) {
        return Err("Partial message has no historySequence");
      }

      // Check if this partial has already been finalized in chat.jsonl
      // A partial with MORE parts than what's in history means it's newer and should be committed
      // (placeholder has empty parts, interrupted stream has accumulated parts)
      const historyResult = await this.historyService.getHistory(workspaceId);
      if (!historyResult.success) {
        return Err(`Failed to read history: ${historyResult.error}`);
      }

      const existingMessages = historyResult.data;
      const existingMessage = existingMessages.find(
        (msg) => msg.metadata?.historySequence === partialSeq
      );

      const shouldCommit =
        (!existingMessage || // No message with this sequence yet
          (partial.parts?.length ?? 0) > (existingMessage.parts?.length ?? 0)) && // Partial has more parts
        (partial.parts?.length ?? 0) > 0; // Don't commit empty messages

      if (shouldCommit) {
        if (existingMessage) {
          // Message exists (placeholder) - UPDATE it in place to avoid duplicates
          const updateResult = await this.historyService.updateHistory(workspaceId, partial);
          if (!updateResult.success) {
            return updateResult;
          }
        } else {
          // No message with this sequence - APPEND to history
          const appendResult = await this.historyService.appendToHistory(workspaceId, partial);
          if (!appendResult.success) {
            return appendResult;
          }
        }
      }

      // Delete partial.json after successful commit (or if already finalized)
      return await this.deletePartial(workspaceId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Err(`Failed to commit partial: ${message}`);
    }
  }
}
