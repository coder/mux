/**
 * Post-compaction attachment types.
 * These attachments are injected after compaction to preserve context that would otherwise be lost.
 */

import type { AgentSkillScope } from "@/common/types/agentSkill";

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

export interface LoadedSkillSnapshot {
  name: string;
  scope: AgentSkillScope;
  sha256: string;
  body: string;
  frontmatterYaml?: string;
  truncated?: boolean;
}

export interface LoadedSkillsSnapshotAttachment {
  type: "loaded_skills_snapshot";
  skills: LoadedSkillSnapshot[];
}

export type PostCompactionAttachment =
  | PlanFileReferenceAttachment
  | TodoListAttachment
  | LoadedSkillsSnapshotAttachment
  | EditedFilesReferenceAttachment;

/**
 * Exclusion state for post-compaction context items.
 * Items are identified by:
 * - "plan" for the plan file
 * - "todo" for the todo list
 * - "skills" for loaded skill snapshots
 * - "file:<path>" for tracked files (path is the full file path)
 */
export interface PostCompactionExclusions {
  excludedItems: string[];
}
