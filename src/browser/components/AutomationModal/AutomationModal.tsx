import React, { useEffect, useRef, useState } from "react";
import { CalendarClock, Loader2 } from "lucide-react";
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
import type { ProjectWorkflowSchedule } from "@/common/types/project";
import type { WorkflowDefinitionDescriptor } from "@/common/types/workflow";
import { getErrorMessage } from "@/common/utils/errors";
import assert from "@/common/utils/assert";
import {
  WORKFLOW_SCHEDULE_DEFAULT_CONTEXT_MODE,
  WORKFLOW_SCHEDULE_DEFAULT_INTERVAL_MS,
  type WorkflowScheduleContextMode,
} from "@/constants/workflowSchedule";
import {
  clampWorkflowScheduleIntervalMinutes,
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

interface AutomationModalProps {
  open: boolean;
  projectPath: string;
  workspaceId: string;
  workspaceName: string;
  projectWorkflowSchedule?: ProjectWorkflowSchedule;
  onOpenChange: (open: boolean) => void;
}

function getWorkspaceLabel(workspaceName: string): string {
  const trimmedName = workspaceName.trim();
  return trimmedName.length > 0 ? trimmedName : "this workspace";
}

function formatLastRunStartedAt(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toLocaleString();
}

type AutomationDraft = Pick<
  ProjectWorkflowSchedule,
  "enabled" | "workflowName" | "intervalMs" | "args" | "contextMode" | "lastRunStartedAt"
>;

export function AutomationModal(props: AutomationModalProps) {
  const { api } = useAPI();
  const { getProjectConfig, refreshProjects } = useProjectContext();
  const workflowSchedule: AutomationDraft | undefined = props.projectWorkflowSchedule;
  const projectConfig = getProjectConfig(props.projectPath);
  const shouldLoadDefinitionsByProject = projectConfig?.parentProjectPath != null;
  const initializationKey = JSON.stringify({
    projectPath: props.projectPath,
    workspaceId: props.workspaceId,
    projectScheduleId: props.projectWorkflowSchedule?.id ?? "",
    enabled: workflowSchedule?.enabled ?? false,
    workflowName: workflowSchedule?.workflowName ?? "",
    intervalMs: workflowSchedule?.intervalMs ?? WORKFLOW_SCHEDULE_DEFAULT_INTERVAL_MS,
    args: workflowSchedule?.args ?? null,
    contextMode: workflowSchedule?.contextMode ?? WORKFLOW_SCHEDULE_DEFAULT_CONTEXT_MODE,
  });
  const [workflowDefinitions, setWorkflowDefinitions] = useState<WorkflowDefinitionDescriptor[]>(
    []
  );
  const [definitionsLoading, setDefinitionsLoading] = useState(false);
  const [definitionsError, setDefinitionsError] = useState<string | null>(null);
  const [draftEnabled, setDraftEnabled] = useState(() => workflowSchedule?.enabled ?? false);
  const [draftWorkflowName, setDraftWorkflowName] = useState(
    () => workflowSchedule?.workflowName ?? ""
  );
  const [draftIntervalMinutes, setDraftIntervalMinutes] = useState(() =>
    formatWorkflowScheduleIntervalMinutes(
      workflowSchedule?.intervalMs ?? WORKFLOW_SCHEDULE_DEFAULT_INTERVAL_MS
    )
  );
  const [draftArgs, setDraftArgs] = useState(() => formatWorkflowArgs(workflowSchedule?.args));
  const [draftContextMode, setDraftContextMode] = useState<WorkflowScheduleContextMode>(
    () => workflowSchedule?.contextMode ?? WORKFLOW_SCHEDULE_DEFAULT_CONTEXT_MODE
  );
  const [workflowNameTouched, setWorkflowNameTouched] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [definitionsLoaded, setDefinitionsLoaded] = useState(false);
  const lastInitializedKeyRef = useRef<string | null>(props.open ? initializationKey : null);

  const executableWorkflowDefinitions = workflowDefinitions.filter(
    (workflow) => workflow.executable
  );
  const firstExecutableWorkflowName = executableWorkflowDefinitions[0]?.name ?? "";
  const selectedWorkflowDefinition = workflowDefinitions.find(
    (workflow) => workflow.name === draftWorkflowName
  );
  const selectedWorkflowExecutable = selectedWorkflowDefinition?.executable === true;
  const selectedWorkflowMissing =
    draftWorkflowName.length > 0 && selectedWorkflowDefinition == null;
  const selectedWorkflowNonExecutable =
    draftWorkflowName.length > 0 &&
    selectedWorkflowDefinition != null &&
    !selectedWorkflowExecutable;
  const definitionsPending =
    definitionsLoading ||
    (props.open && api != null && props.workspaceId.length > 0 && !definitionsLoaded);
  const argsParseResult = parseWorkflowArgs(draftArgs);
  const intervalValidationError = getWorkflowScheduleIntervalValidationError(draftIntervalMinutes);
  const intervalHelpId = "automation-interval-help";
  const intervalErrorId = "automation-interval-error";
  const argsHelpId = "automation-args-help";
  const argsErrorId = "automation-args-error";
  const intervalDescriptionIds = [intervalHelpId, intervalValidationError ? intervalErrorId : null]
    .filter((id): id is string => id != null)
    .join(" ");
  const argsDescriptionIds = [argsHelpId, argsParseResult.error ? argsErrorId : null]
    .filter((id): id is string => id != null)
    .join(" ");
  const workflowValidationError = definitionsPending
    ? null
    : draftWorkflowName.length === 0
      ? "Choose a workflow before saving."
      : draftEnabled && !selectedWorkflowExecutable
        ? "Choose an executable workflow before enabling the automation."
        : null;
  const errorMessages = [
    definitionsError,
    saveError,
    intervalValidationError,
    argsParseResult.error,
    workflowValidationError,
  ].filter((message): message is string => message != null);
  const hasSchedule = workflowSchedule != null;
  const workspaceLabel = getWorkspaceLabel(props.workspaceName);
  const lastRunStartedAt = formatLastRunStartedAt(workflowSchedule?.lastRunStartedAt);
  const hasBlockingError =
    isSaving ||
    api == null ||
    definitionsPending ||
    intervalValidationError != null ||
    argsParseResult.error != null ||
    workflowValidationError != null;

  useEffect(() => {
    if (!props.open) {
      lastInitializedKeyRef.current = null;
      return;
    }

    if (lastInitializedKeyRef.current === initializationKey) {
      return;
    }

    lastInitializedKeyRef.current = initializationKey;
    setDraftEnabled(workflowSchedule?.enabled ?? false);
    setDraftWorkflowName(workflowSchedule?.workflowName ?? "");
    setDraftIntervalMinutes(
      formatWorkflowScheduleIntervalMinutes(
        workflowSchedule?.intervalMs ?? WORKFLOW_SCHEDULE_DEFAULT_INTERVAL_MS
      )
    );
    setDraftArgs(formatWorkflowArgs(workflowSchedule?.args));
    setDraftContextMode(workflowSchedule?.contextMode ?? WORKFLOW_SCHEDULE_DEFAULT_CONTEXT_MODE);
    setWorkflowNameTouched(false);
    setSaveError(null);
  }, [initializationKey, props.open, props.workspaceId, workflowSchedule]);

  useEffect(() => {
    if (
      !props.open ||
      workflowNameTouched ||
      draftWorkflowName.length > 0 ||
      workflowSchedule?.workflowName
    ) {
      return;
    }

    if (firstExecutableWorkflowName.length > 0) {
      setDraftWorkflowName(firstExecutableWorkflowName);
    }
  }, [
    draftWorkflowName,
    firstExecutableWorkflowName,
    props.open,
    workflowSchedule?.workflowName,
    workflowNameTouched,
  ]);

  useEffect(() => {
    if (
      !props.open ||
      !api ||
      (shouldLoadDefinitionsByProject
        ? props.projectPath.length === 0
        : props.workspaceId.length === 0)
    ) {
      setWorkflowDefinitions([]);
      setDefinitionsLoading(false);
      setDefinitionsLoaded(false);
      setDefinitionsError(null);
      return;
    }

    let ignore = false;
    setDefinitionsLoading(true);
    setDefinitionsLoaded(false);
    setDefinitionsError(null);

    void (async () => {
      try {
        const definitions = await api.workflows.listDefinitions(
          shouldLoadDefinitionsByProject
            ? { projectPath: props.projectPath }
            : { workspaceId: props.workspaceId }
        );
        if (ignore) {
          return;
        }
        setWorkflowDefinitions(Array.isArray(definitions) ? definitions : []);
        setDefinitionsLoaded(true);
      } catch (error) {
        if (ignore) {
          return;
        }
        setWorkflowDefinitions([]);
        setDefinitionsLoaded(true);
        setDefinitionsError(getErrorMessage(error) || "Failed to load workflow definitions.");
      } finally {
        if (!ignore) {
          setDefinitionsLoading(false);
        }
      }
    })();

    return () => {
      ignore = true;
    };
  }, [api, props.open, props.projectPath, props.workspaceId, shouldLoadDefinitionsByProject]);

  const handleIntervalBlur = () => {
    const parsedMinutes = parseWorkflowScheduleIntervalMinutes(draftIntervalMinutes);
    if (parsedMinutes == null) {
      return;
    }

    const clampedMinutes = clampWorkflowScheduleIntervalMinutes(parsedMinutes);
    const clampedMinutesValue = String(clampedMinutes);
    if (clampedMinutesValue !== draftIntervalMinutes) {
      setDraftIntervalMinutes(clampedMinutesValue);
    }
  };

  const saveSchedule = async (
    nextSchedule: Omit<ProjectWorkflowSchedule, "id" | "lastRunStartedAt">
  ): Promise<boolean> => {
    setIsSaving(true);
    setSaveError(null);
    if (api == null) {
      setSaveError("Automation settings are unavailable while disconnected.");
      setIsSaving(false);
      return false;
    }
    if (props.projectPath.trim().length === 0 || props.workspaceId.trim().length === 0) {
      setSaveError("Automation settings require a project and workspace.");
      setIsSaving(false);
      return false;
    }

    try {
      const result = await api.projects.workflowSchedules.set({
        projectPath: props.projectPath,
        schedule: {
          ...(props.projectWorkflowSchedule != null
            ? {
                id: props.projectWorkflowSchedule.id,
                ...(props.projectWorkflowSchedule.title != null
                  ? { title: props.projectWorkflowSchedule.title }
                  : {}),
              }
            : {}),
          ...nextSchedule,
        },
      });
      if (!result.success) {
        setSaveError(result.error ?? "Failed to save automation.");
        return false;
      }

      await refreshProjects();
      return true;
    } catch (error) {
      setSaveError(getErrorMessage(error) || "Failed to save automation.");
      return false;
    } finally {
      setIsSaving(false);
    }
  };

  const handleSave = async () => {
    const parsedMinutes = parseWorkflowScheduleIntervalMinutes(draftIntervalMinutes);
    assert(parsedMinutes != null, "Save should only run with a valid workflow schedule interval");
    assert(
      parsedMinutes >= WORKFLOW_SCHEDULE_MIN_INTERVAL_MINUTES &&
        parsedMinutes <= WORKFLOW_SCHEDULE_MAX_INTERVAL_MINUTES,
      "Save should only run with a workflow schedule interval inside the supported range"
    );
    assert(argsParseResult.error == null, "Save should only run with valid workflow args JSON");
    assert(draftWorkflowName.length > 0, "Save should only run with a selected workflow");
    assert(
      !draftEnabled || selectedWorkflowExecutable,
      "Enabled schedules must reference an executable workflow"
    );

    const didSave = await saveSchedule({
      enabled: draftEnabled,
      workflowName: draftWorkflowName,
      intervalMs: workflowScheduleIntervalMinutesToMs(parsedMinutes),
      ...(argsParseResult.args ? { args: argsParseResult.args } : {}),
      ...(draftContextMode !== WORKFLOW_SCHEDULE_DEFAULT_CONTEXT_MODE
        ? { contextMode: draftContextMode }
        : {}),
      target: { type: "existing-workspace", workspaceId: props.workspaceId },
    });
    if (didSave) {
      props.onOpenChange(false);
    }
  };

  const handleRemove = async () => {
    setIsSaving(true);
    setSaveError(null);
    if (api == null) {
      setSaveError("Automation settings are unavailable while disconnected.");
      setIsSaving(false);
      return;
    }

    try {
      if (props.projectWorkflowSchedule != null) {
        const result = await api.projects.workflowSchedules.remove({
          projectPath: props.projectPath,
          scheduleId: props.projectWorkflowSchedule.id,
        });
        if (!result.success) {
          throw new Error(result.error ?? "Failed to remove automation.");
        }
      }
      await refreshProjects();
      props.onOpenChange(false);
    } catch (error) {
      setSaveError(getErrorMessage(error) || "Failed to remove automation.");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="max-w-2xl" maxHeight="calc(100dvh - 2rem)">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CalendarClock className="h-5 w-5" />
            Automation for {workspaceLabel}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <p className="text-muted text-sm">
            Configure the project-level automation that runs in this workspace. Each workspace can
            be targeted by only one automation.
          </p>

          <div className="border-border rounded-lg border p-4">
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0 flex-1">
                <div className="text-foreground text-sm font-medium">Enable automation</div>
                <div className="text-muted mt-1 text-xs">
                  Keep this automation eligible for recurring background workflow runs.
                </div>
              </div>
              <Switch
                checked={draftEnabled}
                onCheckedChange={(checked) => {
                  setDraftEnabled(checked);
                }}
                disabled={isSaving}
                aria-label="Enable automation"
              />
            </div>

            <div className="mt-4 space-y-2">
              <label htmlFor="automation-name" className="block">
                <div className="text-foreground text-sm font-medium">Workflow</div>
                <div className="text-muted mt-1 text-xs">
                  Only executable workflows can be enabled for automations.
                </div>
              </label>
              <div className="relative">
                <select
                  id="automation-name"
                  value={draftWorkflowName}
                  onChange={(event: React.ChangeEvent<HTMLSelectElement>) => {
                    setDraftWorkflowName(event.target.value);
                    setWorkflowNameTouched(true);
                  }}
                  disabled={isSaving || definitionsPending}
                  className="border-border-medium bg-background-secondary text-foreground focus:border-accent focus:ring-accent h-9 w-full min-w-0 rounded-md border px-3 text-sm focus:ring-1 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
                  aria-label="Automation workflow"
                >
                  {definitionsPending ? (
                    <option value={draftWorkflowName}>
                      {draftWorkflowName
                        ? `${draftWorkflowName} (loading workflows…)`
                        : "Loading workflows…"}
                    </option>
                  ) : null}
                  {!definitionsPending && selectedWorkflowMissing && (
                    <option value={draftWorkflowName}>{draftWorkflowName} (not found)</option>
                  )}
                  {!definitionsPending && selectedWorkflowNonExecutable && (
                    <option value={draftWorkflowName} disabled>
                      {draftWorkflowName} (
                      {selectedWorkflowDefinition.blockedReason ?? "not executable"})
                    </option>
                  )}
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
              <label htmlFor="automation-context-mode" className="block">
                <div className="text-foreground text-sm font-medium">Context before run</div>
                <div className="text-muted mt-1 text-xs">
                  Applied before the workflow runs in this workspace. Empty contexts are left
                  unchanged.
                </div>
              </label>
              <select
                id="automation-context-mode"
                value={draftContextMode}
                onChange={(event: React.ChangeEvent<HTMLSelectElement>) => {
                  setDraftContextMode(event.target.value as WorkflowScheduleContextMode);
                }}
                disabled={isSaving}
                className="border-border-medium bg-background-secondary text-foreground focus:border-accent focus:ring-accent h-9 w-full min-w-0 rounded-md border px-3 text-sm focus:ring-1 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
                aria-label="Automation context mode"
              >
                <option value="normal">Keep existing context</option>
                <option value="reset">Soft reset context</option>
                <option value="compact">Compact context first</option>
              </select>
            </div>

            <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <label htmlFor="automation-interval" className="min-w-0 flex-1">
                <div className="text-foreground text-sm font-medium">Interval</div>
                <div id={intervalHelpId} className="text-muted mt-1 text-xs">
                  Valid range: {WORKFLOW_SCHEDULE_MIN_INTERVAL_MINUTES}–
                  {WORKFLOW_SCHEDULE_MAX_INTERVAL_MINUTES} minutes. New automations default to{" "}
                  {WORKFLOW_SCHEDULE_DEFAULT_INTERVAL_MINUTES} minutes.
                </div>
              </label>
              <div className="flex items-center gap-2 self-start sm:self-auto">
                <Input
                  id="automation-interval"
                  type="number"
                  inputMode="numeric"
                  min={WORKFLOW_SCHEDULE_MIN_INTERVAL_MINUTES}
                  max={WORKFLOW_SCHEDULE_MAX_INTERVAL_MINUTES}
                  step={1}
                  value={draftIntervalMinutes}
                  onInput={(event: React.FormEvent<HTMLInputElement>) => {
                    setDraftIntervalMinutes(event.currentTarget.value);
                  }}
                  onBlur={handleIntervalBlur}
                  disabled={isSaving}
                  className="border-border-medium bg-background-secondary h-9 w-24 text-right"
                  aria-label="Automation interval in minutes"
                  aria-invalid={intervalValidationError != null}
                  aria-describedby={intervalDescriptionIds}
                />
                <span className="text-muted text-sm">min</span>
              </div>
            </div>

            <div className="mt-4 space-y-2">
              <label htmlFor="automation-args" className="block">
                <div className="text-foreground text-sm font-medium">Args</div>
                <div id={argsHelpId} className="text-muted mt-1 text-xs">
                  Optional JSON object passed to the workflow run.
                </div>
              </label>
              <textarea
                id="automation-args"
                rows={5}
                value={draftArgs}
                onInput={(event: React.FormEvent<HTMLTextAreaElement>) => {
                  setDraftArgs(event.currentTarget.value);
                }}
                disabled={isSaving}
                className="border-border-medium bg-background-secondary text-foreground focus:border-accent focus:ring-accent min-h-[120px] w-full resize-y rounded-md border p-3 text-sm leading-relaxed focus:ring-1 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
                placeholder={'{\n  "label": "needs-triage"\n}'}
                aria-label="Automation args"
                aria-invalid={argsParseResult.error != null}
                aria-describedby={argsDescriptionIds}
              />
            </div>

            {lastRunStartedAt && (
              <p className="text-muted mt-3 text-xs">Last started: {lastRunStartedAt}</p>
            )}
          </div>

          {errorMessages.length > 0 && (
            <div
              className="bg-danger-soft/10 text-danger-soft space-y-1 rounded-md p-3 text-sm"
              role="alert"
              aria-live="assertive"
            >
              {errorMessages.map((message) => (
                <p
                  key={message}
                  id={
                    message === intervalValidationError
                      ? intervalErrorId
                      : message === argsParseResult.error
                        ? argsErrorId
                        : undefined
                  }
                >
                  {message}
                </p>
              ))}
            </div>
          )}

          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              {hasSchedule && (
                <Button
                  variant="ghost"
                  onClick={() => void handleRemove()}
                  disabled={isSaving || api == null}
                >
                  Remove automation
                </Button>
              )}
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => props.onOpenChange(false)} disabled={isSaving}>
                Cancel
              </Button>
              <Button onClick={() => void handleSave()} disabled={hasBlockingError}>
                {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                Save
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
