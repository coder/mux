import type { z } from "zod";
import type {
  WorkflowActionEffectSchema,
  WorkflowActionMetadataSchema,
  StructuredTaskOutputSchema,
  WorkflowDefinitionDescriptorSchema,
  WorkflowDefinitionScopeSchema,
  WorkflowNameSchema,
  WorkflowResultSchema,
  WorkflowRunEventSchema,
  WorkflowRunIdSchema,
  WorkflowRunRecordSchema,
  WorkflowRunStatusSchema,
  WorkflowStepRecordSchema,
  WorkflowStepStatusSchema,
} from "@/common/orpc/schemas";
import { WorkflowRunStatusTransitionSchema } from "@/common/orpc/schemas";
import assert from "@/common/utils/assert";

export type WorkflowActionEffect = z.infer<typeof WorkflowActionEffectSchema>;
export type WorkflowActionMetadata = z.infer<typeof WorkflowActionMetadataSchema>;
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
export type WorkflowRunRecord = z.infer<typeof WorkflowRunRecordSchema>;

export function assertWorkflowRunStatusTransition(
  from: WorkflowRunStatus,
  to: WorkflowRunStatus
): void {
  assert(
    WorkflowRunStatusTransitionSchema.safeParse({ from, to }).success,
    `Invalid workflow run status transition: ${from} -> ${to}`
  );
}
