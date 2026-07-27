import { z } from "zod";

export const TIMELINE_EVENT_KINDS = [
  "turn.user",
  "turn.synthetic",
  "turn.completed",
  "turn.interrupted",
  "turn.failed",
  "retry.scheduled",
  "retry.abandoned",
  "tool.call",
  "compaction.triggered",
  "compaction.completed",
  "context.reset",
  "history.cleared",
  "task.created",
  "task.reported",
  "task.interrupted",
  "workflow.attached",
  "heartbeat.dispatched",
  "heartbeat.skipped",
  "goal.set",
  "goal.completed",
  "goal.budget_limited",
  "goal.continuation_dispatched",
  "settings.changed",
  "agent.mark",
  "agent.status",
  "agent.plan_proposed",
  "agent.todo_completed",
  "agent.notified",
] as const;

export const TimelineEventKindSchema = z.enum(TIMELINE_EVENT_KINDS);
export type TimelineEventKind = z.infer<typeof TimelineEventKindSchema>;

export const TimelineSourceSchema = z
  .object({
    system: z.enum(["chat", "heartbeat", "goal", "task", "settings", "agent"]),
    key: z.string().min(1).optional(),
  })
  .strict();

export const TimelineAnchorSchema = z
  .object({
    historySequence: z.number().int().positive().optional(),
    messageId: z.string().min(1).optional(),
    toolCallId: z.string().min(1).optional(),
    taskId: z.string().min(1).optional(),
    childWorkspaceId: z.string().min(1).optional(),
  })
  .strict();

export const TimelineStatusSchema = z.enum([
  "started",
  "completed",
  "failed",
  "interrupted",
  "skipped",
]);

const TimelineSettingValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const TimelineEventDataSchema = z
  .object({
    toolName: z.string().optional(),
    model: z.string().optional(),
    mode: z.string().optional(),
    agentId: z.string().optional(),
    reason: z.string().optional(),
    errorKind: z.string().optional(),
    durationMs: z.number().nonnegative().optional(),
    title: z.string().optional(),
    digest: z.string().optional(),
    label: z.string().optional(),
    detail: z.string().optional(),
    category: z.enum(["picked_up", "milestone", "decision", "blocker", "handoff"]).optional(),
    usagePercent: z.number().optional(),
    newUsagePercent: z.number().optional(),
    attempt: z.number().int().positive().optional(),
    delayMs: z.number().nonnegative().optional(),
    scheduledAt: z.number().optional(),
    runId: z.string().optional(),
    goalId: z.string().optional(),
    statusMessage: z.string().optional(),
    emoji: z.string().optional(),
    setting: z.string().optional(),
    previousValue: TimelineSettingValueSchema.optional(),
    nextValue: TimelineSettingValueSchema.optional(),
  })
  .strict();

export const TimelineEventSchema = z
  .object({
    v: z.literal(1),
    seq: z.number().int().positive(),
    id: z.string().min(1),
    ts: z.number().nonnegative(),
    kind: z.string().min(1),
    source: TimelineSourceSchema,
    anchor: TimelineAnchorSchema.optional(),
    epoch: z.number().int().positive().optional(),
    status: TimelineStatusSchema.optional(),
    data: TimelineEventDataSchema.optional(),
  })
  .strict();

export const TimelineEventDraftSchema = TimelineEventSchema.omit({
  v: true,
  seq: true,
  id: true,
}).extend({
  ts: z.number().nonnegative().optional(),
});

export const TimelineListInputSchema = z
  .object({
    cursor: z.number().int().positive().optional(),
    limit: z.number().int().positive().max(200).optional(),
  })
  .strict();

export const TimelinePageSchema = z
  .object({
    events: z.array(TimelineEventSchema),
    nextCursor: z.number().int().positive().nullable(),
    hasOlder: z.boolean(),
  })
  .strict();

export const TimelineSubscriptionEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("snapshot"), events: z.array(TimelineEventSchema) }).strict(),
  z.object({ type: z.literal("appended"), events: z.array(TimelineEventSchema) }).strict(),
]);

export const TimelinePreviewInputSchema = TimelineAnchorSchema;

export const TimelinePreviewSchema = z
  .object({
    role: z.enum(["system", "user", "assistant"]),
    timestamp: z.number().optional(),
    textExcerpt: z.string().max(600),
    toolName: z.string().optional(),
    status: TimelineStatusSchema.optional(),
  })
  .strict();

export type TimelineSource = z.infer<typeof TimelineSourceSchema>;
export type TimelineAnchor = z.infer<typeof TimelineAnchorSchema>;
export type TimelineStatus = z.infer<typeof TimelineStatusSchema>;
export type TimelineEventData = z.infer<typeof TimelineEventDataSchema>;
export type TimelineEvent = z.infer<typeof TimelineEventSchema>;
export type TimelineEventDraft = z.infer<typeof TimelineEventDraftSchema>;
export type TimelineListInput = z.infer<typeof TimelineListInputSchema>;
export type TimelinePage = z.infer<typeof TimelinePageSchema>;
export type TimelineSubscriptionEvent = z.infer<typeof TimelineSubscriptionEventSchema>;
export type TimelinePreview = z.infer<typeof TimelinePreviewSchema>;
