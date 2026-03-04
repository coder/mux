import type { SectionRuleCondition } from "@/common/schemas/project";
import type { StreamEndEvent } from "@/common/types/stream";
import assert from "@/common/utils/assert";
import { evaluateSectionRules, type WorkspaceRuleContext } from "@/common/utils/sectionRules";
import { sortSectionsByLinkedList } from "@/common/utils/sections";
import { log } from "@/node/services/log";

import type { AIService } from "./aiService";
import type { ProjectService } from "./projectService";
import type { WorkspaceService } from "./workspaceService";

const DEBOUNCE_MS = 300;

const BACKEND_AVAILABLE_FIELDS: ReadonlySet<SectionRuleCondition["field"]> = new Set([
  "agentMode",
  "streaming",
  "taskStatus",
  "hasAgentStatus",
]);

const FRONTEND_CONTEXT_FIELD_MAP: Array<{
  frontendKey: keyof FrontendProvidedContext;
  field: SectionRuleCondition["field"];
}> = [
  { frontendKey: "prState", field: "prState" },
  { frontendKey: "prMergeStatus", field: "prMergeStatus" },
  { frontendKey: "prIsDraft", field: "prIsDraft" },
  { frontendKey: "prHasFailedChecks", field: "prHasFailedChecks" },
  { frontendKey: "prHasPendingChecks", field: "prHasPendingChecks" },
  { frontendKey: "gitDirty", field: "gitDirty" },
];

function buildAvailableFields(
  frontendContext: FrontendProvidedContext | undefined
): Set<SectionRuleCondition["field"]> {
  const availableFields = new Set<SectionRuleCondition["field"]>(BACKEND_AVAILABLE_FIELDS);

  for (const { frontendKey, field } of FRONTEND_CONTEXT_FIELD_MAP) {
    if (frontendContext?.[frontendKey] !== undefined) {
      availableFields.add(field);
    }
  }

  return availableFields;
}

export interface FrontendProvidedContext {
  prState?: "OPEN" | "CLOSED" | "MERGED" | "none";
  prMergeStatus?: string;
  prIsDraft?: boolean;
  prHasFailedChecks?: boolean;
  prHasPendingChecks?: boolean;
  gitDirty?: boolean;
}

export class SectionAssignmentService {
  private pendingEvaluations = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly projectService: ProjectService,
    private readonly workspaceService: WorkspaceService,
    private readonly aiService: AIService
  ) {
    this.setupListeners();
  }

  private setupListeners(): void {
    this.aiService.on("stream-end", (event: StreamEndEvent) => {
      this.scheduleEvaluation(event.workspaceId);
    });

    this.workspaceService.on("activity", (event: { workspaceId: string }) => {
      this.scheduleEvaluation(event.workspaceId);
    });
  }

  private scheduleEvaluation(workspaceId: string): void {
    assert(
      typeof workspaceId === "string" && workspaceId.trim().length > 0,
      "workspaceId is required"
    );

    const existingTimer = this.pendingEvaluations.get(workspaceId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
      this.pendingEvaluations.delete(workspaceId);
      this.evaluateWorkspace(workspaceId).catch((error: unknown) => {
        log.error("Failed to evaluate workspace for section assignment", {
          workspaceId,
          error,
        });
      });
    }, DEBOUNCE_MS);

    this.pendingEvaluations.set(workspaceId, timer);
  }

  async evaluateWorkspace(
    workspaceId: string,
    frontendContext?: FrontendProvidedContext
  ): Promise<void> {
    assert(
      typeof workspaceId === "string" && workspaceId.trim().length > 0,
      "workspaceId is required"
    );

    const metadata = await this.workspaceService.getInfo(workspaceId);
    if (!metadata) {
      return;
    }

    // Legacy compat: workspaces with sectionId but no pinnedToSection flag
    // were manually assigned before smart sections existed — treat as pinned.
    if (
      metadata.pinnedToSection === true ||
      (metadata.sectionId != null && metadata.pinnedToSection == null)
    ) {
      return;
    }

    const projectPath = metadata.projectPath;
    const sortedSections = sortSectionsByLinkedList(this.projectService.listSections(projectPath));

    const activityByWorkspace = await this.workspaceService.getActivityList();
    const activity = activityByWorkspace[workspaceId];

    const context: WorkspaceRuleContext = {
      workspaceId,
      agentMode: metadata.agentId,
      streaming: activity?.streaming ?? false,
      prState: frontendContext?.prState,
      prMergeStatus: frontendContext?.prMergeStatus,
      prIsDraft: frontendContext?.prIsDraft,
      prHasFailedChecks: frontendContext?.prHasFailedChecks,
      prHasPendingChecks: frontendContext?.prHasPendingChecks,
      taskStatus: metadata.taskStatus,
      hasAgentStatus: activity?.agentStatus != null,
      gitDirty: frontendContext?.gitDirty,
      currentSectionId: metadata.sectionId,
      pinnedToSection: false,
      availableFields: buildAvailableFields(frontendContext),
    };

    const evaluationResult = evaluateSectionRules(sortedSections, context);

    if (evaluationResult.targetSectionId !== undefined) {
      if (evaluationResult.targetSectionId === metadata.sectionId) {
        return;
      }

      const assignResult = await this.projectService.assignWorkspaceToSection(
        projectPath,
        workspaceId,
        evaluationResult.targetSectionId,
        false
      );

      if (!assignResult.success) {
        log.warn("Failed to auto-assign workspace to section", {
          workspaceId,
          projectPath,
          error: assignResult.error,
        });
        return;
      }

      await this.workspaceService.refreshAndEmitMetadata(workspaceId);
      return;
    }

    if (evaluationResult.currentSectionInconclusive || metadata.sectionId == null) {
      // Preserve current assignment while current-section rule fields remain unknown.
      return;
    }

    // Only unassign if workspace was auto-assigned (pinnedToSection === false).
    // Not if it's legacy-manual (pinnedToSection undefined) or user-pinned (true).
    if (metadata.pinnedToSection !== false) {
      return;
    }

    const assignResult = await this.projectService.assignWorkspaceToSection(
      projectPath,
      workspaceId,
      null,
      false
    );

    if (!assignResult.success) {
      log.warn("Failed to auto-assign workspace to section", {
        workspaceId,
        projectPath,
        error: assignResult.error,
      });
      return;
    }

    await this.workspaceService.refreshAndEmitMetadata(workspaceId);
  }

  async evaluateProject(projectPath: string): Promise<void> {
    assert(
      typeof projectPath === "string" && projectPath.trim().length > 0,
      "projectPath is required"
    );

    const workspaces = await this.workspaceService.list();

    for (const workspace of workspaces) {
      if (workspace.projectPath !== projectPath) {
        continue;
      }

      try {
        await this.evaluateWorkspace(workspace.id);
      } catch (error) {
        log.error("Failed to evaluate workspace during project section assignment", {
          workspaceId: workspace.id,
          projectPath,
          error,
        });
      }
    }
  }
}
