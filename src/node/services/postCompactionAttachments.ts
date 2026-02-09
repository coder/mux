/**
 * PostCompactionAttachmentBuilder — assembles post-compaction context
 * (plan references, TODO lists, edited-file diffs) that gets injected
 * into the prompt after a compaction event.
 *
 * Extracted from AgentSession to keep that class focused on stream
 * orchestration. Owns the turn-counter and compaction-occurred state
 * that controls injection cadence.
 */
import * as path from "path";
import { readFile } from "fs/promises";
import type { PostCompactionAttachment, PostCompactionExclusions } from "@/common/types/attachment";
import { TURNS_BETWEEN_ATTACHMENTS } from "@/common/constants/attachments";
import type { TodoItem } from "@/common/types/tools";
import { AttachmentService } from "@/node/services/attachmentService";
import {
  extractEditedFileDiffs,
  type FileEditDiff,
} from "@/common/utils/messages/extractEditedFiles";
import { createRuntimeForWorkspace } from "@/node/runtime/runtimeHelpers";
import type { Config } from "@/node/config";
import type { AIService } from "@/node/services/aiService";
import type { HistoryService } from "@/node/services/historyService";
import type { CompactionHandler } from "@/node/services/compactionHandler";
import type { FileChangeTracker } from "@/node/services/utils/fileChangeTracker";

export class PostCompactionAttachmentBuilder {
  /**
   * Flag indicating the stream-end handler should acknowledge that pending
   * post-compaction diffs were consumed. Set inside `getAttachmentsIfNeeded`
   * when diffs are present; read and cleared by AgentSession's stream
   * lifecycle handlers.
   */
  ackPendingOnStreamEnd = false;

  private turnsSinceLastAttachment = TURNS_BETWEEN_ATTACHMENTS;
  private compactionOccurred = false;

  constructor(
    private readonly workspaceId: string,
    private readonly config: Config,
    private readonly aiService: AIService,
    private readonly historyService: HistoryService,
    private readonly compactionHandler: CompactionHandler,
    private readonly fileChangeTracker: FileChangeTracker
  ) {}

  /**
   * Get post-compaction attachments if they should be injected this turn.
   *
   * Logic:
   * - On first turn after compaction: inject immediately, clear file state cache
   * - Subsequent turns: inject every TURNS_BETWEEN_ATTACHMENTS turns
   *
   * @returns Attachments to inject, or null if none needed
   */
  async getAttachmentsIfNeeded(): Promise<PostCompactionAttachment[] | null> {
    // Check if compaction just occurred (immediate injection with cached diffs)
    const pendingDiffs = await this.compactionHandler.peekPendingDiffs();
    if (pendingDiffs !== null) {
      this.ackPendingOnStreamEnd = true;
      this.compactionOccurred = true;
      this.turnsSinceLastAttachment = 0;
      // Clear file state cache since history context is gone
      this.fileChangeTracker.clear();

      return this.buildAttachments(pendingDiffs);
    }

    // Increment turn counter
    this.turnsSinceLastAttachment++;

    // Check cooldown for subsequent injections (re-read from current history)
    if (this.compactionOccurred && this.turnsSinceLastAttachment >= TURNS_BETWEEN_ATTACHMENTS) {
      this.turnsSinceLastAttachment = 0;
      return this.generateFromHistory();
    }

    return null;
  }

  /**
   * Generate post-compaction attachments by extracting diffs from message history.
   */
  private async generateFromHistory(): Promise<PostCompactionAttachment[]> {
    const historyResult = await this.historyService.getHistory(this.workspaceId);
    if (!historyResult.success) {
      return [];
    }
    const fileDiffs = extractEditedFileDiffs(historyResult.data);

    return this.buildAttachments(fileDiffs);
  }

  /**
   * Shared assembly: load exclusions + TODO, then build the full attachment list
   * (plan reference, TODO, edited-files diff).
   */
  private async buildAttachments(fileDiffs: FileEditDiff[]): Promise<PostCompactionAttachment[]> {
    const excludedItems = await this.loadExcludedItems();
    const todoAttachment = await this.loadTodoListAttachment(excludedItems);

    // Get runtime for reading plan file
    const metadataResult = await this.aiService.getWorkspaceMetadata(this.workspaceId);
    if (!metadataResult.success) {
      // Can't get metadata, skip plan reference but still include other attachments
      const attachments: PostCompactionAttachment[] = [];

      if (todoAttachment) {
        attachments.push(todoAttachment);
      }

      const editedFilesRef = AttachmentService.generateEditedFilesAttachment(fileDiffs);
      if (editedFilesRef) {
        attachments.push(editedFilesRef);
      }

      return attachments;
    }
    const runtime = createRuntimeForWorkspace(metadataResult.data);

    const attachments = await AttachmentService.generatePostCompactionAttachments(
      metadataResult.data.name,
      metadataResult.data.projectName,
      this.workspaceId,
      fileDiffs,
      runtime,
      excludedItems
    );

    if (todoAttachment) {
      // Insert TODO after plan (if present), otherwise first.
      const planIndex = attachments.findIndex((att) => att.type === "plan_file_reference");
      const insertIndex = planIndex === -1 ? 0 : planIndex + 1;
      attachments.splice(insertIndex, 0, todoAttachment);
    }

    return attachments;
  }

  /**
   * Load excluded items from the exclusions file.
   * Returns empty set if file doesn't exist or can't be read.
   */
  private async loadExcludedItems(): Promise<Set<string>> {
    const exclusionsPath = path.join(
      this.config.getSessionDir(this.workspaceId),
      "exclusions.json"
    );
    try {
      const data = await readFile(exclusionsPath, "utf-8");
      const exclusions = JSON.parse(data) as PostCompactionExclusions;
      return new Set(exclusions.excludedItems);
    } catch {
      return new Set();
    }
  }

  private async loadTodoListAttachment(
    excludedItems: Set<string>
  ): Promise<PostCompactionAttachment | null> {
    if (excludedItems.has("todo")) {
      return null;
    }

    const todoPath = path.join(this.config.getSessionDir(this.workspaceId), "todos.json");

    try {
      const data = await readFile(todoPath, "utf-8");
      const parsed: unknown = JSON.parse(data);
      const todos = coerceTodoItems(parsed);
      if (todos.length === 0) {
        return null;
      }

      return {
        type: "todo_list",
        todos,
      };
    } catch {
      // File missing or unreadable
      return null;
    }
  }
}

/** Safely coerce unknown JSON into a TodoItem array. */
export function coerceTodoItems(value: unknown): TodoItem[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const result: TodoItem[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;

    const content = (item as { content?: unknown }).content;
    const status = (item as { status?: unknown }).status;

    if (typeof content !== "string") continue;
    if (status !== "pending" && status !== "in_progress" && status !== "completed") continue;

    result.push({ content, status });
  }

  return result;
}
