import assert from "@/common/utils/assert";
import type { SectionRuleCondition } from "@/common/schemas/project";
import type { StreamEndEvent } from "@/common/types/stream";
import type { SectionConfig } from "@/common/types/project";
import { evaluateSectionRules, type WorkspaceRuleContext } from "@/common/utils/sectionRules";
import { sortSectionsByLinkedList } from "@/common/utils/sections";
import { log } from "@/node/services/log";
import type { AIService } from "./aiService";
import type { ProjectService } from "./projectService";
import type { WorkspaceService } from "./workspaceService";

const DEBOUNCE_MS = 300;

const FRONTEND_ONLY_FIELDS = new Set<SectionRuleCondition["field"]>([
  "prState",
  "prMergeStatus",
  "prIsDraft",
  "prHasFailedChecks",
  "prHasPendingChecks",
  "gitDirty",
]);

function sectionHasFrontendOnlyRules(section: SectionConfig): boolean {
  return (
    section.rules?.some((rule) =>
      rule.conditions.some((condition) => FRONTEND_ONLY_FIELDS.has(condition.field))
    ) ?? false
  );
}

function hasFrontendOnlyContext(frontendContext: FrontendProvidedContext | undefined): boolean {
  return (
    frontendContext?.prState !== undefined ||
    frontendContext?.prMergeStatus !== undefined ||
    frontendContext?.prIsDraft !== undefined ||
    frontendContext?.prHasFailedChecks !== undefined ||
    frontendContext?.prHasPendingChecks !== undefined ||
    frontendContext?.gitDirty !== undefined
  );
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

    if (metadata.pinnedToSection === true) {
      return;
    }

    const projectPath = metadata.projectPath;
    const sortedSections = sortSectionsByLinkedList(this.projectService.listSections(projectPath));
    const frontendContextAvailable = hasFrontendOnlyContext(frontendContext);

    if (!frontendContextAvailable && metadata.sectionId) {
      const currentSection = sortedSections.find((section) => section.id === metadata.sectionId);
      if (currentSection && sectionHasFrontendOnlyRules(currentSection)) {
        // Preserve assignment when backend-triggered reevaluation lacks frontend-only PR/git context.
        return;
      }
    }

    const sectionsToEvaluate = frontendContextAvailable
      ? sortedSections
      : sortedSections.filter((section) => !sectionHasFrontendOnlyRules(section));

    const hasRules = sectionsToEvaluate.some((section) => (section.rules?.length ?? 0) > 0);
    if (!hasRules) {
      return;
    }

    const activityByWorkspace = await this.workspaceService.getActivityList();
    const activity = activityByWorkspace[workspaceId];

    const context: WorkspaceRuleContext = {
      workspaceId,
      agentMode: metadata.agentId,
      streaming: activity?.streaming ?? false,
      prState: frontendContext?.prState ?? "none",
      prMergeStatus: frontendContext?.prMergeStatus,
      prIsDraft: frontendContext?.prIsDraft,
      prHasFailedChecks: frontendContext?.prHasFailedChecks,
      prHasPendingChecks: frontendContext?.prHasPendingChecks,
      taskStatus: metadata.taskStatus,
      hasAgentStatus: activity?.agentStatus != null,
      gitDirty: frontendContext?.gitDirty,
      currentSectionId: metadata.sectionId,
      pinnedToSection: false,
    };

    const nextSectionId = evaluateSectionRules(sectionsToEvaluate, context);
    if (nextSectionId === metadata.sectionId) {
      return;
    }

    const assignResult = await this.projectService.assignWorkspaceToSection(
      projectPath,
      workspaceId,
      nextSectionId ?? null,
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
