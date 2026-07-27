import {
  Activity,
  Archive,
  Ban,
  Bell,
  CheckCircle2,
  CircleEllipsis,
  CirclePause,
  CircleX,
  ClipboardCheck,
  HeartPulse,
  Layers,
  ListChecks,
  ListTodo,
  Map,
  MessageSquare,
  Radio,
  RefreshCcw,
  RotateCcw,
  Send,
  Settings2,
  Sparkles,
  Target,
  Trash2,
  WandSparkles,
  Workflow,
  Wrench,
  type LucideIcon,
} from "lucide-react";

import {
  TIMELINE_EVENT_KINDS,
  type TimelineEvent,
  type TimelineEventKind,
} from "@/common/orpc/schemas/timeline";
import { capitalize } from "@/common/utils/capitalize";

export const TIMELINE_CATEGORIES = [
  "turns",
  "tools",
  "context",
  "tasks",
  "goals",
  "errors",
  "agent notes",
] as const;

export type TimelineCategory = (typeof TIMELINE_CATEGORIES)[number];

interface TimelinePresentation {
  label: string;
  icon: LucideIcon;
  category: TimelineCategory;
}

const TIMELINE_PRESENTATION: Record<TimelineEventKind, TimelinePresentation> = {
  "turn.user": { label: "User turn", icon: MessageSquare, category: "turns" },
  "turn.synthetic": { label: "Synthetic turn", icon: WandSparkles, category: "turns" },
  "turn.completed": { label: "Turn completed", icon: CheckCircle2, category: "turns" },
  "turn.interrupted": { label: "Turn interrupted", icon: CirclePause, category: "turns" },
  "turn.failed": { label: "Turn failed", icon: CircleX, category: "errors" },
  "retry.scheduled": { label: "Retry scheduled", icon: RotateCcw, category: "errors" },
  "retry.abandoned": { label: "Retry abandoned", icon: Ban, category: "errors" },
  "tool.call": { label: "Tool call", icon: Wrench, category: "tools" },
  "compaction.triggered": { label: "Compaction started", icon: Layers, category: "context" },
  "compaction.completed": { label: "Compaction completed", icon: Archive, category: "context" },
  "context.reset": { label: "Context reset", icon: RefreshCcw, category: "context" },
  "history.cleared": { label: "History cleared", icon: Trash2, category: "context" },
  "task.created": { label: "Task created", icon: ListTodo, category: "tasks" },
  "task.reported": { label: "Task reported", icon: ClipboardCheck, category: "tasks" },
  "task.interrupted": { label: "Task interrupted", icon: CirclePause, category: "tasks" },
  "workflow.attached": { label: "Workflow attached", icon: Workflow, category: "tasks" },
  "heartbeat.dispatched": { label: "Heartbeat dispatched", icon: HeartPulse, category: "turns" },
  "heartbeat.skipped": { label: "Heartbeat skipped", icon: Activity, category: "turns" },
  "goal.set": { label: "Goal set", icon: Target, category: "goals" },
  "goal.completed": { label: "Goal completed", icon: CheckCircle2, category: "goals" },
  "goal.budget_limited": { label: "Goal budget limited", icon: CirclePause, category: "goals" },
  "goal.continuation_dispatched": {
    label: "Goal continuation dispatched",
    icon: Send,
    category: "goals",
  },
  "settings.changed": { label: "Settings changed", icon: Settings2, category: "context" },
  "agent.mark": { label: "Agent note", icon: Sparkles, category: "agent notes" },
  "agent.status": { label: "Agent status", icon: Radio, category: "agent notes" },
  "agent.plan_proposed": { label: "Plan proposed", icon: Map, category: "agent notes" },
  "agent.todo_completed": { label: "Todo completed", icon: ListChecks, category: "agent notes" },
  "agent.notified": { label: "Notification sent", icon: Bell, category: "agent notes" },
};

const knownKinds = new Set<string>(TIMELINE_EVENT_KINDS);

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

export function getTimelineEventCategory(event: TimelineEvent): TimelineCategory {
  if (event.status === "failed") {
    return "errors";
  }
  return getTimelinePresentation(event.kind).category;
}
