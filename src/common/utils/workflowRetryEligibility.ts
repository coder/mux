import type { WorkflowRunEvent, WorkflowRunRecord } from "@/common/types/workflow";

export const WORKFLOW_CHECKPOINT_RETRY_ERROR_MESSAGE = "Execution interrupted";

export interface WorkflowCheckpointRetryEligibility {
  canRetry: boolean;
  reason: string | null;
}

type WorkflowPatchEvent = Extract<WorkflowRunEvent, { type: "patch" }>;

export function getWorkflowCheckpointRetryEligibility(
  run: WorkflowRunRecord | null | undefined
): WorkflowCheckpointRetryEligibility {
  if (run == null) {
    return { canRetry: false, reason: "Workflow run is not available" };
  }
  if (run.status !== "failed") {
    return { canRetry: false, reason: `Workflow run is not failed: ${run.id}` };
  }
  const latestError = run.events.findLast((event) => event.type === "error");
  if (latestError?.message !== WORKFLOW_CHECKPOINT_RETRY_ERROR_MESSAGE) {
    return { canRetry: false, reason: "Workflow run cannot be retried from checkpoint" };
  }
  const unsafePatchReason = getUnsafePatchRetryReason(run);
  if (unsafePatchReason != null) {
    return { canRetry: false, reason: unsafePatchReason };
  }
  return { canRetry: true, reason: null };
}

export function canRetryWorkflowFromCheckpoint(run: WorkflowRunRecord | null | undefined): boolean {
  return getWorkflowCheckpointRetryEligibility(run).canRetry;
}

function getUnsafePatchRetryReason(run: WorkflowRunRecord): string | null {
  const latestPatchEventsByStep = new Map<string, WorkflowPatchEvent>();
  for (const event of run.events) {
    if (event.type === "patch") {
      latestPatchEventsByStep.set(getPatchEventKey(event), event);
    }
  }

  for (const event of latestPatchEventsByStep.values()) {
    if (event.status === "started" || event.status === "failed") {
      return "Workflow run cannot be retried from checkpoint with unfinished patch steps";
    }
    if (!hasCompletedPatchStep(run, event)) {
      return "Workflow run cannot be retried from checkpoint with incomplete patch step records";
    }
  }
  return null;
}

function hasCompletedPatchStep(run: WorkflowRunRecord, event: WorkflowPatchEvent): boolean {
  return run.steps.some(
    (step) =>
      step.stepId === event.stepId &&
      step.taskId === event.sourceTaskId &&
      step.status === "completed" &&
      step.result?.structuredOutput != null
  );
}

function getPatchEventKey(event: WorkflowPatchEvent): string {
  return `${event.stepId}\0${event.sourceTaskId}`;
}
