import { z } from "zod";
import { MAX_WORKSPACE_TURN_ATTACH_FILE_ARTIFACTS } from "@/common/constants/taskArtifacts";

export const TaskAttachFileArtifactSchema = z
  .object({
    path: z.string().min(1).max(4096),
    filename: z.string().min(1).max(255).optional(),
    mediaType: z.string().min(1).max(255),
    displayOnly: z.literal(true).optional(),
    sourceToolCallId: z.string().min(1).max(512).optional(),
  })
  .strict();

export type TaskAttachFileArtifact = z.infer<typeof TaskAttachFileArtifactSchema>;

export const TaskAttachFileArtifactsSchema = z
  .array(TaskAttachFileArtifactSchema)
  .max(MAX_WORKSPACE_TURN_ATTACH_FILE_ARTIFACTS);

export const SubagentGitPatchArtifactStatusSchema = z.enum([
  "pending",
  "ready",
  "failed",
  "skipped",
]);

export const SubagentGitProjectPatchArtifactSchema = z
  .object({
    projectPath: z.string(),
    projectName: z.string(),
    storageKey: z.string(),
    status: SubagentGitPatchArtifactStatusSchema,
    baseCommitSha: z.string().optional(),
    headCommitSha: z.string().optional(),
    commitCount: z.number().int().nonnegative().optional(),
    mboxPath: z.string().optional(),
    error: z.string().optional(),
    appliedAtMs: z.number().int().nonnegative().optional(),
  })
  .strict();

export const SubagentGitPatchArtifactSchema = z
  .object({
    childTaskId: z.string(),
    parentWorkspaceId: z.string(),
    createdAtMs: z.number().int().nonnegative(),
    updatedAtMs: z.number().int().nonnegative().optional(),
    status: SubagentGitPatchArtifactStatusSchema,
    projectArtifacts: z.array(SubagentGitProjectPatchArtifactSchema),
    readyProjectCount: z.number().int().nonnegative(),
    failedProjectCount: z.number().int().nonnegative(),
    skippedProjectCount: z.number().int().nonnegative(),
    totalCommitCount: z.number().int().nonnegative(),
  })
  .strict();

export type SubagentGitProjectPatchArtifact = z.infer<typeof SubagentGitProjectPatchArtifactSchema>;
export type SubagentGitPatchArtifact = z.infer<typeof SubagentGitPatchArtifactSchema>;

/** Durable artifacts returned by task_await for a completed execution. */
export const TaskResultArtifactsSchema = z
  .object({
    gitFormatPatch: SubagentGitPatchArtifactSchema.optional(),
    attachFiles: TaskAttachFileArtifactsSchema.optional(),
  })
  .strict();

export type TaskResultArtifacts = z.infer<typeof TaskResultArtifactsSchema>;
