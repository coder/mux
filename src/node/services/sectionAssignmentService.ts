import type { SectionRuleCondition } from "@/common/schemas/project";
import type { StreamEndEvent } from "@/common/types/stream";
import type { WorkspaceActivitySnapshot, WorkspaceMetadata } from "@/common/types/workspace";
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

  // PR merge status is evaluated relative to whether a PR exists at all. When PR state is
  // known but merge status is missing (for example prState === "none"), keep the field
  // available so comparisons evaluate as a known "no value" instead of becoming inconclusive.
  if (frontendContext?.prState !== undefined) {
    availableFields.add("prMergeStatus");
  }

  return availableFields;
}

/** Strip undefined values from an object so spread-merge doesn't overwrite cached data. */
function stripUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const result: Partial<T> = {};
  for (const key of Object.keys(obj) as Array<keyof T>) {
    if (obj[key] !== undefined) {
      result[key] = obj[key];
    }
  }
  return result;
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

  private lastKnownFrontendContext = new Map<string, FrontendProvidedContext>();

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

    this.workspaceService.on("metadata", (event) => {
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
    frontendContext?: FrontendProvidedContext,
    existingMetadata?: WorkspaceMetadata,
    activityMap?: Record<string, WorkspaceActivitySnapshot>
  ): Promise<void> {
    assert(
      typeof workspaceId === "string" && workspaceId.trim().length > 0,
      "workspaceId is required"
    );

    const metadata = existingMetadata ?? (await this.workspaceService.getInfo(workspaceId));
    if (!metadata) {
      return;
    }

    // Merge incoming frontend context with last-known state so that
    // rules combining PR and git fields can be fully evaluated even
    // though the stores send updates independently.
    let mergedContext: FrontendProvidedContext | undefined;
    if (frontendContext) {
      const previous = this.lastKnownFrontendContext.get(workspaceId) ?? {};
      mergedContext = { ...previous, ...stripUndefined({ ...frontendContext }) };

      // When the PR no longer exists, explicitly clear merge status so stale values from
      // earlier PR states do not affect merge-status rules.
      if (mergedContext.prState === "none") {
        mergedContext.prMergeStatus = undefined;
      }

      this.lastKnownFrontendContext.set(workspaceId, mergedContext);
    } else {
      // Backend-triggered evaluation (stream-end, activity) — use last-known
      mergedContext = this.lastKnownFrontendContext.get(workspaceId);
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

    const activityByWorkspace = activityMap ?? (await this.workspaceService.getActivityList());
    const activity = activityByWorkspace[workspaceId];

    const context: WorkspaceRuleContext = {
      workspaceId,
      agentMode: metadata.agentId ?? metadata.agentType,
      streaming: activity?.streaming ?? false,
      prState: mergedContext?.prState,
      prMergeStatus: mergedContext?.prMergeStatus,
      prIsDraft: mergedContext?.prIsDraft,
      prHasFailedChecks: mergedContext?.prHasFailedChecks,
      prHasPendingChecks: mergedContext?.prHasPendingChecks,
      taskStatus: metadata.taskStatus,
      hasAgentStatus: activity?.agentStatus != null,
      gitDirty: mergedContext?.gitDirty,
      currentSectionId: metadata.sectionId,
      pinnedToSection: false,
      availableFields: buildAvailableFields(mergedContext),
    };

    const evaluationResult = evaluateSectionRules(sortedSections, context);

    if (evaluationResult.targetSectionId !== undefined) {
      // If the current section couldn't be conclusively evaluated with this context
      // (for example backend-only evaluation without PR/git fields), preserve the
      // current assignment instead of churning to a different matching section.
      if (evaluationResult.currentSectionInconclusive) {
        return;
      }

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
    const activityMap = await this.workspaceService.getActivityList();

    for (const workspace of workspaces) {
      if (workspace.projectPath !== projectPath) {
        continue;
      }

      try {
        await this.evaluateWorkspace(workspace.id, undefined, workspace, activityMap);
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
