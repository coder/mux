import type { z } from "zod";
import type {
  WorkflowActionDescriptorSchema,
  WorkflowActionEffectSchema,
  WorkflowActionMetadataSchema,
  WorkflowActionScopeSchema,
  StructuredTaskOutputSchema,
  WorkflowDefinitionArgSummarySchema,
  WorkflowDefinitionDescriptorSchema,
  WorkflowDefinitionMetadataSchema,
  WorkflowDefinitionScopeSchema,
  WorkflowNameSchema,
  WorkflowResultSchema,
  WorkflowRunEventSchema,
  WorkflowRunIdSchema,
  WorkflowRunParentSchema,
  WorkflowRunRecordSchema,
  WorkflowRunStatusSchema,
  WorkflowStepRecordSchema,
  WorkflowStepStatusSchema,
} from "@/common/orpc/schemas";
import { WorkflowRunStatusTransitionSchema } from "@/common/orpc/schemas";
import assert from "@/common/utils/assert";

export type WorkflowActionDescriptor = z.infer<typeof WorkflowActionDescriptorSchema>;
export type WorkflowActionEffect = z.infer<typeof WorkflowActionEffectSchema>;
export type WorkflowActionMetadata = z.infer<typeof WorkflowActionMetadataSchema>;
export type WorkflowActionScope = z.infer<typeof WorkflowActionScopeSchema>;
export type WorkflowDefinitionArgSummary = z.infer<typeof WorkflowDefinitionArgSummarySchema>;
export type WorkflowDefinitionMetadata = z.infer<typeof WorkflowDefinitionMetadataSchema>;
export type WorkflowName = z.infer<typeof WorkflowNameSchema>;
export type WorkflowDefinitionScope = z.infer<typeof WorkflowDefinitionScopeSchema>;
export type WorkflowRunId = z.infer<typeof WorkflowRunIdSchema>;
export type WorkflowRunStatus = z.infer<typeof WorkflowRunStatusSchema>;
export type WorkflowStepStatus = z.infer<typeof WorkflowStepStatusSchema>;
export type WorkflowDefinitionDescriptor = z.infer<typeof WorkflowDefinitionDescriptorSchema>;
export type WorkflowResult = z.infer<typeof WorkflowResultSchema>;
export type StructuredTaskOutput = z.infer<typeof StructuredTaskOutputSchema>;
export type WorkflowRunEvent = z.infer<typeof WorkflowRunEventSchema>;
export type WorkflowStepRecord = z.infer<typeof WorkflowStepRecordSchema>;
export type WorkflowRunParent = z.infer<typeof WorkflowRunParentSchema>;
export type WorkflowRunRecord = z.infer<typeof WorkflowRunRecordSchema>;

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
