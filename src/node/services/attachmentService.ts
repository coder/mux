import type {
  PostCompactionAttachment,
  PlanFileReferenceAttachment,
  EditedFilesReferenceAttachment,
} from "@/common/types/attachment";
import { getPlanFilePath } from "@/common/utils/planStorage";
import type { FileEditDiff } from "@/common/utils/messages/extractEditedFiles";
import type { Runtime } from "@/node/runtime/Runtime";
import { readFileString } from "@/node/utils/runtime/helpers";

/**
 * Service for generating post-compaction attachments.
 * These attachments preserve context that would otherwise be lost after compaction.
 */
export class AttachmentService {
  /**
   * Generate a plan file reference attachment if the plan file exists.
   * Mode-agnostic: plan context is valuable in both plan and exec modes.
   */
  static async generatePlanFileReference(
    workspaceId: string,
    runtime: Runtime
  ): Promise<PlanFileReferenceAttachment | null> {
    const planFilePath = getPlanFilePath(workspaceId);

    try {
      const planContent = await readFileString(runtime, planFilePath);
      if (!planContent) {
        return null;
      }

      return {
        type: "plan_file_reference",
        planFilePath,
        planContent,
      };
    } catch {
      // Plan file doesn't exist or can't be read
      return null;
    }
  }

  /**
   * Generate an edited files reference attachment from extracted file diffs.
   * Excludes the plan file (which is handled separately).
   */
  static generateEditedFilesAttachment(
    fileDiffs: FileEditDiff[],
    planFilePath?: string
  ): EditedFilesReferenceAttachment | null {
    // Filter out plan file
    const files = fileDiffs
      .filter((f) => !planFilePath || f.path !== planFilePath)
      .map((f) => ({
        path: f.path,
        diff: f.diff,
        truncated: f.truncated,
      }));

    if (files.length === 0) {
      return null;
    }

    return {
      type: "edited_files_reference",
      files,
    };
  }

  /**
   * Generate all post-compaction attachments.
   * Returns empty array if no attachments are needed.
   * @param excludedItems - Set of item IDs to exclude ("plan" or "file:<path>")
   */
  static async generatePostCompactionAttachments(
    workspaceId: string,
    fileDiffs: FileEditDiff[],
    runtime: Runtime,
    excludedItems: Set<string> = new Set<string>()
  ): Promise<PostCompactionAttachment[]> {
    const attachments: PostCompactionAttachment[] = [];
    const planFilePath = getPlanFilePath(workspaceId);

    // Plan file reference (skip if excluded)
    let planRef: PlanFileReferenceAttachment | null = null;
    if (!excludedItems.has("plan")) {
      planRef = await this.generatePlanFileReference(workspaceId, runtime);
      if (planRef) {
        attachments.push(planRef);
      }
    }

    // Filter out excluded files
    const filteredDiffs = fileDiffs.filter((f) => !excludedItems.has(`file:${f.path}`));

    // Edited files reference (only exclude plan diffs if plan reference was included)
    const editedFilesRef = this.generateEditedFilesAttachment(
      filteredDiffs,
      planRef ? planFilePath : undefined
    );
    if (editedFilesRef) {
      attachments.push(editedFilesRef);
    }

    return attachments;
  }
}
