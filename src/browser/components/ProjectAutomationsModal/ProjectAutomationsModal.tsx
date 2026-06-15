import React, { useEffect, useRef, useState } from "react";
import { CalendarClock, Loader2, Play, Plus, Trash } from "lucide-react";
import { Button } from "@/browser/components/Button/Button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/browser/components/Dialog/Dialog";
import { Input } from "@/browser/components/Input/Input";
import { Switch } from "@/browser/components/Switch/Switch";
import { useAPI } from "@/browser/contexts/API";
import { useProjectContext } from "@/browser/contexts/ProjectContext";
import type { ProjectConfig, ProjectWorkflowSchedule, Workspace } from "@/common/types/project";
import type { WorkflowDefinitionDescriptor } from "@/common/types/workflow";
import assert from "@/common/utils/assert";
import { getErrorMessage } from "@/common/utils/errors";
import { isWorkspaceArchived } from "@/common/utils/archive";
import { validateWorkspaceName } from "@/common/utils/validation/workspaceValidation";
import { getSupportedWorkflowScheduleNewWorkspaceTemplate } from "@/common/utils/workflowScheduleTarget";
import {
  WORKFLOW_SCHEDULE_DEFAULT_CONTEXT_MODE,
  WORKFLOW_SCHEDULE_DEFAULT_INTERVAL_MS,
  type WorkflowScheduleContextMode,
} from "@/constants/workflowSchedule";
import {
  formatWorkflowArgs,
  formatWorkflowScheduleIntervalMinutes,
  getWorkflowScheduleIntervalValidationError,
  parseWorkflowArgs,
  parseWorkflowScheduleIntervalMinutes,
  WORKFLOW_SCHEDULE_DEFAULT_INTERVAL_MINUTES,
  WORKFLOW_SCHEDULE_MAX_INTERVAL_MINUTES,
  WORKFLOW_SCHEDULE_MIN_INTERVAL_MINUTES,
  workflowScheduleIntervalMinutesToMs,
} from "@/browser/utils/workflowScheduleIntervalMinutes";

interface ProjectAutomationsModalProps {
  open: boolean;
  projectPath: string;
  projectName: string;
  projectConfig: ProjectConfig;
  onOpenChange: (open: boolean) => void;
}

type ProjectAutomationTargetType = "new-workspace" | "existing-workspace";

function getTargetBranchValidationError(value: string): string | null {
  const trimmedValue = value.trim();
  if (trimmedValue.length === 0) {
    return null;
  }

  const validation = validateWorkspaceName(trimmedValue);
  return validation.valid ? null : (validation.error ?? "Invalid workspace name");
}

function formatLastRunStartedAt(value: string | undefined): string {
  if (!value) {
    return "Never";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "Unknown";
  }

  return date.toLocaleString();
}

function getWorkspaceLabel(workspace: Workspace | undefined): string {
  const title = workspace?.title?.trim();
  if (title) return title;
  const name = workspace?.name?.trim();
  if (name) return name;
  return workspace?.id ?? "Unknown workspace";
}

function getScheduleLabel(schedule: ProjectWorkflowSchedule): string {
  const title = schedule.title?.trim();
  if (title) return title;
  return schedule.workflowName;
}

function getProjectAutomationRowKey(schedule: ProjectWorkflowSchedule): string {
  return `project:${schedule.id}`;
}

function getProjectScheduleId(schedule: ProjectWorkflowSchedule | null): string | null {
  const scheduleId = schedule?.id?.trim();
  return scheduleId != null && scheduleId.length > 0 ? scheduleId : null;
}

function getExistingWorkspaceAutomationConflict(input: {
  projectConfig: ProjectConfig;
  workspaceId: string;
  editingScheduleId: string | null;
}): ProjectWorkflowSchedule | undefined {
  const workspaceId = input.workspaceId.trim();
  if (workspaceId.length === 0) {
    return undefined;
  }

  return (input.projectConfig.workflowSchedules ?? []).find(
    (schedule) =>
      schedule.id !== input.editingScheduleId &&
      schedule.target.type === "existing-workspace" &&
      schedule.target.workspaceId === workspaceId
  );
}

function getTargetLabel(
  schedule: ProjectWorkflowSchedule,
  workspacesById: Map<string, Workspace>
): string {
  const target = schedule.target;
  if (target.type === "new-workspace") {
    return "Fresh workspace each run";
  }

  return `Existing workspace: ${getWorkspaceLabel(workspacesById.get(target.workspaceId))}`;
}

function getNewWorkspaceAutomationUnavailableReason(input: {
  projectPath: string;
  workspaces: Workspace[];
}): string | null {
  return getSupportedWorkflowScheduleNewWorkspaceTemplate({
    sourceProjectPath: input.projectPath,
    workspaces: input.workspaces,
  }).unavailableReason;
}

function getWorkflowUnavailableReason(input: {
  workflowName: string;
  workflowDefinitions: WorkflowDefinitionDescriptor[];
  definitionsPending: boolean;
}): string | null {
  if (input.definitionsPending) {
    return "Workflow definitions are still loading.";
  }
  const workflowName = input.workflowName.trim();
  if (workflowName.length === 0) {
    return "Choose a workflow before running this automation.";
  }
  const definition = input.workflowDefinitions.find((workflow) => workflow.name === workflowName);
  if (definition == null) {
    return "Workflow not found.";
  }
  if (!definition.executable) {
    return definition.blockedReason ?? "Workflow is not executable.";
  }
  return null;
}

function getEnabledScheduleInput(
  schedule: ProjectWorkflowSchedule,
  enabled: boolean
): Omit<ProjectWorkflowSchedule, "lastRunStartedAt"> {
  return {
    id: schedule.id,
    ...(schedule.title != null ? { title: schedule.title } : {}),
    enabled,
    workflowName: schedule.workflowName,
    ...(schedule.args != null ? { args: schedule.args } : {}),
    ...(schedule.target.type === "existing-workspace" && schedule.contextMode != null
      ? { contextMode: schedule.contextMode }
      : {}),
    intervalMs: schedule.intervalMs,
    target: schedule.target,
  };
}

export function ProjectAutomationsModal(props: ProjectAutomationsModalProps) {
  const { api } = useAPI();
  const { getProjectConfig, refreshProjects } = useProjectContext();
  const rows = props.projectConfig.workflowSchedules ?? [];
  const ownerProjectPath = props.projectConfig.parentProjectPath ?? props.projectPath;
  const ownerProjectConfig =
    ownerProjectPath === props.projectPath
      ? props.projectConfig
      : getProjectConfig(ownerProjectPath);
  const ownerWorkspaces = ownerProjectConfig?.workspaces ?? props.projectConfig.workspaces;
  const activeWorkspaces = ownerWorkspaces.filter(
    (workspace) =>
      workspace.id != null && !isWorkspaceArchived(workspace.archivedAt, workspace.unarchivedAt)
  );
  const workspacesById = new Map(
    ownerWorkspaces
      .filter((workspace) => workspace.id != null)
      .map((workspace) => [workspace.id!, workspace])
  );
  const [mode, setMode] = useState<"list" | "edit">("list");
  const [editingSchedule, setEditingSchedule] = useState<ProjectWorkflowSchedule | null>(null);
  const [workflowDefinitions, setWorkflowDefinitions] = useState<WorkflowDefinitionDescriptor[]>(
    []
  );
  const [definitionsLoading, setDefinitionsLoading] = useState(false);
  const [definitionsLoaded, setDefinitionsLoaded] = useState(false);
  const [definitionsError, setDefinitionsError] = useState<string | null>(null);
  const [recommendedTrunk, setRecommendedTrunk] = useState("main");
  const [isSaving, setIsSaving] = useState(false);
  const [runningScheduleKey, setRunningScheduleKey] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [draftTitle, setDraftTitle] = useState("");
  const [draftEnabled, setDraftEnabled] = useState(true);
  const [draftWorkflowName, setDraftWorkflowName] = useState("");
  const [draftIntervalMinutes, setDraftIntervalMinutes] = useState(
    String(WORKFLOW_SCHEDULE_DEFAULT_INTERVAL_MINUTES)
  );
  const [draftArgs, setDraftArgs] = useState("");
  const [draftContextMode, setDraftContextMode] = useState<WorkflowScheduleContextMode>(
    WORKFLOW_SCHEDULE_DEFAULT_CONTEXT_MODE
  );
  const [draftTargetType, setDraftTargetType] =
    useState<ProjectAutomationTargetType>("new-workspace");
  const [draftExistingWorkspaceId, setDraftExistingWorkspaceId] = useState("");
  const [draftTargetBranchName, setDraftTargetBranchName] = useState("");
  const [draftTargetTrunkBranch, setDraftTargetTrunkBranch] = useState("main");
  const [targetTrunkTouched, setTargetTrunkTouched] = useState(false);
  const [draftTargetTitle, setDraftTargetTitle] = useState("");
  const lastInitializedEditKeyRef = useRef<string | null>(null);

  const executableWorkflowDefinitions = workflowDefinitions.filter(
    (workflow) => workflow.executable
  );
  const firstExecutableWorkflowName = executableWorkflowDefinitions[0]?.name ?? "";
  const selectedWorkflowDefinition = workflowDefinitions.find(
    (workflow) => workflow.name === draftWorkflowName
  );
  const selectedWorkflowMissing =
    draftWorkflowName.length > 0 && selectedWorkflowDefinition == null;
  const selectedWorkflowNonExecutable =
    draftWorkflowName.length > 0 &&
    selectedWorkflowDefinition != null &&
    !selectedWorkflowDefinition.executable;
  const selectedWorkflowExecutable = selectedWorkflowDefinition?.executable === true;
  const definitionsPending =
    definitionsLoading || (props.open && api != null && !definitionsLoaded);
  const argsParseResult = parseWorkflowArgs(draftArgs);
  const intervalValidationError = getWorkflowScheduleIntervalValidationError(draftIntervalMinutes);
  const editingScheduleId = getProjectScheduleId(editingSchedule);
  const newWorkspaceUnavailableReason = getNewWorkspaceAutomationUnavailableReason({
    projectPath: props.projectPath,
    workspaces: ownerWorkspaces,
  });
  const existingWorkspaceConflict =
    draftTargetType === "existing-workspace"
      ? getExistingWorkspaceAutomationConflict({
          projectConfig: props.projectConfig,
          workspaceId: draftExistingWorkspaceId,
          editingScheduleId,
        })
      : undefined;
  const existingWorkspaceOptions = activeWorkspaces.filter((workspace) => {
    if (workspace.id == null) return false;
    if (workspace.id === draftExistingWorkspaceId) return true;
    return (
      getExistingWorkspaceAutomationConflict({
        projectConfig: props.projectConfig,
        workspaceId: workspace.id,
        editingScheduleId,
      }) == null
    );
  });
  const workflowValidationError = definitionsPending
    ? null
    : draftWorkflowName.length === 0
      ? "Choose a workflow before saving."
      : draftEnabled && !selectedWorkflowExecutable
        ? "Choose an executable workflow before enabling the automation."
        : null;
  const targetTypeValidationError =
    draftTargetType === "new-workspace" ? newWorkspaceUnavailableReason : null;
  const targetValidationError =
    draftTargetType !== "existing-workspace"
      ? null
      : draftExistingWorkspaceId.trim().length === 0
        ? "Choose an existing workspace or use a fresh workspace target."
        : existingWorkspaceConflict != null
          ? `${getWorkspaceLabel(workspacesById.get(draftExistingWorkspaceId))} already has an automation.`
          : null;
  const targetTrunkValidationError =
    draftTargetType === "new-workspace" && draftTargetTrunkBranch.trim().length === 0
      ? "Base branch is required when creating a new workspace for each run."
      : null;
  const targetBranchValidationError =
    draftTargetType === "new-workspace"
      ? getTargetBranchValidationError(draftTargetBranchName)
      : null;
  const workflowHelpId = "project-automation-workflow-help";
  const workflowErrorId = "project-automation-workflow-error";
  const targetTypeHelpId = "project-automation-target-help";
  const targetTypeErrorId = "project-automation-target-error";
  const existingWorkspaceHelpId = "project-automation-existing-workspace-help";
  const existingWorkspaceErrorId = "project-automation-existing-workspace-error";
  const targetTrunkHelpId = "project-automation-target-trunk-help";
  const targetTrunkErrorId = "project-automation-target-trunk-error";
  const targetBranchHelpId = "project-automation-target-branch-help";
  const targetBranchErrorId = "project-automation-target-branch-error";
  const intervalHelpId = "project-automation-interval-help";
  const intervalErrorId = "project-automation-interval-error";
  const argsHelpId = "project-automation-args-help";
  const argsErrorId = "project-automation-args-error";
  const getDescriptionIds = (...ids: Array<string | null>): string | undefined => {
    const descriptionIds = ids.filter((id): id is string => id != null).join(" ");
    return descriptionIds.length > 0 ? descriptionIds : undefined;
  };
  const getErrorMessageId = (message: string): string | undefined => {
    if (message === workflowValidationError) return workflowErrorId;
    if (message === targetTypeValidationError) return targetTypeErrorId;
    if (message === targetValidationError) return existingWorkspaceErrorId;
    if (message === targetTrunkValidationError) return targetTrunkErrorId;
    if (message === targetBranchValidationError) return targetBranchErrorId;
    if (message === intervalValidationError) return intervalErrorId;
    if (message === argsParseResult.error) return argsErrorId;
    return undefined;
  };
  const errorMessages = [
    definitionsError,
    saveError,
    intervalValidationError,
    workflowValidationError,
    targetTypeValidationError,
    targetValidationError,
    targetTrunkValidationError,
    targetBranchValidationError,
    argsParseResult.error,
  ].filter((message): message is string => message != null);
  const hasBlockingError =
    isSaving ||
    api == null ||
    definitionsPending ||
    intervalValidationError != null ||
    workflowValidationError != null ||
    targetTypeValidationError != null ||
    targetValidationError != null ||
    targetTrunkValidationError != null ||
    targetBranchValidationError != null ||
    argsParseResult.error != null;

  useEffect(() => {
    if (!props.open) {
      setMode("list");
      setEditingSchedule(null);
      return;
    }

    let ignore = false;
    setDefinitionsLoading(true);
    setDefinitionsLoaded(false);
    setDefinitionsError(null);

    void (async () => {
      try {
        const definitions = await api?.workflows.listDefinitions({
          projectPath: props.projectPath,
        });
        if (ignore) return;
        setWorkflowDefinitions(Array.isArray(definitions) ? definitions : []);
        setDefinitionsLoaded(true);
      } catch (error) {
        if (ignore) return;
        setWorkflowDefinitions([]);
        setDefinitionsLoaded(true);
        setDefinitionsError(getErrorMessage(error) || "Failed to load workflow definitions.");
      } finally {
        if (!ignore) {
          setDefinitionsLoading(false);
        }
      }
    })();

    void (async () => {
      try {
        const result = await api?.projects.listBranches({ projectPath: props.projectPath });
        if (ignore) return;
        const recommended = result?.recommendedTrunk ?? result?.branches[0] ?? "main";
        setRecommendedTrunk(recommended || "main");
      } catch {
        if (!ignore) {
          setRecommendedTrunk("main");
        }
      }
    })();

    return () => {
      ignore = true;
    };
  }, [api, props.open, props.projectPath]);

  const editInitializationKey =
    mode === "edit"
      ? `${props.projectPath}:${editingSchedule != null ? getProjectAutomationRowKey(editingSchedule) : "new"}`
      : null;

  useEffect(() => {
    if (mode !== "edit" || editInitializationKey == null) {
      lastInitializedEditKeyRef.current = null;
      return;
    }
    if (lastInitializedEditKeyRef.current === editInitializationKey) {
      return;
    }
    lastInitializedEditKeyRef.current = editInitializationKey;

    const schedule = editingSchedule ?? undefined;
    const editingScheduleId = getProjectScheduleId(editingSchedule);
    const firstAvailableWorkspaceId =
      ownerWorkspaces.find(
        (workspace) =>
          workspace.id != null &&
          !isWorkspaceArchived(workspace.archivedAt, workspace.unarchivedAt) &&
          getExistingWorkspaceAutomationConflict({
            projectConfig: props.projectConfig,
            workspaceId: workspace.id,
            editingScheduleId,
          }) == null
      )?.id ?? "";
    setSaveError(null);
    setDraftTitle(schedule?.title ?? "");
    setDraftEnabled(schedule?.enabled ?? true);
    setDraftWorkflowName(schedule?.workflowName ?? "");
    setDraftIntervalMinutes(
      formatWorkflowScheduleIntervalMinutes(
        schedule?.intervalMs ?? WORKFLOW_SCHEDULE_DEFAULT_INTERVAL_MS
      )
    );
    setDraftArgs(formatWorkflowArgs(schedule?.args));
    setDraftContextMode(schedule?.contextMode ?? WORKFLOW_SCHEDULE_DEFAULT_CONTEXT_MODE);
    setTargetTrunkTouched(false);
    if (schedule?.target.type === "existing-workspace") {
      setDraftTargetType("existing-workspace");
      setDraftExistingWorkspaceId(schedule.target.workspaceId);
      setDraftTargetBranchName("");
      setDraftTargetTrunkBranch(recommendedTrunk);
      setDraftTargetTitle("");
    } else if (schedule?.target.type === "new-workspace" || newWorkspaceUnavailableReason == null) {
      setDraftTargetType("new-workspace");
      setDraftExistingWorkspaceId(firstAvailableWorkspaceId);
      setDraftTargetBranchName(
        schedule?.target.type === "new-workspace" ? (schedule.target.branchName ?? "") : ""
      );
      setDraftTargetTrunkBranch(
        schedule?.target.type === "new-workspace" ? schedule.target.trunkBranch : recommendedTrunk
      );
      setDraftTargetTitle(
        schedule?.target.type === "new-workspace" ? (schedule.target.title ?? "") : ""
      );
    } else {
      setDraftTargetType("existing-workspace");
      setDraftExistingWorkspaceId(firstAvailableWorkspaceId);
      setDraftTargetBranchName("");
      setDraftTargetTrunkBranch(recommendedTrunk);
      setDraftTargetTitle("");
    }
  }, [
    editInitializationKey,
    editingSchedule,
    mode,
    newWorkspaceUnavailableReason,
    ownerWorkspaces,
    props.projectConfig,
    recommendedTrunk,
  ]);

  useEffect(() => {
    if (mode !== "edit" || editingSchedule != null || draftWorkflowName.length > 0) {
      return;
    }
    if (firstExecutableWorkflowName.length > 0) {
      setDraftWorkflowName(firstExecutableWorkflowName);
    }
  }, [draftWorkflowName, editingSchedule, firstExecutableWorkflowName, mode]);

  useEffect(() => {
    if (
      mode !== "edit" ||
      editingSchedule != null ||
      draftTargetType !== "new-workspace" ||
      targetTrunkTouched
    ) {
      return;
    }
    setDraftTargetTrunkBranch(recommendedTrunk);
  }, [draftTargetType, editingSchedule, mode, recommendedTrunk, targetTrunkTouched]);

  const handleEdit = (row: ProjectWorkflowSchedule) => {
    setEditingSchedule(row);
    setMode("edit");
  };

  const handleNew = () => {
    setEditingSchedule(null);
    setMode("edit");
  };

  const handleBackToList = () => {
    setMode("list");
    setEditingSchedule(null);
    setSaveError(null);
  };

  const handleSave = async () => {
    const parsedMinutes = parseWorkflowScheduleIntervalMinutes(draftIntervalMinutes);
    assert(parsedMinutes != null, "Save should only run with a valid workflow schedule interval");
    assert(argsParseResult.error == null, "Save should only run with valid workflow args JSON");
    assert(draftWorkflowName.length > 0, "Save should only run with a selected workflow");
    assert(
      !draftEnabled || selectedWorkflowExecutable,
      "Enabled automations require executable workflows"
    );

    setIsSaving(true);
    setSaveError(null);
    try {
      if (api == null) {
        throw new Error("Project automation settings are unavailable while disconnected.");
      }

      const projectSchedule = editingSchedule ?? undefined;
      const shouldPersistContextMode =
        draftTargetType === "existing-workspace" &&
        draftContextMode !== WORKFLOW_SCHEDULE_DEFAULT_CONTEXT_MODE;
      const schedule = {
        ...(projectSchedule?.id ? { id: projectSchedule.id } : {}),
        ...(draftTitle.trim().length > 0 ? { title: draftTitle.trim() } : {}),
        enabled: draftEnabled,
        workflowName: draftWorkflowName,
        intervalMs: workflowScheduleIntervalMinutesToMs(parsedMinutes),
        ...(argsParseResult.args ? { args: argsParseResult.args } : {}),
        ...(shouldPersistContextMode ? { contextMode: draftContextMode } : {}),
        target:
          draftTargetType === "existing-workspace"
            ? {
                type: "existing-workspace" as const,
                workspaceId: draftExistingWorkspaceId.trim(),
              }
            : {
                type: "new-workspace" as const,
                trunkBranch: draftTargetTrunkBranch.trim(),
                ...(draftTargetBranchName.trim().length > 0
                  ? { branchName: draftTargetBranchName.trim() }
                  : {}),
                ...(draftTargetTitle.trim().length > 0 ? { title: draftTargetTitle.trim() } : {}),
              },
      };

      const result = await api.projects.workflowSchedules.set({
        projectPath: props.projectPath,
        schedule,
      });
      if (!result.success) {
        throw new Error(result.error);
      }
      await refreshProjects();
      handleBackToList();
    } catch (error) {
      setSaveError(getErrorMessage(error) || "Failed to save project automation.");
    } finally {
      setIsSaving(false);
    }
  };

  const handleRunNow = async (row: ProjectWorkflowSchedule) => {
    const unavailableReason = getWorkflowUnavailableReason({
      workflowName: row.workflowName,
      workflowDefinitions,
      definitionsPending,
    });
    if (unavailableReason != null) {
      setSaveError(`Cannot run automation: ${unavailableReason}`);
      return;
    }

    const rowKey = getProjectAutomationRowKey(row);
    setRunningScheduleKey(rowKey);
    setSaveError(null);
    try {
      if (api == null) throw new Error("Project automation runner is unavailable.");
      const result = await api.projects.workflowSchedules.run({
        projectPath: props.projectPath,
        scheduleId: row.id,
      });
      if (!result.success) throw new Error(result.error);
      await refreshProjects();
    } catch (error) {
      setSaveError(getErrorMessage(error) || "Failed to run project automation.");
    } finally {
      setRunningScheduleKey((current) => (current === rowKey ? null : current));
    }
  };

  const handleToggle = async (row: ProjectWorkflowSchedule, enabled: boolean) => {
    if (enabled) {
      const unavailableReason = getWorkflowUnavailableReason({
        workflowName: row.workflowName,
        workflowDefinitions,
        definitionsPending,
      });
      if (unavailableReason != null) {
        setSaveError(`Cannot enable automation: ${unavailableReason}`);
        return;
      }
    }

    setIsSaving(true);
    setSaveError(null);
    try {
      if (api == null) throw new Error("Project automation settings are unavailable.");
      const result = await api.projects.workflowSchedules.set({
        projectPath: props.projectPath,
        schedule: getEnabledScheduleInput(row, enabled),
      });
      if (!result.success) throw new Error(result.error);
      await refreshProjects();
    } catch (error) {
      setSaveError(getErrorMessage(error) || "Failed to update project automation.");
    } finally {
      setIsSaving(false);
    }
  };

  const handleRemove = async (row: ProjectWorkflowSchedule) => {
    setIsSaving(true);
    setSaveError(null);
    try {
      if (api == null) throw new Error("Project automation settings are unavailable.");
      const result = await api.projects.workflowSchedules.remove({
        projectPath: props.projectPath,
        scheduleId: row.id,
      });
      if (!result.success) throw new Error(result.error);
      await refreshProjects();
    } catch (error) {
      setSaveError(getErrorMessage(error) || "Failed to remove project automation.");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="max-w-3xl" maxHeight="calc(100dvh - 2rem)">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CalendarClock className="h-5 w-5" />
            Automations for {props.projectName}
          </DialogTitle>
        </DialogHeader>

        {mode === "list" ? (
          <div className="space-y-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <p className="text-muted text-sm">
                Configure project-level automations. Workspaces are resolved or created when each
                automation runs.
              </p>
              <Button onClick={handleNew} disabled={isSaving || api == null}>
                <Plus className="h-4 w-4" />
                New automation
              </Button>
            </div>

            {saveError && (
              <div
                className="bg-danger-soft/10 text-danger-soft rounded-md p-3 text-sm"
                role="alert"
              >
                {saveError}
              </div>
            )}

            {rows.length === 0 ? (
              <div className="border-border text-muted rounded-lg border p-6 text-sm">
                No automations configured for this project yet.
              </div>
            ) : (
              <div className="border-border divide-border divide-y overflow-hidden rounded-lg border">
                {rows.map((row) => {
                  const rowKey = getProjectAutomationRowKey(row);
                  const isRunningNow = runningScheduleKey === rowKey;
                  const rowWorkflowUnavailableReason = getWorkflowUnavailableReason({
                    workflowName: row.workflowName,
                    workflowDefinitions,
                    definitionsPending,
                  });
                  const canEnableRow = row.enabled || rowWorkflowUnavailableReason == null;
                  return (
                    <div key={rowKey} className="space-y-3 p-4">
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                        <div className="min-w-0 flex-1">
                          <div className="text-foreground truncate text-sm font-medium">
                            {getScheduleLabel(row)}
                          </div>
                          <div className="text-muted mt-1 text-xs">
                            {row.workflowName} • every{" "}
                            {formatWorkflowScheduleIntervalMinutes(row.intervalMs)} min •{" "}
                            {getTargetLabel(row, workspacesById)}
                          </div>
                          {rowWorkflowUnavailableReason != null && (
                            <div className="text-danger-soft mt-1 text-xs">
                              {rowWorkflowUnavailableReason}
                            </div>
                          )}
                          <div className="text-muted mt-1 text-xs">
                            Last run: {formatLastRunStartedAt(row.lastRunStartedAt)}
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => void handleRunNow(row)}
                            disabled={
                              isSaving ||
                              isRunningNow ||
                              api == null ||
                              !row.enabled ||
                              rowWorkflowUnavailableReason != null
                            }
                            aria-label={`Run ${getScheduleLabel(row)} now`}
                          >
                            {isRunningNow ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <Play className="h-4 w-4" />
                            )}
                          </Button>
                          <Switch
                            checked={row.enabled}
                            onCheckedChange={(checked) => void handleToggle(row, checked)}
                            disabled={isSaving || api == null || !canEnableRow}
                            aria-label={`Enable ${getScheduleLabel(row)}`}
                          />
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleEdit(row)}
                            disabled={isSaving}
                          >
                            Edit
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => void handleRemove(row)}
                            disabled={isSaving || api == null}
                            aria-label={`Remove ${getScheduleLabel(row)}`}
                          >
                            <Trash className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-muted text-sm">
              The project owns this automation; the workspace target is resolved at run time.
            </p>

            <div className="border-border rounded-lg border p-4">
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <div className="text-foreground text-sm font-medium">Enable automation</div>
                  <div className="text-muted mt-1 text-xs">
                    Keep this project automation eligible for recurring background workflow runs.
                  </div>
                </div>
                <Switch
                  checked={draftEnabled}
                  onCheckedChange={setDraftEnabled}
                  disabled={isSaving}
                  aria-label="Enable project automation"
                />
              </div>

              <div className="mt-4 space-y-2">
                <label htmlFor="project-automation-title" className="block">
                  <div className="text-foreground text-sm font-medium">Name</div>
                  <div className="text-muted mt-1 text-xs">
                    Optional display name for this automation.
                  </div>
                </label>
                <Input
                  id="project-automation-title"
                  value={draftTitle}
                  onInput={(event: React.FormEvent<HTMLInputElement>) => {
                    setDraftTitle(event.currentTarget.value);
                  }}
                  disabled={isSaving}
                  className="border-border-medium bg-background-secondary h-9 w-full"
                  placeholder="GitHub issue triage"
                  aria-label="Project automation name"
                />
              </div>

              <div className="mt-4 space-y-2">
                <label htmlFor="project-automation-workflow" className="block">
                  <div className="text-foreground text-sm font-medium">Workflow</div>
                  <div id={workflowHelpId} className="text-muted mt-1 text-xs">
                    Only executable workflows can be enabled for automations.
                  </div>
                </label>
                <div className="relative">
                  <select
                    id="project-automation-workflow"
                    value={draftWorkflowName}
                    onChange={(event: React.ChangeEvent<HTMLSelectElement>) => {
                      setDraftWorkflowName(event.target.value);
                    }}
                    disabled={isSaving || definitionsPending}
                    className="border-border-medium bg-background-secondary text-foreground focus:border-accent focus:ring-accent h-9 w-full min-w-0 rounded-md border px-3 text-sm focus:ring-1 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
                    aria-label="Project automation workflow"
                    aria-invalid={workflowValidationError != null}
                    aria-describedby={getDescriptionIds(
                      workflowHelpId,
                      workflowValidationError ? workflowErrorId : null
                    )}
                  >
                    {definitionsPending ? <option value="">Loading workflows…</option> : null}
                    {!definitionsPending && selectedWorkflowMissing ? (
                      <option value={draftWorkflowName}>{draftWorkflowName} (not found)</option>
                    ) : null}
                    {!definitionsPending && selectedWorkflowNonExecutable ? (
                      <option value={draftWorkflowName} disabled>
                        {draftWorkflowName} (
                        {selectedWorkflowDefinition.blockedReason ?? "not executable"})
                      </option>
                    ) : null}
                    {!definitionsPending &&
                    executableWorkflowDefinitions.length === 0 &&
                    !selectedWorkflowMissing &&
                    !selectedWorkflowNonExecutable ? (
                      <option value="">No executable workflows found</option>
                    ) : null}
                    {executableWorkflowDefinitions.map((workflow) => (
                      <option key={`${workflow.scope}:${workflow.name}`} value={workflow.name}>
                        {workflow.name} — {workflow.description}
                      </option>
                    ))}
                  </select>
                  {definitionsPending && (
                    <Loader2 className="text-muted pointer-events-none absolute top-2.5 right-3 h-4 w-4 animate-spin" />
                  )}
                </div>
              </div>

              <div className="mt-4 space-y-2">
                <label htmlFor="project-automation-target" className="block">
                  <div className="text-foreground text-sm font-medium">Run target</div>
                  <div id={targetTypeHelpId} className="text-muted mt-1 text-xs">
                    Fresh-workspace automations create a new workspace for every due run.
                  </div>
                </label>
                <select
                  id="project-automation-target"
                  value={draftTargetType}
                  onChange={(event: React.ChangeEvent<HTMLSelectElement>) => {
                    setDraftTargetType(event.target.value as ProjectAutomationTargetType);
                  }}
                  disabled={isSaving}
                  className="border-border-medium bg-background-secondary text-foreground focus:border-accent focus:ring-accent h-9 w-full min-w-0 rounded-md border px-3 text-sm focus:ring-1 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
                  aria-label="Project automation run target"
                  aria-invalid={targetTypeValidationError != null}
                  aria-describedby={getDescriptionIds(
                    targetTypeHelpId,
                    targetTypeValidationError ? targetTypeErrorId : null
                  )}
                >
                  <option value="new-workspace" disabled={newWorkspaceUnavailableReason != null}>
                    New workspace each run
                  </option>
                  <option value="existing-workspace">Existing workspace</option>
                </select>
              </div>

              {draftTargetType === "existing-workspace" ? (
                <div className="mt-3 space-y-2">
                  <label htmlFor="project-automation-existing-workspace" className="block">
                    <div className="text-foreground text-sm font-medium">Workspace</div>
                    <div id={existingWorkspaceHelpId} className="text-muted mt-1 text-xs">
                      Workspace used whenever this automation runs.
                    </div>
                  </label>
                  <select
                    id="project-automation-existing-workspace"
                    value={draftExistingWorkspaceId}
                    onChange={(event: React.ChangeEvent<HTMLSelectElement>) => {
                      setDraftExistingWorkspaceId(event.target.value);
                    }}
                    disabled={isSaving}
                    className="border-border-medium bg-background-secondary text-foreground focus:border-accent focus:ring-accent h-9 w-full min-w-0 rounded-md border px-3 text-sm focus:ring-1 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
                    aria-label="Project automation existing workspace"
                    aria-invalid={targetValidationError != null}
                    aria-describedby={getDescriptionIds(
                      existingWorkspaceHelpId,
                      targetValidationError ? existingWorkspaceErrorId : null
                    )}
                  >
                    {existingWorkspaceOptions.length === 0 ? (
                      <option value="">No active workspaces without an automation</option>
                    ) : null}
                    {existingWorkspaceOptions.map((workspace) => (
                      <option key={workspace.id} value={workspace.id}>
                        {getWorkspaceLabel(workspace)}
                      </option>
                    ))}
                  </select>
                </div>
              ) : (
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <label htmlFor="project-automation-target-trunk" className="block min-w-0">
                    <div className="text-foreground text-sm font-medium">Base branch</div>
                    <div id={targetTrunkHelpId} className="text-muted mt-1 text-xs">
                      Branch checked out before the automation starts.
                    </div>
                    <Input
                      id="project-automation-target-trunk"
                      value={draftTargetTrunkBranch}
                      onInput={(event: React.FormEvent<HTMLInputElement>) => {
                        setTargetTrunkTouched(true);
                        setDraftTargetTrunkBranch(event.currentTarget.value);
                      }}
                      disabled={isSaving}
                      className="border-border-medium bg-background-secondary mt-2 h-9 w-full"
                      placeholder="main"
                      aria-label="Project automation base branch"
                      aria-invalid={targetTrunkValidationError != null}
                      aria-describedby={getDescriptionIds(
                        targetTrunkHelpId,
                        targetTrunkValidationError ? targetTrunkErrorId : null
                      )}
                    />
                  </label>
                  <label htmlFor="project-automation-target-branch" className="block min-w-0">
                    <div className="text-foreground text-sm font-medium">New branch name</div>
                    <div id={targetBranchHelpId} className="text-muted mt-1 text-xs">
                      Optional base name; collisions may receive a suffix.
                    </div>
                    <Input
                      id="project-automation-target-branch"
                      value={draftTargetBranchName}
                      onInput={(event: React.FormEvent<HTMLInputElement>) => {
                        setDraftTargetBranchName(event.currentTarget.value);
                      }}
                      disabled={isSaving}
                      className="border-border-medium bg-background-secondary mt-2 h-9 w-full"
                      placeholder="scheduled-run"
                      aria-label="Project automation new branch name"
                      aria-invalid={targetBranchValidationError != null}
                      aria-describedby={getDescriptionIds(
                        targetBranchHelpId,
                        targetBranchValidationError ? targetBranchErrorId : null
                      )}
                    />
                  </label>
                  <label
                    htmlFor="project-automation-target-title"
                    className="block min-w-0 sm:col-span-2"
                  >
                    <div className="text-foreground text-sm font-medium">New workspace title</div>
                    <div className="text-muted mt-1 text-xs">
                      Optional title applied to each created run workspace.
                    </div>
                    <Input
                      id="project-automation-target-title"
                      value={draftTargetTitle}
                      onInput={(event: React.FormEvent<HTMLInputElement>) => {
                        setDraftTargetTitle(event.currentTarget.value);
                      }}
                      disabled={isSaving}
                      className="border-border-medium bg-background-secondary mt-2 h-9 w-full"
                      placeholder="Automation run"
                      aria-label="Project automation new workspace title"
                    />
                  </label>
                </div>
              )}

              {draftTargetType === "existing-workspace" && (
                <div className="mt-4 space-y-2">
                  <label htmlFor="project-automation-context-mode" className="block">
                    <div className="text-foreground text-sm font-medium">Context before run</div>
                    <div className="text-muted mt-1 text-xs">
                      Applied before running in the selected workspace.
                    </div>
                  </label>
                  <select
                    id="project-automation-context-mode"
                    value={draftContextMode}
                    onChange={(event: React.ChangeEvent<HTMLSelectElement>) => {
                      setDraftContextMode(event.target.value as WorkflowScheduleContextMode);
                    }}
                    disabled={isSaving}
                    className="border-border-medium bg-background-secondary text-foreground focus:border-accent focus:ring-accent h-9 w-full min-w-0 rounded-md border px-3 text-sm focus:ring-1 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
                    aria-label="Project automation context mode"
                  >
                    <option value="normal">Keep existing context</option>
                    <option value="reset">Soft reset context</option>
                    <option value="compact">Compact context first</option>
                  </select>
                </div>
              )}

              <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <label htmlFor="project-automation-interval" className="min-w-0 flex-1">
                  <div className="text-foreground text-sm font-medium">Interval</div>
                  <div id={intervalHelpId} className="text-muted mt-1 text-xs">
                    Valid range: {WORKFLOW_SCHEDULE_MIN_INTERVAL_MINUTES}–
                    {WORKFLOW_SCHEDULE_MAX_INTERVAL_MINUTES} minutes. New automations default to{" "}
                    {WORKFLOW_SCHEDULE_DEFAULT_INTERVAL_MINUTES} minutes.
                  </div>
                </label>
                <div className="flex items-center gap-2 self-start sm:self-auto">
                  <Input
                    id="project-automation-interval"
                    type="number"
                    inputMode="numeric"
                    min={WORKFLOW_SCHEDULE_MIN_INTERVAL_MINUTES}
                    max={WORKFLOW_SCHEDULE_MAX_INTERVAL_MINUTES}
                    step={1}
                    value={draftIntervalMinutes}
                    onInput={(event: React.FormEvent<HTMLInputElement>) => {
                      setDraftIntervalMinutes(event.currentTarget.value);
                    }}
                    disabled={isSaving}
                    className="border-border-medium bg-background-secondary h-9 w-24 text-right"
                    aria-label="Project automation interval in minutes"
                    aria-invalid={intervalValidationError != null}
                    aria-describedby={getDescriptionIds(
                      intervalHelpId,
                      intervalValidationError ? intervalErrorId : null
                    )}
                  />
                  <span className="text-muted text-sm">min</span>
                </div>
              </div>

              <div className="mt-4 space-y-2">
                <label htmlFor="project-automation-args" className="block">
                  <div className="text-foreground text-sm font-medium">Args</div>
                  <div id={argsHelpId} className="text-muted mt-1 text-xs">
                    Optional JSON object passed to the workflow run.
                  </div>
                </label>
                <textarea
                  id="project-automation-args"
                  rows={5}
                  value={draftArgs}
                  onInput={(event: React.FormEvent<HTMLTextAreaElement>) => {
                    setDraftArgs(event.currentTarget.value);
                  }}
                  disabled={isSaving}
                  className="border-border-medium bg-background-secondary text-foreground focus:border-accent focus:ring-accent min-h-[120px] w-full resize-y rounded-md border p-3 text-sm leading-relaxed focus:ring-1 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
                  placeholder={'{\n  "label": "needs-triage"\n}'}
                  aria-label="Project automation args"
                  aria-invalid={argsParseResult.error != null}
                  aria-describedby={getDescriptionIds(
                    argsHelpId,
                    argsParseResult.error ? argsErrorId : null
                  )}
                />
              </div>
            </div>

            {errorMessages.length > 0 && (
              <div
                className="bg-danger-soft/10 text-danger-soft space-y-1 rounded-md p-3 text-sm"
                role="alert"
              >
                {errorMessages.map((message) => (
                  <p key={message} id={getErrorMessageId(message)}>
                    {message}
                  </p>
                ))}
              </div>
            )}

            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={handleBackToList} disabled={isSaving}>
                Back
              </Button>
              <Button onClick={() => void handleSave()} disabled={hasBlockingError}>
                {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                Save
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
