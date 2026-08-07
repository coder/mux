import { z } from "zod";

import {
  BackgroundWorkAttentionPolicySchema,
  DEFAULT_BACKGROUND_WORK_ATTENTION_POLICY,
} from "@/common/types/backgroundWorkAttention";
import { TaskResultArtifactsSchema } from "@/common/types/taskArtifacts";
import { WorkspaceTurnFinalMessageRefSchema } from "@/common/types/workspaceTurn";

export const EXECUTION_HANDLE_VERSION = 1 as const;
export const EXECUTION_ID_PREFIX = "exe_";

const EXECUTION_ID_PATTERN = /^exe_[a-z0-9][a-z0-9_-]*$/;

export function isExecutionId(value: unknown): value is `${typeof EXECUTION_ID_PREFIX}${string}` {
  return typeof value === "string" && EXECUTION_ID_PATTERN.test(value);
}

export const ExecutionStatusSchema = z.enum([
  "queued",
  "starting",
  "running",
  "completed",
  "interrupted",
  "error",
]);
export type ExecutionStatus = z.infer<typeof ExecutionStatusSchema>;

/** Awaiting a final assistant message is progress within running, not a terminal status. */
export const ExecutionPhaseSchema = z.enum(["awaiting_report"]);
export type ExecutionPhase = z.infer<typeof ExecutionPhaseSchema>;

export const ExecutionTargetWorkspaceSchema = z
  .object({
    kind: z.literal("workspace"),
    workspaceId: z.string().min(1),
    origin: z.enum(["created", "existing"]),
  })
  .strict();
export type ExecutionTarget = z.infer<typeof ExecutionTargetWorkspaceSchema>;

export const ExecutionLaunchPolicySchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("agent_task"),
      agentId: z.string().min(1).optional(),
      title: z.string().optional(),
      prompt: z.string().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("workspace_turn"),
      turnId: z.string().min(1),
      title: z.string().optional(),
      prompt: z.string().optional(),
    })
    .strict(),
]);
export type ExecutionLaunchPolicy = z.infer<typeof ExecutionLaunchPolicySchema>;

/** Phase 1 executions complete only when their workspace produces its final assistant message. */
export const ExecutionCompletionPolicySchema = z
  .object({ kind: z.literal("final_assistant_message") })
  .strict();
export type ExecutionCompletionPolicy = z.infer<typeof ExecutionCompletionPolicySchema>;

export const ExecutionRetentionPolicySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("retain_workspace") }).strict(),
  z.object({ kind: z.literal("delete_workspace_on_completion") }).strict(),
]);
export type ExecutionRetentionPolicy = z.infer<typeof ExecutionRetentionPolicySchema>;

const CompletedExecutionResultSchema = z
  .object({
    kind: z.literal("completed"),
    reportMarkdown: z.string(),
    structuredOutput: z.unknown().optional(),
    finalMessageRef: WorkspaceTurnFinalMessageRefSchema.optional(),
    artifacts: TaskResultArtifactsSchema.optional(),
  })
  .strict();

const InterruptedExecutionResultSchema = z
  .object({
    kind: z.literal("interrupted"),
    message: z.string().optional(),
  })
  .strict();

const ErrorExecutionResultSchema = z
  .object({
    kind: z.literal("error"),
    error: z.string().min(1),
    errorType: z.string().min(1).optional(),
  })
  .strict();

export const ExecutionResultSchema = z.discriminatedUnion("kind", [
  CompletedExecutionResultSchema,
  InterruptedExecutionResultSchema,
  ErrorExecutionResultSchema,
]);
export type ExecutionResult = z.infer<typeof ExecutionResultSchema>;

export const ExecutionHandleV1Schema = z
  .object({
    version: z.literal(EXECUTION_HANDLE_VERSION),
    executionId: z.string().refine(isExecutionId, "Invalid execution ID"),
    aliases: z.array(z.string().min(1)).optional(),
    parentExecutionId: z.string().refine(isExecutionId, "Invalid parent execution ID").optional(),
    ownerSessionId: z.string().min(1),
    requesterWorkspaceId: z.string().min(1),
    target: ExecutionTargetWorkspaceSchema,
    launchPolicy: ExecutionLaunchPolicySchema,
    completionPolicy: ExecutionCompletionPolicySchema,
    retentionPolicy: ExecutionRetentionPolicySchema,
    attentionPolicy: BackgroundWorkAttentionPolicySchema.default(
      DEFAULT_BACKGROUND_WORK_ATTENTION_POLICY
    ),
    status: ExecutionStatusSchema,
    phase: ExecutionPhaseSchema.optional(),
    result: ExecutionResultSchema.optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    startedAt: z.string().datetime().optional(),
    terminalAt: z.string().datetime().optional(),
    terminalAttentionNotifiedAt: z.string().datetime().optional(),
  })
  .strict()
  .superRefine((handle, ctx) => {
    const terminalResultKind =
      handle.status === "completed"
        ? "completed"
        : handle.status === "interrupted"
          ? "interrupted"
          : handle.status === "error"
            ? "error"
            : null;
    if (terminalResultKind != null && handle.result?.kind !== terminalResultKind) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Terminal status ${handle.status} requires a matching result`,
        path: ["result"],
      });
    }
    if (terminalResultKind == null && handle.result != null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Active executions cannot have a terminal result",
        path: ["result"],
      });
    }
  });

export type ExecutionHandleV1 = z.infer<typeof ExecutionHandleV1Schema>;
export type ExecutionHandle = ExecutionHandleV1;
export const ExecutionHandleSchema = ExecutionHandleV1Schema;
