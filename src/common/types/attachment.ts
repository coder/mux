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

export interface EditedFilesReferenceAttachment {
  type: "edited_files_reference";
  files: EditedFileReference[];
}

export type PostCompactionAttachment = PlanFileReferenceAttachment | EditedFilesReferenceAttachment;
