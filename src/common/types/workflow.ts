import type { z } from "zod";
import type {
  AvailableWorkflowSchema,
  StructuredTaskOutputSchema,
  WorkflowArgSummarySchema,
  WorkflowScriptDescriptorSchema,
  WorkflowMetadataSchema,
  WorkflowScriptScopeSchema,
  WorkflowNameSchema,
  WorkflowResultSchema,
  WorkflowRunEventSchema,
  WorkflowRunIdSchema,
  WorkflowRunParentSchema,
  WorkflowRunRecordSchema,
  WorkflowRunStatusSchema,
  WorkflowRunStreamEventSchema,
  WorkflowStepRecordSchema,
  WorkflowStepStatusSchema,
} from "@/common/orpc/schemas";
import { WorkflowRunStatusTransitionSchema } from "@/common/orpc/schemas";
import assert from "@/common/utils/assert";

export type WorkflowArgSummary = z.infer<typeof WorkflowArgSummarySchema>;
export type WorkflowMetadata = z.infer<typeof WorkflowMetadataSchema>;
export type WorkflowName = z.infer<typeof WorkflowNameSchema>;
export type WorkflowScriptScope = z.infer<typeof WorkflowScriptScopeSchema>;
export type WorkflowRunId = z.infer<typeof WorkflowRunIdSchema>;
export type WorkflowRunStatus = z.infer<typeof WorkflowRunStatusSchema>;
export type WorkflowStepStatus = z.infer<typeof WorkflowStepStatusSchema>;
export type WorkflowScriptDescriptor = z.infer<typeof WorkflowScriptDescriptorSchema>;
export type WorkflowResult = z.infer<typeof WorkflowResultSchema>;
export type StructuredTaskOutput = z.infer<typeof StructuredTaskOutputSchema>;
export type WorkflowRunEvent = z.infer<typeof WorkflowRunEventSchema>;
export type WorkflowStepRecord = z.infer<typeof WorkflowStepRecordSchema>;
export type WorkflowRunParent = z.infer<typeof WorkflowRunParentSchema>;
export type WorkflowRunRecord = z.infer<typeof WorkflowRunRecordSchema>;
export type WorkflowRunStreamEvent = z.infer<typeof WorkflowRunStreamEventSchema>;
export type AvailableWorkflow = z.infer<typeof AvailableWorkflowSchema>;

const ACTIVE_WORKFLOW_RUN_STATUSES = new Set<WorkflowRunStatus>([
  "pending",
  "running",
  "backgrounded",
]);

export function isActiveWorkflowRunStatus(status: WorkflowRunStatus): boolean {
  return ACTIVE_WORKFLOW_RUN_STATUSES.has(status);
}

export function isTerminalWorkflowRunStatus(status: WorkflowRunStatus): boolean {
  return status === "completed" || status === "failed" || status === "interrupted";
}

export function isNestedWorkflowRun(run: { parentWorkflow?: WorkflowRunParent | null }): boolean {
  return run.parentWorkflow != null;
}

export function assertWorkflowRunStatusTransition(
  from: WorkflowRunStatus,
  to: WorkflowRunStatus
): void {
  assert(
    WorkflowRunStatusTransitionSchema.safeParse({ from, to }).success,
    `Invalid workflow run status transition: ${from} -> ${to}`
  );
}
