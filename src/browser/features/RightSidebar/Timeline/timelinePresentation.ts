import {
  Activity,
  Archive,
  Ban,
  Bell,
  Bot,
  CheckCircle2,
  CircleEllipsis,
  CirclePause,
  CircleX,
  ClipboardCheck,
  Forward,
  HeartPulse,
  Inbox,
  Layers,
  ListTodo,
  Map,
  MessageSquare,
  PackageCheck,
  Radar,
  RefreshCcw,
  RotateCcw,
  Send,
  Settings2,
  Sparkles,
  Target,
  Timer,
  Trash2,
  WandSparkles,
  Workflow,
  type LucideIcon,
} from "lucide-react";

import {
  TIMELINE_EVENT_KINDS,
  type TimelineEvent,
  type TimelineEventKind,
} from "@/common/orpc/schemas/timeline";
import { capitalize } from "@/common/utils/capitalize";
import { classifyMachineTurnPromptKind } from "@/common/utils/machineTurnPrompts";

export const TIMELINE_CATEGORIES = [
  "prompts",
  "agent",
  "goals",
  "subagents",
  "context",
  "errors",
] as const;

export type TimelineCategory = (typeof TIMELINE_CATEGORIES)[number];

interface TimelinePresentation {
  label: string;
  icon: LucideIcon;
  category: TimelineCategory;
}

const TIMELINE_PRESENTATION: Record<TimelineEventKind, TimelinePresentation> = {
  "turn.user": { label: "User prompt", icon: MessageSquare, category: "prompts" },
  // Only human-authored turns belong to Prompts. Synthetic turns and turn outcomes are agent
  // activity, including terminal events that carry no provenance.
  "turn.synthetic": { label: "Synthetic prompt", icon: WandSparkles, category: "agent" },
  "turn.monitor_wake": { label: "Monitor wake", icon: Radar, category: "agent" },
  "turn.background_wake": { label: "Background work wake", icon: Inbox, category: "subagents" },
  "turn.delegated": { label: "Delegated prompt", icon: Forward, category: "agent" },
  "turn.completed": { label: "Turn completed", icon: CheckCircle2, category: "agent" },
  "turn.interrupted": { label: "Turn interrupted", icon: CirclePause, category: "agent" },
  "turn.failed": { label: "Turn failed", icon: CircleX, category: "errors" },
  "retry.scheduled": { label: "Retry scheduled", icon: RotateCcw, category: "errors" },
  "retry.abandoned": { label: "Retry abandoned", icon: Ban, category: "errors" },
  "compaction.triggered": { label: "Compaction started", icon: Layers, category: "context" },
  "compaction.completed": { label: "Compaction completed", icon: Archive, category: "context" },
  "context.reset": { label: "Context reset", icon: RefreshCcw, category: "context" },
  "history.cleared": { label: "History cleared", icon: Trash2, category: "context" },
  "task.created": { label: "Sub-agent started", icon: ListTodo, category: "subagents" },
  "task.progress": { label: "Sub-agent update", icon: Bot, category: "subagents" },
  "task.reported": { label: "Sub-agent reported", icon: ClipboardCheck, category: "subagents" },
  "task.failed": { label: "Sub-agent failed", icon: CircleX, category: "subagents" },
  "task.interrupted": { label: "Sub-agent interrupted", icon: CirclePause, category: "subagents" },
  "workflow.attached": { label: "Workflow started", icon: Workflow, category: "subagents" },
  "workflow.result": { label: "Workflow finished", icon: PackageCheck, category: "subagents" },
  "heartbeat.configured": { label: "Heartbeat configured", icon: Timer, category: "goals" },
  "heartbeat.dispatched": { label: "Heartbeat dispatched", icon: HeartPulse, category: "goals" },
  "heartbeat.skipped": { label: "Heartbeat skipped", icon: Activity, category: "goals" },
  "goal.set": { label: "Goal set", icon: Target, category: "goals" },
  "goal.completed": { label: "Goal completed", icon: CheckCircle2, category: "goals" },
  "goal.budget_limited": { label: "Goal budget limited", icon: CirclePause, category: "goals" },
  "goal.continuation_dispatched": {
    label: "Goal continuation dispatched",
    icon: Send,
    category: "goals",
  },
  "settings.changed": { label: "Settings changed", icon: Settings2, category: "context" },
  "agent.event": { label: "Agent event", icon: Sparkles, category: "agent" },
  "agent.plan_proposed": { label: "Plan proposed", icon: Map, category: "agent" },
  "agent.notified": { label: "Notification sent", icon: Bell, category: "agent" },
};

/**
 * Scheduler machinery rather than narrative: wakes, dispatch churn, and heartbeats record how the
 * loop kept moving, not what the work accomplished, so the panel collapses contiguous stretches
 * into one expandable group instead of rendering each row.
 */
const MACHINERY_KINDS: ReadonlySet<string> = new Set<TimelineEventKind>([
  "turn.monitor_wake",
  "turn.background_wake",
  "turn.synthetic",
  "goal.continuation_dispatched",
  "heartbeat.dispatched",
  "heartbeat.skipped",
]);

export function isMachineryKind(kind: string): boolean {
  return MACHINERY_KINDS.has(kind);
}

const knownKinds = new Set<string>(TIMELINE_EVENT_KINDS);

const timeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});

const dayFormatter = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
});

/** Row timestamp as the Timeline tab renders it (also used by the transcript card's preview). */
export function formatTimelineTime(timestamp: number): string {
  return timeFormatter.format(timestamp);
}

/** Day-group header label as the Timeline tab renders it. */
export function getTimelineDayLabel(timestamp: number): string {
  const date = new Date(timestamp);
  const today = new Date();
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const startOfDate = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const dayOffset = Math.round((startOfToday - startOfDate) / 86_400_000);

  if (dayOffset === 0) return "Today";
  if (dayOffset === 1) return "Yesterday";
  return dayFormatter.format(date);
}

export function getTimelinePresentation(kind: string): TimelinePresentation {
  if (knownKinds.has(kind)) {
    return TIMELINE_PRESENTATION[kind as TimelineEventKind];
  }

  return {
    label: capitalize(kind.replace(/[._-]+/g, " ")),
    icon: CircleEllipsis,
    category: "context",
  };
}

/**
 * Rows recorded before machine-authored turns were classified carry only the prompt digest, and the
 * log is never rewritten, so recover the kind from that text instead of labeling them all the same.
 */
export function getTimelineEventKind(event: TimelineEvent): string {
  if (event.kind !== "turn.synthetic") {
    return event.kind;
  }
  return classifyMachineTurnPromptKind(event.data?.digest ?? "") ?? event.kind;
}

// A descriptive event payload reads better as the row title than the generic kind label.
export function getTimelineEventTitle(event: TimelineEvent): string {
  return event.data?.description ?? getTimelinePresentation(getTimelineEventKind(event)).label;
}

/**
 * Categories an event is filed under. A failure also matches Errors, in addition to the category of
 * its kind, so a cross-cutting error view never removes the event from the feed it belongs to.
 */
export function getTimelineEventCategories(event: TimelineEvent): TimelineCategory[] {
  const category = getTimelinePresentation(getTimelineEventKind(event)).category;
  return event.status === "failed" && category !== "errors" ? [category, "errors"] : [category];
}
