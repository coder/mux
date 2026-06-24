import type {
  WorkflowRunEvent,
  WorkflowRunRecord,
  WorkflowStepStatus,
} from "@/common/types/workflow";
import assert from "@/common/utils/assert";

type WorkflowProgressEvent = Exclude<WorkflowRunEvent, { type: "status" | "result" }>;

function isWorkflowProgressEvent(event: WorkflowRunEvent): event is WorkflowProgressEvent {
  return event.type !== "status" && event.type !== "result";
}

function getWorkflowStepCounts(steps: ReadonlyArray<{ status: WorkflowStepStatus }>) {
  const counts: Record<WorkflowStepStatus, number> = {
    started: 0,
    completed: 0,
    failed: 0,
    interrupted: 0,
  };

  for (const step of steps) {
    counts[step.status] += 1;
  }

  return counts;
}

export function buildWorkflowProgressSummary(run: WorkflowRunRecord) {
  assert(run.workflow.name.length > 0, "buildWorkflowProgressSummary: workflow name is required");

  const progressEvents = run.events.filter(isWorkflowProgressEvent);
  const latestPhase = run.events.findLast((event) => event.type === "phase");
  const latestProgressEvent = progressEvents.at(-1);

  if (latestPhase == null && progressEvents.length === 0 && run.steps.length === 0) {
    return undefined;
  }

  return {
    name: run.workflow.name,
    ...(latestPhase != null
      ? {
          latestPhase: {
            name: latestPhase.name,
            at: latestPhase.at,
          },
        }
      : {}),
    ...(latestProgressEvent != null ? { lastProgressAt: latestProgressEvent.at } : {}),
    stepCounts: getWorkflowStepCounts(run.steps),
  };
}

export function formatWorkflowProgressNote(baseNote: string, run: WorkflowRunRecord): string {
  assert(baseNote.length > 0, "formatWorkflowProgressNote: base note is required");

  const latestPhase = run.events.findLast((event) => event.type === "phase");
  if (latestPhase == null) {
    return baseNote;
  }
  return `${baseNote} Latest phase: ${latestPhase.name}.`;
}
