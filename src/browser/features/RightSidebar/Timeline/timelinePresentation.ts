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
  ListTodo,
  Map,
  MessageSquare,
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
  // Only `turn.user` belongs to Prompts: that filter is a record of what the human asked for.
  // Synthetic turns are dispatched on the agent's behalf, and a turn's outcome is the agent's work
  // rather than a request, so both are agent activity. Terminal events carry no provenance, so
  // leaving them in Prompts would file every heartbeat and continuation outcome as a human request.
  "turn.synthetic": { label: "Synthetic prompt", icon: WandSparkles, category: "agent" },
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
  "task.reported": { label: "Sub-agent reported", icon: ClipboardCheck, category: "subagents" },
  "task.interrupted": { label: "Sub-agent interrupted", icon: CirclePause, category: "subagents" },
  "workflow.attached": { label: "Workflow started", icon: Workflow, category: "subagents" },
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

// A descriptive event payload reads better as the row title than the generic kind label.
export function getTimelineEventTitle(event: TimelineEvent): string {
  return event.data?.description ?? getTimelinePresentation(event.kind).label;
}

export function getTimelineEventCategory(event: TimelineEvent): TimelineCategory {
  if (event.status === "failed") {
    return "errors";
  }
  return getTimelinePresentation(event.kind).category;
}
