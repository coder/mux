import { ChevronDown, ChevronRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useAPI } from "@/browser/contexts/API";
import {
  toWorkspaceSelection,
  useOptionalWorkspaceContext,
} from "@/browser/contexts/WorkspaceContext";
import { usePersistedState } from "@/browser/hooks/usePersistedState";
import {
  pinTimelineRevealTarget,
  useWorkspaceStoreRaw,
  useWorkspaceTimeline,
  type HistoryLoadResult,
  type WorkspaceState,
  type WorkspaceTimelineSnapshot,
} from "@/browser/stores/WorkspaceStore";
import { stopKeyboardPropagation } from "@/browser/utils/events";
import { KEYBINDS, isEditableElement, matchesKeybind } from "@/browser/utils/ui/keybinds";
import { CUSTOM_EVENTS, createCustomEvent } from "@/common/constants/events";
import { cn } from "@/common/lib/utils";
import { capitalize } from "@/common/utils/capitalize";
import { formatDuration } from "@/common/utils/formatDuration";
import type {
  TimelineAnchor,
  TimelineEvent,
  TimelinePreview,
} from "@/common/orpc/schemas/timeline";

import {
  TIMELINE_CATEGORIES,
  getTimelineEventCategories,
  getTimelineEventKind,
  getTimelineEventTitle,
  getTimelinePresentation,
  type TimelineCategory,
} from "./timelinePresentation";

interface TimelinePanelProps {
  workspaceId: string;
}

export interface TimelineWorkspaceStore {
  getWorkspaceState: (
    workspaceId: string
  ) => Pick<WorkspaceState, "messages" | "muxMessages" | "hasOlderHistory">;
  loadOlderHistory: (workspaceId: string) => Promise<HistoryLoadResult>;
  loadOlderTimeline: (workspaceId: string) => Promise<void>;
  retryTimeline: (workspaceId: string) => void;
}

type TimelineFilter = "all" | TimelineCategory;

interface DayGroup {
  key: string;
  label: string;
  events: TimelineEvent[];
}

interface CollapsedRun {
  key: string;
  kind: string;
  events: TimelineEvent[];
}

type DayItem = TimelineEvent | CollapsedRun;

const BOUNDARY_KINDS = new Set([
  "compaction.triggered",
  "compaction.completed",
  "context.reset",
  "history.cleared",
]);

// A completed turn renders as a boundary rule between stretches of work. Interruptions and failures
// keep the full row so they stand out.
const TURN_END_KIND = "turn.completed";

// Rule rows are already a single line, so collapsing a run of them would hide more than it saves.
function isRuleKind(kind: string): boolean {
  return kind === TURN_END_KIND || BOUNDARY_KINDS.has(kind);
}

const FILTERS: Array<{ value: TimelineFilter; label: string }> = [
  { value: "all", label: "All" },
  ...TIMELINE_CATEGORIES.map((category) => ({
    value: category,
    label: capitalize(category),
  })),
];

const timeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});

const dayFormatter = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
});

function isTimelineFilter(value: string): value is TimelineFilter {
  return value === "all" || TIMELINE_CATEGORIES.some((category) => category === value);
}

function getDayKey(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function getDayLabel(timestamp: number): string {
  const date = new Date(timestamp);
  const today = new Date();
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const startOfDate = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const dayOffset = Math.round((startOfToday - startOfDate) / 86_400_000);

  if (dayOffset === 0) return "Today";
  if (dayOffset === 1) return "Yesterday";
  return dayFormatter.format(date);
}

function groupEventsByDay(events: TimelineEvent[]): DayGroup[] {
  const groups = new Map<string, DayGroup>();
  for (const event of events) {
    const key = getDayKey(event.ts);
    const existing = groups.get(key);
    if (existing) {
      existing.events.push(event);
    } else {
      groups.set(key, { key, label: getDayLabel(event.ts), events: [event] });
    }
  }
  return Array.from(groups.values());
}

function collapseConsecutiveEvents(events: TimelineEvent[]): DayItem[] {
  const items: DayItem[] = [];
  let index = 0;

  while (index < events.length) {
    const event = events[index];
    const kind = getTimelineEventKind(event);
    if (isRuleKind(kind)) {
      items.push(event);
      index++;
      continue;
    }

    let end = index + 1;
    while (end < events.length && getTimelineEventKind(events[end]) === kind) {
      end++;
    }

    const run = events.slice(index, end);
    if (run.length >= 3) {
      items.push({ key: `${event.id}:${kind}`, kind, events: run });
    } else {
      items.push(...run);
    }
    index = end;
  }

  return items;
}

function isCollapsedRun(item: DayItem): item is CollapsedRun {
  return "events" in item;
}

function getEventDetail(event: TimelineEvent): string | null {
  const data = event.data;
  if (!data) return null;

  const details: string[] = [];
  if (data.title) details.push(data.title);
  else if (data.digest) details.push(data.digest);
  if (data.model || data.mode) details.push([data.model, data.mode].filter(Boolean).join(" · "));
  if (data.reason) details.push(data.reason);
  if (data.durationMs != null) details.push(formatDuration(data.durationMs, "precise"));
  return details.length > 0 ? details.join(" · ") : null;
}

function hasTranscriptAnchor(anchor: TimelineAnchor | undefined): boolean {
  return anchor?.toolCallId != null || anchor?.messageId != null || anchor?.historySequence != null;
}

function TimelineRuleRow(props: {
  event: TimelineEvent;
  selected: boolean;
  onSelect: (eventId: string) => void;
}) {
  const kind = getTimelineEventKind(props.event);
  const turnEnd = kind === TURN_END_KIND;
  const presentation = getTimelinePresentation(kind);
  const detail = getEventDetail(props.event);
  const epoch = props.event.epoch != null ? `Epoch ${props.event.epoch}` : "Context boundary";
  const rule = (
    <div className={cn("border-border min-w-3 flex-1 border-t", turnEnd && "border-dotted")} />
  );
  const label = (
    <span
      className={cn(
        "text-muted counter-nums min-w-0 truncate text-[10px] font-medium tracking-wide",
        !turnEnd && "uppercase",
        props.selected && "text-content-primary"
      )}
    >
      {turnEnd ? (detail ?? presentation.label) : `${epoch} · ${presentation.label}`}
    </span>
  );
  const body = turnEnd ? (
    <>
      {rule}
      {label}
      <time
        dateTime={new Date(props.event.ts).toISOString()}
        className="text-muted counter-nums shrink-0 text-[10px]"
      >
        {timeFormatter.format(props.event.ts)}
      </time>
    </>
  ) : (
    <>
      {rule}
      {label}
      {rule}
    </>
  );

  if (!hasTranscriptAnchor(props.event.anchor)) {
    return (
      <div className="my-2 flex min-w-0 items-center gap-2" role="separator">
        {body}
      </div>
    );
  }

  // An anchored rule may point into archived history, so keep it selectable as a reveal path.
  return (
    <button
      type="button"
      aria-pressed={props.selected}
      data-timeline-event-id={props.event.id}
      data-timeline-event-kind={props.event.kind}
      onClick={() => props.onSelect(props.event.id)}
      className="hover:bg-hover focus-visible:ring-accent my-2 flex w-full min-w-0 items-center gap-2 rounded-md px-1 py-1 focus-visible:ring-1 focus-visible:outline-none"
    >
      {body}
    </button>
  );
}

function TimelineEventRow(props: {
  event: TimelineEvent;
  selected: boolean;
  onSelect: (eventId: string) => void;
}) {
  const presentation = getTimelinePresentation(getTimelineEventKind(props.event));
  const Icon = presentation.icon;
  const title = getTimelineEventTitle(props.event);
  const detail = getEventDetail(props.event);
  const agentAuthored = props.event.source.system === "agent";
  const badge = props.event.data?.category?.replace(/_/g, " ") ?? "Agent";
  const failed = props.event.status === "failed";
  const interrupted = props.event.status === "interrupted";

  return (
    <button
      type="button"
      aria-pressed={props.selected}
      data-timeline-event-id={props.event.id}
      data-timeline-event-kind={props.event.kind}
      data-timeline-source={props.event.source.system}
      onClick={() => props.onSelect(props.event.id)}
      className={cn(
        "grid w-full min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-2 rounded-md border border-transparent px-2 py-2 text-left transition-colors",
        "hover:bg-hover focus-visible:ring-accent focus-visible:ring-1 focus-visible:outline-none",
        agentAuthored && "border-ask-mode/25 bg-ask-mode-alpha",
        failed && "border-danger/40 bg-danger-overlay",
        interrupted && !failed && "border-warning/40 bg-warning-overlay",
        props.selected && "border-accent/60 bg-accent/10"
      )}
    >
      <span
        className={cn(
          "border-border bg-surface-secondary text-content-secondary mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border",
          agentAuthored && "border-ask-mode/40 text-ask-mode",
          failed && "border-danger/50 text-danger",
          interrupted && !failed && "border-warning/50 text-warning"
        )}
      >
        <Icon className="h-3.5 w-3.5" />
      </span>
      <span className="min-w-0">
        <span className="text-content-primary line-clamp-2 min-w-0 text-xs font-medium">
          {title}
        </span>
        {agentAuthored || detail ? (
          <span className="mt-0.5 flex min-w-0 items-center gap-1.5">
            {agentAuthored ? (
              <span className="border-ask-mode/30 text-ask-mode shrink-0 rounded border px-1 py-px text-[9px] font-medium uppercase">
                {badge}
              </span>
            ) : null}
            {detail ? (
              <span className="text-muted min-w-0 truncate text-[11px]">{detail}</span>
            ) : null}
          </span>
        ) : null}
      </span>
      <time
        dateTime={new Date(props.event.ts).toISOString()}
        className="text-muted counter-nums shrink-0 pt-0.5 text-[10px]"
      >
        {timeFormatter.format(props.event.ts)}
      </time>
    </button>
  );
}

function CollapsedEventRun(props: {
  run: CollapsedRun;
  expanded: boolean;
  selectedEventId: string | null;
  onToggle: (key: string) => void;
  onSelect: (eventId: string) => void;
}) {
  const presentation = getTimelinePresentation(props.run.kind);
  const Icon = presentation.icon;

  if (props.expanded) {
    return (
      <div className="flex min-w-0 flex-col gap-1">
        <button
          type="button"
          aria-expanded="true"
          data-timeline-collapsed-kind={props.run.kind}
          data-timeline-collapsed-count={props.run.events.length}
          onClick={() => props.onToggle(props.run.key)}
          className="text-muted hover:bg-hover focus-visible:ring-accent flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-[11px] focus-visible:ring-1 focus-visible:outline-none"
        >
          <ChevronDown className="h-3.5 w-3.5 shrink-0" />
          <span className="counter-nums shrink-0">{props.run.events.length}</span>
          <span className="min-w-0 truncate">{presentation.label} events</span>
        </button>
        {props.run.events.map((event) => (
          <TimelineEventRow
            key={event.id}
            event={event}
            selected={props.selectedEventId === event.id}
            onSelect={props.onSelect}
          />
        ))}
      </div>
    );
  }

  return (
    <button
      type="button"
      aria-expanded="false"
      data-timeline-collapsed-kind={props.run.kind}
      data-timeline-collapsed-count={props.run.events.length}
      onClick={() => props.onToggle(props.run.key)}
      className="border-border bg-surface-secondary/50 hover:bg-hover focus-visible:ring-accent grid w-full min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 rounded-md border px-2 py-2 text-left focus-visible:ring-1 focus-visible:outline-none"
    >
      <span className="border-border bg-surface-primary text-content-secondary flex h-6 w-6 shrink-0 items-center justify-center rounded-full border">
        <Icon className="h-3.5 w-3.5" />
      </span>
      <span className="text-content-secondary min-w-0 truncate text-xs">
        <span className="counter-nums font-medium">{props.run.events.length}</span>{" "}
        {presentation.label} events
      </span>
      <ChevronRight className="text-muted h-3.5 w-3.5 shrink-0" />
    </button>
  );
}

const MAX_REVEAL_HISTORY_PAGES = 10;

type PreviewState =
  | { status: "loading" }
  | { status: "ready"; preview: TimelinePreview }
  | { status: "unavailable" };

function TimelinePreviewCard(props: {
  workspaceId: string;
  event: TimelineEvent;
  workspaceStore: TimelineWorkspaceStore;
}) {
  const { api } = useAPI();
  const workspaceContext = useOptionalWorkspaceContext();
  const workspaceStore = props.workspaceStore;
  const [previewState, setPreviewState] = useState<PreviewState>({ status: "loading" });
  const [revealState, setRevealState] = useState<"idle" | "revealing" | "not-found" | "error">(
    "idle"
  );

  const revealOperationRef = useRef(0);
  const revealButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const operationRef = revealOperationRef;
    return () => {
      operationRef.current++;
    };
  }, []);

  useEffect(() => {
    const anchor = props.event.anchor;
    if (
      !anchor ||
      !api ||
      (anchor.toolCallId == null && anchor.messageId == null && anchor.historySequence == null)
    ) {
      setPreviewState({ status: "unavailable" });
      return;
    }

    let cancelled = false;
    setPreviewState({ status: "loading" });

    api.workspace.timeline
      .preview({ workspaceId: props.workspaceId, ...anchor })
      .then((preview) => {
        if (!cancelled) {
          setPreviewState(preview ? { status: "ready", preview } : { status: "unavailable" });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setPreviewState({ status: "unavailable" });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [api, props.event, props.workspaceId]);

  const anchor = props.event.anchor;
  const childWorkspace = anchor?.childWorkspaceId
    ? workspaceContext?.workspaceMetadata.get(anchor.childWorkspaceId)
    : undefined;
  const hasTranscriptTarget = hasTranscriptAnchor(anchor);

  const resolveRevealTarget = (currentAnchor: TimelineAnchor) => {
    const messageId =
      currentAnchor.messageId ??
      (currentAnchor.historySequence != null
        ? workspaceStore
            .getWorkspaceState(props.workspaceId)
            .muxMessages.find(
              (message) => message.metadata?.historySequence === currentAnchor.historySequence
            )?.id
        : undefined);
    return { messageId, toolCallId: currentAnchor.toolCallId };
  };

  const isRevealTargetLoaded = (target: { messageId?: string; toolCallId?: string }) => {
    const messages = workspaceStore.getWorkspaceState(props.workspaceId).messages;
    if (target.toolCallId) {
      return messages.some(
        (message) => message.type === "tool" && message.toolCallId === target.toolCallId
      );
    }
    return target.messageId
      ? messages.some((message) => "historyId" in message && message.historyId === target.messageId)
      : false;
  };

  const dispatchReveal = (target: { messageId?: string; toolCallId?: string }) => {
    window.dispatchEvent(
      createCustomEvent(CUSTOM_EVENTS.REVEAL_TIMELINE_ANCHOR, {
        workspaceId: props.workspaceId,
        ...target,
      })
    );
  };

  const handleReveal = async () => {
    if (!anchor || !hasTranscriptTarget || revealState === "revealing") {
      return;
    }

    const operation = ++revealOperationRef.current;
    setRevealState("revealing");

    try {
      let target = resolveRevealTarget(anchor);
      if (isRevealTargetLoaded(target)) {
        dispatchReveal(target);
        setRevealState("idle");
        return;
      }

      // Keep only a resolved reveal target outside the normal transcript window. A sequence-only
      // anchor may need history paging before it has an ID, so do not reject it before that loop.
      if (target.messageId != null || target.toolCallId != null) {
        pinTimelineRevealTarget(props.workspaceId, target);
      }
      target = resolveRevealTarget(anchor);
      if (isRevealTargetLoaded(target)) {
        dispatchReveal(target);
        setRevealState("idle");
        return;
      }

      for (let page = 0; page < MAX_REVEAL_HISTORY_PAGES; page++) {
        const workspaceState = workspaceStore.getWorkspaceState(props.workspaceId);
        if (!workspaceState.hasOlderHistory) {
          break;
        }

        const loadResult = await workspaceStore.loadOlderHistory(props.workspaceId);
        if (operation !== revealOperationRef.current) {
          return;
        }
        if (loadResult === "failed" || loadResult === "busy" || loadResult === "unavailable") {
          setRevealState("error");
          return;
        }

        target = resolveRevealTarget(anchor);
        if (target.messageId != null || target.toolCallId != null) {
          pinTimelineRevealTarget(props.workspaceId, target);
        }
        if (isRevealTargetLoaded(target)) {
          dispatchReveal(target);
          setRevealState("idle");
          return;
        }
        if (loadResult === "exhausted") {
          break;
        }
      }

      setRevealState("not-found");
    } catch {
      if (operation === revealOperationRef.current) {
        setRevealState("error");
      }
    }
  };

  // The card is mounted only while an event is selected, so a window listener is scoped to the
  // selection and works without focusing the sidebar. Activating the button rather than calling the
  // handler keeps one reveal path and inherits its disabled state while a reveal is in flight.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const button = revealButtonRef.current;
      if (
        !button ||
        button.disabled ||
        !matchesKeybind(event, KEYBINDS.REVEAL_TIMELINE_EVENT) ||
        isEditableElement(event.target)
      ) {
        return;
      }
      event.preventDefault();
      button.click();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const title = getTimelineEventTitle(props.event);
  const digest = props.event.data?.description ?? props.event.data?.digest ?? null;
  const eventText = digest === title ? null : digest;
  const excerpt = previewState.status === "ready" ? previewState.preview.textExcerpt : "";

  return (
    <div className="border-border bg-surface-secondary mx-3 mb-3 shrink-0 rounded-md border p-3">
      <div className="flex min-w-0 flex-col gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="text-content-primary min-w-0 text-xs font-medium">{title}</span>
          <time
            dateTime={new Date(props.event.ts).toISOString()}
            className="text-muted counter-nums shrink-0 text-[10px]"
          >
            {timeFormatter.format(props.event.ts)}
          </time>
        </div>
        {eventText ? (
          <div className="text-content-secondary max-h-24 overflow-hidden text-xs whitespace-pre-wrap">
            {eventText}
          </div>
        ) : null}
        {previewState.status === "loading" ? (
          <div className="text-muted text-xs">Loading preview…</div>
        ) : excerpt ? (
          <div className="border-border flex min-w-0 flex-col gap-1 border-t pt-2">
            <span className="text-muted text-[10px] capitalize">
              {previewState.status === "ready" ? previewState.preview.role : ""}
            </span>
            <div className="text-content-secondary max-h-24 overflow-hidden text-xs whitespace-pre-wrap">
              {excerpt}
            </div>
          </div>
        ) : digest == null ? (
          <div className="text-muted text-xs">Preview unavailable</div>
        ) : null}
      </div>

      {hasTranscriptTarget || anchor?.childWorkspaceId ? (
        <div className="mt-3 flex flex-col items-start gap-1.5">
          <div className="flex flex-wrap gap-2">
            {hasTranscriptTarget ? (
              <button
                type="button"
                ref={revealButtonRef}
                data-testid="timeline-reveal"
                disabled={revealState === "revealing"}
                onClick={() => void handleReveal()}
                className="border-border bg-surface-primary text-content-primary hover:bg-hover focus-visible:ring-accent rounded-md border px-2.5 py-1.5 text-xs font-medium focus-visible:ring-1 focus-visible:outline-none disabled:cursor-wait disabled:opacity-60"
              >
                {revealState === "revealing" ? "Revealing…" : "Reveal in transcript"}
              </button>
            ) : null}
            {anchor?.childWorkspaceId ? (
              <button
                type="button"
                disabled={!childWorkspace || !workspaceContext}
                onClick={() => {
                  if (childWorkspace && workspaceContext) {
                    workspaceContext.setSelectedWorkspace(toWorkspaceSelection(childWorkspace));
                  }
                }}
                className="border-border bg-surface-primary text-content-primary hover:bg-hover focus-visible:ring-accent rounded-md border px-2.5 py-1.5 text-xs font-medium focus-visible:ring-1 focus-visible:outline-none disabled:opacity-60"
              >
                Open child workspace
              </button>
            ) : null}
          </div>
          {revealState === "not-found" ? (
            <div data-testid="timeline-reveal-not-found" className="text-muted text-[10px]">
              Too far back; showing preview only
            </div>
          ) : revealState === "error" ? (
            <div className="text-muted text-[10px]">Reveal unavailable</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

interface TimelinePanelViewProps extends TimelinePanelProps {
  timeline: WorkspaceTimelineSnapshot;
  workspaceStore: TimelineWorkspaceStore;
}

export function TimelinePanelView(props: TimelinePanelViewProps) {
  const timeline = props.timeline;
  const workspaceStore = props.workspaceStore;
  const [storedFilter, setStoredFilter] = usePersistedState<string>(
    `timeline-filter:${props.workspaceId}`,
    "all"
  );
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [expandedRuns, setExpandedRuns] = useState<Record<string, boolean>>({});
  const filter = isTimelineFilter(storedFilter) ? storedFilter : "all";
  const filteredEvents = timeline.events.filter(
    (event) => filter === "all" || getTimelineEventCategories(event).includes(filter)
  );
  const selectedEvent = filteredEvents.find((event) => event.id === selectedEventId);
  const dayGroups = groupEventsByDay(filteredEvents);

  const toggleRun = (key: string) => {
    setExpandedRuns((current) => ({ ...current, [key]: !current[key] }));
  };

  return (
    <div
      className="flex h-full min-h-0 min-w-0 flex-col"
      onKeyDown={(event) => {
        if (event.key === "Escape" && selectedEventId) {
          stopKeyboardPropagation(event);
          setSelectedEventId(null);
        }
      }}
    >
      <div className="border-border shrink-0 border-b px-3 py-2.5">
        <div className="scrollbar-none flex min-w-0 gap-1.5 overflow-x-auto">
          {FILTERS.map((item) => (
            <button
              key={item.value}
              type="button"
              aria-pressed={filter === item.value}
              onClick={() => setStoredFilter(item.value)}
              className={cn(
                "border-border bg-surface-secondary text-content-secondary hover:bg-hover shrink-0 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors",
                filter === item.value && "border-accent/60 bg-accent/10 text-content-primary"
              )}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      <div className="scrollbar-none min-h-0 min-w-0 flex-1 overflow-y-auto px-3 py-3">
        {!timeline.initialized ? (
          <div className="text-muted flex h-full items-center justify-center text-sm">
            Loading timeline…
          </div>
        ) : timeline.events.length === 0 ? (
          timeline.loadError ? (
            // A failed subscription also lands here with no events, so it must not be reported as an
            // empty timeline: without this the panel stays stuck until it is unmounted and reopened.
            <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
              <div className="text-content-primary text-sm font-medium">Timeline unavailable</div>
              <div className="text-danger max-w-full text-xs break-words">{timeline.loadError}</div>
              <button
                type="button"
                onClick={() => workspaceStore.retryTimeline(props.workspaceId)}
                className="border-border bg-surface-secondary text-content-secondary hover:bg-hover focus-visible:ring-accent rounded-md border px-3 py-1.5 text-xs font-medium focus-visible:ring-1 focus-visible:outline-none"
              >
                Retry
              </button>
            </div>
          ) : (
            <div className="flex h-full flex-col items-center justify-center px-6 text-center">
              <div className="text-content-primary text-sm font-medium">No timeline events yet</div>
              <div className="text-muted mt-1 text-xs">
                Prompts, agent events, goals, heartbeats, sub-agents, and workflows land here.
              </div>
            </div>
          )
        ) : (
          <div className="flex min-w-0 flex-col gap-4">
            {filteredEvents.length === 0 ? (
              // Older pages may still hold matches, so this keeps the pagination footer reachable.
              <div className="text-muted px-6 py-6 text-center text-sm">
                No events match this filter.
              </div>
            ) : null}
            {dayGroups.map((group) => (
              <section key={group.key} className="min-w-0">
                <h2 className="text-muted mb-2 text-[10px] font-semibold tracking-wide uppercase">
                  {group.label}
                </h2>
                <div className="flex min-w-0 flex-col gap-1">
                  {collapseConsecutiveEvents(group.events).map((item) => {
                    if (isCollapsedRun(item)) {
                      return (
                        <CollapsedEventRun
                          key={item.key}
                          run={item}
                          expanded={Boolean(expandedRuns[item.key])}
                          selectedEventId={selectedEventId}
                          onToggle={toggleRun}
                          onSelect={setSelectedEventId}
                        />
                      );
                    }
                    if (isRuleKind(getTimelineEventKind(item))) {
                      return (
                        <TimelineRuleRow
                          key={item.id}
                          event={item}
                          selected={selectedEventId === item.id}
                          onSelect={setSelectedEventId}
                        />
                      );
                    }
                    return (
                      <TimelineEventRow
                        key={item.id}
                        event={item}
                        selected={selectedEventId === item.id}
                        onSelect={setSelectedEventId}
                      />
                    );
                  })}
                </div>
              </section>
            ))}

            <div className="flex flex-col items-center gap-2 pt-1 pb-2">
              {timeline.loadError ? (
                <div className="text-danger max-w-full truncate text-xs">{timeline.loadError}</div>
              ) : null}
              {/* A dead subscription stops delivering new events, so it needs an explicit retry even
                  though rows are already on screen. A failed page recovers via "Load older". */}
              {timeline.loadErrorKind === "subscription" ? (
                <button
                  type="button"
                  onClick={() => workspaceStore.retryTimeline(props.workspaceId)}
                  className="border-border bg-surface-secondary text-content-secondary hover:bg-hover focus-visible:ring-accent rounded-md border px-3 py-1.5 text-xs font-medium focus-visible:ring-1 focus-visible:outline-none"
                >
                  Reconnect
                </button>
              ) : null}
              {timeline.hasOlder ? (
                <button
                  type="button"
                  disabled={timeline.loadingOlder}
                  onClick={() => void workspaceStore.loadOlderTimeline(props.workspaceId)}
                  className="border-border bg-surface-secondary text-content-secondary hover:bg-hover focus-visible:ring-accent rounded-md border px-3 py-1.5 text-xs font-medium focus-visible:ring-1 focus-visible:outline-none disabled:cursor-wait disabled:opacity-60"
                >
                  {timeline.loadingOlder ? "Loading older…" : "Load older"}
                </button>
              ) : (
                <div className="text-muted text-[10px]">Beginning of timeline</div>
              )}
            </div>
          </div>
        )}
      </div>

      {selectedEvent?.anchor ? (
        <TimelinePreviewCard
          key={selectedEvent.id}
          workspaceId={props.workspaceId}
          event={selectedEvent}
          workspaceStore={workspaceStore}
        />
      ) : null}
    </div>
  );
}

export function TimelinePanel(props: TimelinePanelProps) {
  const timeline = useWorkspaceTimeline(props.workspaceId);
  const workspaceStore = useWorkspaceStoreRaw();

  return (
    <TimelinePanelView
      workspaceId={props.workspaceId}
      timeline={timeline}
      workspaceStore={workspaceStore}
    />
  );
}
