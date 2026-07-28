import { z } from "zod";

export const TIMELINE_EVENT_KINDS = [
  "turn.user",
  "turn.synthetic",
  "turn.completed",
  "turn.interrupted",
  "turn.failed",
  "retry.scheduled",
  "retry.abandoned",
  "compaction.triggered",
  "compaction.completed",
  "context.reset",
  "history.cleared",
  "task.created",
  "task.reported",
  "task.interrupted",
  "workflow.attached",
  "heartbeat.configured",
  "heartbeat.dispatched",
  "heartbeat.skipped",
  "goal.set",
  "goal.completed",
  "goal.budget_limited",
  "goal.continuation_dispatched",
  "settings.changed",
  "agent.event",
  "agent.plan_proposed",
  "agent.notified",
] as const;

export const TimelineEventKindSchema = z.enum(TIMELINE_EVENT_KINDS);
export type TimelineEventKind = z.infer<typeof TimelineEventKindSchema>;

// Kinds recorded by earlier builds of the timeline experiment. Unknown kinds render generically,
// so retired ones stay hidden instead of resurfacing the per-tool-call noise the feed dropped.
export const TIMELINE_RETIRED_KINDS: ReadonlySet<string> = new Set([
  "tool.call",
  "agent.mark",
  "agent.status",
  "agent.todo_completed",
]);

export const TimelineSourceSchema = z
  .object({
    system: z.enum(["chat", "heartbeat", "goal", "task", "settings", "agent"]),
    key: z.string().min(1).optional(),
  })
  .strict();

export const TimelineAnchorSchema = z
  .object({
    // History sequences are 0-based, so the first message in a workspace anchors at 0.
    historySequence: z.number().int().nonnegative().optional(),
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

/**
 * Digests and previews are rendered in a sidebar row, but some sources (a sub-agent's full report)
 * are unbounded. Bound them before they reach the append-only log, which is never rewritten.
 */
export const TIMELINE_TEXT_MAX_LENGTH = 600;

export function truncateTimelineDigest(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= TIMELINE_TEXT_MAX_LENGTH
    ? normalized
    : `${normalized.slice(0, TIMELINE_TEXT_MAX_LENGTH - 3)}...`;
}

const timelineEventDataShape = {
  model: z.string().optional(),
  mode: z.string().optional(),
  agentId: z.string().optional(),
  reason: z.string().optional(),
  errorKind: z.string().optional(),
  durationMs: z.number().nonnegative().optional(),
  title: z.string().optional(),
  digest: z.string().optional(),
  description: z.string().optional(),
  category: z.enum(["picked_up", "milestone", "decision", "blocker", "handoff"]).optional(),
  usagePercent: z.number().optional(),
  newUsagePercent: z.number().optional(),
  attempt: z.number().int().positive().optional(),
  delayMs: z.number().nonnegative().optional(),
  scheduledAt: z.number().optional(),
  runId: z.string().optional(),
  goalId: z.string().optional(),
};

export const TimelineEventDataSchema = z.object(timelineEventDataShape).strict();

const timelineEventShape = {
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
};

export const TimelineEventSchema = z.object(timelineEventShape).strict();

// Reads tolerate payload keys this build does not declare, because a newer build may add fields
// and retired kinds carry fields that were removed. Writes stay strict so we only persist known
// facts; dropping such a row on read instead would hide it from the feed entirely.
export const TimelineStoredEventSchema = z.object({
  ...timelineEventShape,
  data: z.object(timelineEventDataShape).optional(),
});

// Sequence recovery must survive rows this build cannot otherwise parse, or a new append could
// reuse a sequence number that already exists on disk.
export const TimelineSequenceEnvelopeSchema = z.object({ seq: z.number().int().positive() });

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
  // The snapshot is the newest page, so it carries the same pagination metadata as `list`. Clients
  // page older events from this cursor instead of issuing their own initial `list`, which could
  // otherwise race appends and leave a permanent gap between the two pages.
  z
    .object({
      type: z.literal("snapshot"),
      events: z.array(TimelineEventSchema),
      nextCursor: z.number().int().positive().nullable(),
      hasOlder: z.boolean(),
    })
    .strict(),
  z.object({ type: z.literal("appended"), events: z.array(TimelineEventSchema) }).strict(),
]);

export const TimelinePreviewInputSchema = TimelineAnchorSchema;

export const TimelinePreviewSchema = z
  .object({
    role: z.enum(["system", "user", "assistant"]),
    textExcerpt: z.string().max(TIMELINE_TEXT_MAX_LENGTH),
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
