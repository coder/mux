import type {
  PostCompactionAttachment,
  PlanFileReferenceAttachment,
  EditedFilesReferenceAttachment,
} from "@/common/types/attachment";
import { getPlanFilePath, getLegacyPlanFilePath } from "@/common/utils/planStorage";
import type { FileEditDiff } from "@/common/utils/messages/extractEditedFiles";
import type { Runtime } from "@/node/runtime/Runtime";
import { readFileString } from "@/node/utils/runtime/helpers";
import { expandTilde } from "@/node/runtime/tildeExpansion";

/**
 * Service for generating post-compaction attachments.
 * These attachments preserve context that would otherwise be lost after compaction.
 */
export class AttachmentService {
  /**
   * Generate a plan file reference attachment if the plan file exists.
   * Mode-agnostic: plan context is valuable in both plan and exec modes.
   * Falls back to legacy plan path if new path doesn't exist.
   */
  static async generatePlanFileReference(
    workspaceName: string,
    projectName: string,
    workspaceId: string,
    runtime: Runtime
  ): Promise<PlanFileReferenceAttachment | null> {
    const planFilePath = getPlanFilePath(workspaceName, projectName);
    const legacyPlanPath = getLegacyPlanFilePath(workspaceId);

    // Try new path first
    try {
      const planContent = await readFileString(runtime, planFilePath);
      if (planContent) {
        return {
          type: "plan_file_reference",
          planFilePath,
          planContent,
        };
      }
    } catch {
      // Plan file doesn't exist at new path, try legacy
    }

    // Fall back to legacy path
    try {
      const planContent = await readFileString(runtime, legacyPlanPath);
      if (planContent) {
        return {
          type: "plan_file_reference",
          planFilePath: legacyPlanPath,
          planContent,
        };
      }
    } catch {
      // Plan file doesn't exist at legacy path either
    }

    return null;
  }

  /**
   * Generate an edited files reference attachment from extracted file diffs.
   * Excludes the plan file (which is handled separately).
   * @param planPathsToFilter - Array of plan file paths to filter (both tilde and expanded)
   */
  static generateEditedFilesAttachment(
    fileDiffs: FileEditDiff[],
    planPathsToFilter: string[] = []
  ): EditedFilesReferenceAttachment | null {
    // Build set of paths to filter (includes both tilde and expanded versions)
    const pathsToFilter = new Set<string>();
    for (const p of planPathsToFilter) {
      pathsToFilter.add(p);
      pathsToFilter.add(expandTilde(p));
    }

    const files = fileDiffs
      .filter((f) => !pathsToFilter.has(f.path))
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
    workspaceName: string,
    projectName: string,
    workspaceId: string,
    fileDiffs: FileEditDiff[],
    runtime: Runtime,
    excludedItems: Set<string> = new Set<string>()
  ): Promise<PostCompactionAttachment[]> {
    const attachments: PostCompactionAttachment[] = [];
    const planFilePath = getPlanFilePath(workspaceName, projectName);
    const legacyPlanPath = getLegacyPlanFilePath(workspaceId);

    // Plan file reference (skip if excluded)
    let planRef: PlanFileReferenceAttachment | null = null;
    if (!excludedItems.has("plan")) {
      planRef = await this.generatePlanFileReference(
        workspaceName,
        projectName,
        workspaceId,
        runtime
      );
      if (planRef) {
        attachments.push(planRef);
      }
    }

    // Filter out excluded files
    const filteredDiffs = fileDiffs.filter((f) => !excludedItems.has(`file:${f.path}`));

    // Edited files reference - always filter out both new and legacy plan paths
    // to prevent plan file from appearing in the file diffs list
    const editedFilesRef = this.generateEditedFilesAttachment(filteredDiffs, [
      planFilePath,
      legacyPlanPath,
    ]);
    if (editedFilesRef) {
      attachments.push(editedFilesRef);
    }

    return attachments;
  }
}
