import { z } from "zod";
import { ToolPolicySchema } from "./stream";

export const HarnessChecklistStatusSchema = z.enum(["todo", "doing", "done", "blocked"]);

export const HarnessChecklistItemSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    status: HarnessChecklistStatusSchema,
    notes: z.string().optional(),
  })
  .strict();

export const HarnessGateSchema = z
  .object({
    id: z.string().min(1).optional(),
    title: z.string().min(1).optional(),
    command: z.string().min(1),
    timeoutSecs: z.number().int().positive().optional(),
  })
  .strict();

export const HarnessContextResetStrategySchema = z.enum(["replace_history", "none"]);

export const HarnessLoopSettingsSchema = z
  .object({
    /** Hard cap on iterations for a single run. */
    maxIterations: z.number().int().positive().optional(),
    /** Hard cap on wall-clock time for a single run. */
    maxWallTimeMins: z.number().int().positive().optional(),
    /** Pause when gates fail this many times in a row. */
    maxConsecutiveFailures: z.number().int().positive().optional(),
    /** How to reset context between iterations. */
    contextReset: HarnessContextResetStrategySchema.optional(),
    /** When true, auto-commit after gates pass. */
    autoCommit: z.boolean().optional(),
    /** Commit message template (supports simple placeholders like {{item}}). */
    commitMessageTemplate: z.string().optional(),
    /** Optional tool policy overrides for loop iterations. */
    toolPolicy: ToolPolicySchema.optional(),
  })
  .strict();

export const WorkspaceHarnessConfigSchema = z
  .object({
    version: z.literal(1),
    checklist: z.array(HarnessChecklistItemSchema),
    gates: z.array(HarnessGateSchema),
    loop: HarnessLoopSettingsSchema.optional(),
  })
  .strict();

export const WorkspaceHarnessFilePathsSchema = z
  .object({
    configPath: z.string(),
    progressPath: z.string(),
  })
  .strict();

export const HarnessGateCommandResultSchema = z
  .object({
    command: z.string(),
    exitCode: z.number(),
    durationMs: z.number(),
    stdout: z.string(),
    stderr: z.string(),
    truncatedStdout: z.boolean().optional(),
    truncatedStderr: z.boolean().optional(),
  })
  .strict();

export const HarnessGateRunResultSchema = z
  .object({
    ok: z.boolean(),
    startedAt: z.number(),
    finishedAt: z.number(),
    totalDurationMs: z.number(),
    results: z.array(HarnessGateCommandResultSchema),
  })
  .strict();

export const GitCheckpointResultSchema = z
  .object({
    committed: z.boolean(),
    dirtyBefore: z.boolean(),
    dirtyAfter: z.boolean(),
    commitSha: z.string().nullable(),
    commitMessage: z.string().nullable(),
    stdout: z.string().optional(),
    stderr: z.string().optional(),
  })
  .strict();

export const HarnessLoopStatusSchema = z.enum(["stopped", "running", "paused"]);

export const HarnessLoopStateSchema = z
  .object({
    status: HarnessLoopStatusSchema,
    startedAt: z.number().nullable(),
    iteration: z.number(),
    consecutiveFailures: z.number(),
    currentItemId: z.string().nullable(),
    currentItemTitle: z.string().nullable(),
    lastGateRun: HarnessGateRunResultSchema.nullable(),
    lastCheckpoint: GitCheckpointResultSchema.nullable(),
    lastError: z.string().nullable(),
    stoppedReason: z.string().nullable(),
  })
  .strict();
