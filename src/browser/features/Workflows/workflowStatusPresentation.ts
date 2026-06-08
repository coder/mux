import type {
  WorkflowDefinitionDescriptor,
  WorkflowDefinitionScope,
  WorkflowRunEvent,
  WorkflowRunRecord,
  WorkflowRunStatus,
} from "@/common/types/workflow";
import assert from "@/common/utils/assert";

export type WorkflowStatusSeverity =
  | "error"
  | "warning"
  | "active"
  | "active-background"
  | "pending"
  | "terminal"
  | "unknown";

export interface WorkflowStatusPresentation {
  label: string;
  severity: WorkflowStatusSeverity;
  isActive: boolean;
  needsAttention: boolean;
}

export interface WorkflowRunsSummary {
  activeCount: number;
  problemCount: number;
  highestSeverity: WorkflowStatusSeverity | null;
}

const WORKFLOW_STATUS_PRESENTATION: Record<WorkflowRunStatus, WorkflowStatusPresentation> = {
  failed: { label: "Failed", severity: "error", isActive: false, needsAttention: true },
  interrupted: {
    label: "Interrupted",
    severity: "warning",
    isActive: false,
    needsAttention: true,
  },
  running: { label: "Running", severity: "active", isActive: true, needsAttention: false },
  backgrounded: {
    label: "Backgrounded",
    severity: "active-background",
    isActive: true,
    needsAttention: false,
  },
  pending: { label: "Pending", severity: "pending", isActive: true, needsAttention: false },
  completed: { label: "Completed", severity: "terminal", isActive: false, needsAttention: false },
};

const KNOWN_WORKFLOW_STATUSES = new Set<WorkflowRunStatus>(
  Object.keys(WORKFLOW_STATUS_PRESENTATION) as WorkflowRunStatus[]
);

const SEVERITY_RANK: Record<WorkflowStatusSeverity, number> = {
  error: 6,
  warning: 5,
  active: 4,
  "active-background": 3,
  pending: 2,
  terminal: 1,
  unknown: 0,
};

export function getWorkflowStatusPresentation(status: string): WorkflowStatusPresentation {
  if (KNOWN_WORKFLOW_STATUSES.has(status as WorkflowRunStatus)) {
    return WORKFLOW_STATUS_PRESENTATION[status as WorkflowRunStatus];
  }

  // Persisted runs may have been written by a newer or older build. Keep the UI usable,
  // while assertions/tests make newly-added statuses impossible to forget during development.
  return {
    label: status || "Unknown",
    severity: "unknown",
    isActive: false,
    needsAttention: false,
  };
}

export function summarizeWorkflowRuns(runs: readonly WorkflowRunRecord[]): WorkflowRunsSummary {
  let activeCount = 0;
  let problemCount = 0;
  let highestSeverity: WorkflowStatusSeverity | null = null;

  for (const run of runs) {
    assert(run.id.length > 0, "Workflow run summaries require persisted run ids");
    const presentation = getWorkflowStatusPresentation(run.status);
    if (presentation.isActive) activeCount++;
    if (presentation.needsAttention) problemCount++;
    if (
      highestSeverity == null ||
      SEVERITY_RANK[presentation.severity] > SEVERITY_RANK[highestSeverity]
    ) {
      highestSeverity = presentation.severity;
    }
  }

  return { activeCount, problemCount, highestSeverity };
}

export function compareWorkflowRunsForAttention(
  a: WorkflowRunRecord,
  b: WorkflowRunRecord
): number {
  const aSeverity = getWorkflowStatusPresentation(a.status).severity;
  const bSeverity = getWorkflowStatusPresentation(b.status).severity;
  const severityDelta = SEVERITY_RANK[bSeverity] - SEVERITY_RANK[aSeverity];
  if (severityDelta !== 0) return severityDelta;
  return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
}

export function getLatestWorkflowRunSummary(run: WorkflowRunRecord): string {
  for (let index = run.events.length - 1; index >= 0; index--) {
    const event = run.events[index];
    const summary = summarizeEvent(event);
    if (summary != null) return summary;
  }
  return getWorkflowStatusPresentation(run.status).label;
}

function summarizeEvent(event: WorkflowRunEvent): string | null {
  switch (event.type) {
    case "status":
    case "result":
      return null;
    case "phase":
      return event.name;
    case "log":
    case "error":
      return event.message;
    case "task":
      return `Task ${event.status}`;
    case "patch":
      return `Patch ${event.status}`;
    case "action":
      return `${event.name} ${event.status}`;
    case "validation":
      return event.message ?? (event.success ? "Validation passed" : "Validation failed");
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}

export function groupWorkflowDefinitionsByScope(
  definitions: readonly WorkflowDefinitionDescriptor[]
): Record<WorkflowDefinitionScope, WorkflowDefinitionDescriptor[]> {
  return {
    project: definitions.filter((definition) => definition.scope === "project"),
    global: definitions.filter((definition) => definition.scope === "global"),
    "built-in": definitions.filter((definition) => definition.scope === "built-in"),
    scratch: definitions.filter((definition) => definition.scope === "scratch"),
  };
}
