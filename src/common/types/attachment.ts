/**
 * Post-compaction attachment types.
 * These attachments are injected after compaction to preserve context that would otherwise be lost.
 */

export interface PlanFileReferenceAttachment {
  type: "plan_file_reference";
  planFilePath: string;
  planContent: string;
}

export interface EditedFileReference {
  path: string;
  diff: string;
  truncated: boolean;
}

export interface TodoListAttachment {
  type: "todo_list";
  todos: Array<{
    content: string;
    status: "pending" | "in_progress" | "completed";
  }>;
}

export interface EditedFilesReferenceAttachment {
  type: "edited_files_reference";
  files: EditedFileReference[];
}

export type PostCompactionAttachment =
  | PlanFileReferenceAttachment
  | TodoListAttachment
  | EditedFilesReferenceAttachment;

/**
 * Exclusion state for post-compaction context items.
 * Items are identified by:
 * - "plan" for the plan file
 * - "todo" for the todo list
 * - "file:<path>" for tracked files (path is the full file path)
 */
export interface PostCompactionExclusions {
  excludedItems: string[];
}
