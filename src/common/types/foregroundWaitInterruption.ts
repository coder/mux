import { z } from "zod";

import { ThinkingLevelSchema } from "@/common/types/thinking";

export const ForegroundWaitProgressReportSchema = z
  .object({
    agentType: z.string().min(1),
    title: z.string().min(1),
    reportMarkdown: z.string().min(1),
    model: z.string().min(1).optional(),
    thinkingLevel: ThinkingLevelSchema.optional(),
    workspaceId: z.string().min(1).optional(),
    turnId: z.string().min(1).optional(),
    structuredOutput: z.unknown().optional(),
  })
  .strict();

/** Why a foreground task wait returned before the task itself reached a terminal state. */
export const ForegroundWaitInterruptionSchema = z.discriminatedUnion("reason", [
  z
    .object({
      reason: z.literal("progress_report_received"),
      sourceTaskId: z.string().min(1),
      // The interrupted tool result carries the child update directly, so the queued synthetic
      // wake can be consumed instead of creating a duplicate parent turn.
      report: ForegroundWaitProgressReportSchema,
    })
    .strict(),
  z
    .object({
      reason: z.literal("message_queued"),
    })
    .strict(),
]);

export type ForegroundWaitInterruption = z.infer<typeof ForegroundWaitInterruptionSchema>;

export const GENERIC_FOREGROUND_WAIT_INTERRUPTION = {
  reason: "message_queued",
} as const satisfies ForegroundWaitInterruption;
