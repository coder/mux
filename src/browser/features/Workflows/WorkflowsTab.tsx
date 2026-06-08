import React, { useContext, useState } from "react";
import { Play, RefreshCw } from "lucide-react";

import { APIContext } from "@/browser/contexts/API";
import { Button } from "@/browser/components/Button/Button";
import { cn } from "@/common/lib/utils";
import type {
  WorkflowDefinitionDescriptor,
  WorkflowDefinitionScope,
  WorkflowRunRecord,
} from "@/common/types/workflow";

import {
  getWorkflowStoreInstance,
  type WorkflowWorkspaceSnapshot,
  useWorkflowWorkspaceSnapshot,
} from "./WorkflowStore";
import {
  getLatestWorkflowRunSummary,
  getWorkflowStatusPresentation,
  type WorkflowStatusSeverity,
} from "./workflowStatusPresentation";

interface WorkflowsTabProps {
  workspaceId: string;
}

interface RunWorkflowOptions {
  runInBackground: boolean;
}

type WorkflowRunAction = "interrupt" | "resume" | "retryFromCheckpoint";

interface WorkflowsTabViewProps {
  snapshot: WorkflowWorkspaceSnapshot;
  onRunDefinition?: (
    definition: WorkflowDefinitionDescriptor,
    options?: RunWorkflowOptions
  ) => Promise<void> | void;
  onRunAction?: (run: WorkflowRunRecord, action: WorkflowRunAction) => Promise<void> | void;
  onPromoteScratchDefinition?: (
    definition: WorkflowDefinitionDescriptor,
    location: "project" | "global"
  ) => Promise<void> | void;
  onRefresh?: () => void;
}

const SCOPE_LABELS: Record<WorkflowDefinitionScope, string> = {
  project: "Project",
  global: "Global",
  "built-in": "Built-in",
  scratch: "Scratch",
};

const SCOPE_ORDER: WorkflowDefinitionScope[] = ["project", "global", "built-in", "scratch"];

const SEVERITY_CLASS: Record<WorkflowStatusSeverity, string> = {
  error: "text-error border-error/40 bg-error/10",
  warning: "text-warning border-warning/40 bg-warning/10",
  active: "text-success border-success/40 bg-success/10",
  "active-background": "text-muted border-border bg-secondary",
  pending: "text-muted border-border bg-secondary",
  terminal: "text-muted border-border bg-secondary",
  unknown: "text-muted border-border bg-secondary",
};

export function WorkflowsTab(props: WorkflowsTabProps) {
  const apiState = useContext(APIContext);
  const snapshot = useWorkflowWorkspaceSnapshot(props.workspaceId);
  const [actionError, setActionError] = useState<string | null>(null);

  const handleRunDefinition = async (
    definition: WorkflowDefinitionDescriptor,
    options?: RunWorkflowOptions
  ) => {
    if (!apiState?.api) return;
    setActionError(null);
    try {
      await apiState.api.workflows.start({
        workspaceId: props.workspaceId,
        name: definition.name,
        runInBackground: options?.runInBackground === true,
      });
      getWorkflowStoreInstance().invalidateWorkspace(props.workspaceId);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Failed to start workflow");
    }
  };

  const handleRunAction = async (run: WorkflowRunRecord, action: WorkflowRunAction) => {
    if (!apiState?.api) return;
    setActionError(null);
    try {
      if (action === "interrupt") {
        await apiState.api.workflows.interrupt({ workspaceId: props.workspaceId, runId: run.id });
      } else if (action === "resume") {
        await apiState.api.workflows.resume({ workspaceId: props.workspaceId, runId: run.id });
      } else {
        await apiState.api.workflows.retryFromCheckpoint({
          workspaceId: props.workspaceId,
          runId: run.id,
        });
      }
      getWorkflowStoreInstance().invalidateWorkspace(props.workspaceId);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Failed to update workflow");
    }
  };

  const handlePromoteScratchDefinition = async (
    definition: WorkflowDefinitionDescriptor,
    location: "project" | "global"
  ) => {
    if (!apiState?.api) return;
    setActionError(null);
    try {
      await apiState.api.workflows.promoteScratchDefinition({
        workspaceId: props.workspaceId,
        name: definition.name,
        description: definition.description,
        location,
        overwrite: false,
      });
      getWorkflowStoreInstance().invalidateWorkspace(props.workspaceId);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Failed to save workflow");
    }
  };

  return (
    <div className="h-full overflow-y-auto p-3">
      <WorkflowsTabView
        snapshot={actionError == null ? snapshot : { ...snapshot, error: actionError }}
        onRunDefinition={apiState?.api ? handleRunDefinition : undefined}
        onRunAction={apiState?.api ? handleRunAction : undefined}
        onPromoteScratchDefinition={apiState?.api ? handlePromoteScratchDefinition : undefined}
      />
    </div>
  );
}

export function WorkflowsTabView(props: WorkflowsTabViewProps) {
  const { snapshot } = props;
  return (
    <div className="flex flex-col gap-3 text-sm">
      <section className="border-border bg-background rounded-lg border p-3">
        <div className="flex items-start justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold">Workflows</h2>
            <p className="text-muted text-xs">
              {snapshot.summary.activeCount} active · {snapshot.summary.problemCount} needing
              attention
            </p>
          </div>
          {props.onRefresh && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={props.onRefresh}
              aria-label="Refresh workflows"
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
        {snapshot.error && <p className="text-error mt-2 text-xs">{snapshot.error}</p>}
      </section>

      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <h3 className="text-muted text-xs font-semibold tracking-wide uppercase">Current runs</h3>
          {snapshot.currentRuns.length > 0 && (
            <span className="text-muted text-xs">
              {snapshot.currentRuns.length} current
              {snapshot.summary.problemCount > 0
                ? ` · ${snapshot.summary.problemCount} needs attention`
                : ""}
            </span>
          )}
        </div>
        {snapshot.currentRuns.length === 0 ? (
          <EmptyState>No active workflows</EmptyState>
        ) : (
          snapshot.currentRuns.map((run) => (
            <WorkflowRunCard key={run.id} run={run} onAction={props.onRunAction} />
          ))
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="text-muted text-xs font-semibold tracking-wide uppercase">
          Available definitions
        </h3>
        {snapshot.definitions.length === 0 ? (
          <EmptyState>No workflow definitions found</EmptyState>
        ) : (
          SCOPE_ORDER.map((scope) => {
            const definitions = snapshot.definitionGroups[scope];
            if (definitions.length === 0) return null;
            return (
              <details
                key={scope}
                open
                className="border-border bg-background rounded-lg border p-2"
              >
                <summary className="text-muted cursor-pointer text-xs font-semibold">
                  {SCOPE_LABELS[scope]}
                </summary>
                <div className="mt-2 flex flex-col gap-2">
                  {definitions.map((definition) => (
                    <WorkflowDefinitionRow
                      key={`${definition.scope}:${definition.name}`}
                      definition={definition}
                      onRun={props.onRunDefinition}
                      onPromoteScratchDefinition={props.onPromoteScratchDefinition}
                    />
                  ))}
                </div>
              </details>
            );
          })
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="text-muted text-xs font-semibold tracking-wide uppercase">Recent history</h3>
        {snapshot.historyRuns.length === 0 ? (
          <EmptyState>No workflow history yet</EmptyState>
        ) : (
          <details className="border-border bg-background rounded-lg border p-2">
            <summary className="text-muted cursor-pointer text-xs">
              {snapshot.historyRuns.length} completed or inactive run
              {snapshot.historyRuns.length === 1 ? "" : "s"}
            </summary>
            <div className="mt-2 flex flex-col gap-2">
              {snapshot.historyRuns.slice(0, 10).map((run) => (
                <WorkflowRunCard key={run.id} run={run} compact />
              ))}
            </div>
          </details>
        )}
      </section>
    </div>
  );
}

function WorkflowRunCard(props: {
  run: WorkflowRunRecord;
  compact?: boolean;
  onAction?: (run: WorkflowRunRecord, action: WorkflowRunAction) => Promise<void> | void;
}) {
  const presentation = getWorkflowStatusPresentation(props.run.status);
  const action = getWorkflowRunAction(props.run.status);
  return (
    <article
      className="border-border bg-background rounded-lg border p-2"
      aria-label={props.run.id}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{props.run.definition.name}</div>
          {!props.compact && (
            <div className="text-muted truncate text-xs">
              {getLatestWorkflowRunSummary(props.run)}
            </div>
          )}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <StatusBadge label={presentation.label} severity={presentation.severity} />
          {!props.compact && props.onAction && action && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              aria-label={`${action.label} ${props.run.definition.name}`}
              onClick={() => {
                void props.onAction?.(props.run, action.action);
              }}
            >
              {action.label}
            </Button>
          )}
        </div>
      </div>
      <div className="text-muted counter-nums-mono mt-1 text-[11px]">{props.run.id}</div>
    </article>
  );
}

function WorkflowDefinitionRow(props: {
  definition: WorkflowDefinitionDescriptor;
  onRun?: (
    definition: WorkflowDefinitionDescriptor,
    options?: RunWorkflowOptions
  ) => Promise<void> | void;
  onPromoteScratchDefinition?: (
    definition: WorkflowDefinitionDescriptor,
    location: "project" | "global"
  ) => Promise<void> | void;
}) {
  return (
    <article className="border-border bg-secondary/40 rounded-md border p-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{props.definition.name}</div>
          <p className="text-muted line-clamp-2 text-xs">{props.definition.description}</p>
          {props.definition.sourcePath && (
            <p className="text-muted mt-1 truncate text-[11px]">{props.definition.sourcePath}</p>
          )}
          {!props.definition.executable && props.definition.blockedReason && (
            <p className="text-warning mt-1 text-xs">{props.definition.blockedReason}</p>
          )}
        </div>
        {props.definition.executable && (
          <div className="flex shrink-0 flex-col gap-1">
            {props.onRun && (
              <>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  aria-label={`Run ${props.definition.name}`}
                  onClick={() => {
                    void props.onRun?.(props.definition, { runInBackground: false });
                  }}
                >
                  <Play className="h-3 w-3" />
                  Run
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  aria-label={`Run ${props.definition.name} in background`}
                  onClick={() => {
                    void props.onRun?.(props.definition, { runInBackground: true });
                  }}
                >
                  Run background
                </Button>
              </>
            )}
            {props.definition.scope === "scratch" && props.onPromoteScratchDefinition && (
              <>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  aria-label={`Save ${props.definition.name} to project workflows`}
                  onClick={() => {
                    void props.onPromoteScratchDefinition?.(props.definition, "project");
                  }}
                >
                  Save project
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  aria-label={`Save ${props.definition.name} to global workflows`}
                  onClick={() => {
                    void props.onPromoteScratchDefinition?.(props.definition, "global");
                  }}
                >
                  Save global
                </Button>
              </>
            )}
          </div>
        )}
      </div>
    </article>
  );
}

function getWorkflowRunAction(
  status: WorkflowRunRecord["status"]
): { action: WorkflowRunAction; label: string } | null {
  if (status === "pending" || status === "running" || status === "backgrounded") {
    return { action: "interrupt", label: "Interrupt" };
  }
  if (status === "interrupted") {
    return { action: "resume", label: "Resume" };
  }
  if (status === "failed") {
    return { action: "retryFromCheckpoint", label: "Retry" };
  }
  return null;
}

function StatusBadge(props: { label: string; severity: WorkflowStatusSeverity }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium",
        SEVERITY_CLASS[props.severity]
      )}
    >
      {props.label}
    </span>
  );
}

function EmptyState(props: { children: React.ReactNode }) {
  return (
    <div className="border-border text-muted rounded-lg border border-dashed p-3 text-xs">
      {props.children}
    </div>
  );
}
