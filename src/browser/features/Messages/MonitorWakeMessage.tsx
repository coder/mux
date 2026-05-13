import type { ReactElement } from "react";
import { Radio } from "lucide-react";
import { unescapeXml } from "@/common/utils/xml";

/**
 * Structured payload parsed out of a synthetic `<monitor-event ...>` user message.
 * The model still sees the raw XML; the UI replaces it with this card.
 */
export interface MonitorWakeEvent {
  taskId: string;
  displayName?: string;
  totalMatches: number;
  droppedLines?: number;
  lines: string[];
}

const MONITOR_OPEN_TAG = "<monitor-event";
const MONITOR_CLOSE_TAG = "</monitor-event>";
const ATTRIBUTE_PATTERN = /(\w[\w-]*)="([^"]*)"/g;
const LINE_PATTERN = /<line>([\s\S]*?)<\/line>/g;
// Matches one full `<monitor-event …>…</monitor-event>` block that carries the backend
// `source="mux"` sentinel. Used both to detect synthetic monitor wakes in a user message
// and to split batched payloads produced when multiple wake events are queued before a busy
// session flushes them together. The sentinel requirement protects user-authored XML that
// happens to look like `<monitor-event …>` from being silently extracted/stripped when a
// real backend wake is appended to their queued message.
const MONITOR_BLOCK_PATTERN =
  /<monitor-event\b(?=[^>]*\bsource="mux")[^>]*>[\s\S]*?<\/monitor-event>/g;

function parseSingleMonitorBlock(block: string): MonitorWakeEvent | null {
  const closeBracket = block.indexOf(">");
  if (closeBracket === -1) return null;
  const openTag = block.slice(MONITOR_OPEN_TAG.length, closeBracket);

  const attributes = new Map<string, string>();
  ATTRIBUTE_PATTERN.lastIndex = 0;
  for (const match of openTag.matchAll(ATTRIBUTE_PATTERN)) {
    attributes.set(match[1], unescapeXml(match[2]));
  }

  const taskId = attributes.get("taskId");
  const totalMatchesRaw = attributes.get("total_matches");
  if (!taskId || totalMatchesRaw === undefined) return null;
  const totalMatches = Number.parseInt(totalMatchesRaw, 10);
  if (!Number.isFinite(totalMatches)) return null;

  const droppedRaw = attributes.get("dropped_lines");
  const droppedLines =
    droppedRaw !== undefined && Number.isFinite(Number.parseInt(droppedRaw, 10))
      ? Number.parseInt(droppedRaw, 10)
      : undefined;

  const body = block.slice(closeBracket + 1, -MONITOR_CLOSE_TAG.length);
  const lines: string[] = [];
  LINE_PATTERN.lastIndex = 0;
  for (const match of body.matchAll(LINE_PATTERN)) {
    lines.push(unescapeXml(match[1]));
  }

  return {
    taskId,
    ...(attributes.get("display_name") !== undefined && {
      displayName: attributes.get("display_name"),
    }),
    totalMatches,
    ...(droppedLines !== undefined && { droppedLines }),
    lines,
  };
}

/** Result of pulling monitor wake blocks out of a user message. */
export interface MonitorWakeExtract {
  /** Parsed wake events, in source order. */
  events: MonitorWakeEvent[];
  /** Remaining message content with all monitor blocks removed and trimmed. */
  remainingContent: string;
}

/**
 * Extract monitor wake `<monitor-event …>` blocks from a user message.
 *
 * Returns null when no monitor block is present. The synthetic wake message can be appended
 * to an already-queued user message (MessageQueue concatenates with `\n`), so we extract all
 * monitor blocks anywhere in the content and leave the remaining user text untouched.
 */
export function extractMonitorWakeEvents(content: string): MonitorWakeExtract | null {
  MONITOR_BLOCK_PATTERN.lastIndex = 0;
  const matches = Array.from(content.matchAll(MONITOR_BLOCK_PATTERN));
  if (matches.length === 0) return null;

  const events: MonitorWakeEvent[] = [];
  for (const match of matches) {
    const event = parseSingleMonitorBlock(match[0]);
    if (!event) return null;
    events.push(event);
  }

  let remaining = content;
  for (const match of matches) {
    remaining = remaining.replace(match[0], "");
  }
  return { events, remainingContent: remaining.replace(/\n{2,}/g, "\n\n").trim() };
}

interface MonitorWakeMessageProps {
  event: MonitorWakeEvent;
}

/** Render a parsed monitor wake event as a compact inline system card. */
export function MonitorWakeMessage(props: MonitorWakeMessageProps): ReactElement {
  const { event } = props;
  const newCount = event.lines.length;
  // taskId is always `bash:<id>`; the prefix is implementation detail, hide it for display.
  const processLabel = event.taskId.startsWith("bash:")
    ? event.taskId.slice("bash:".length)
    : event.taskId;
  const source = event.displayName ?? processLabel;

  return (
    <section className="bg-muted/10 max-w-[42rem] min-w-[18rem] rounded-md border border-[var(--color-user-border)] p-3 not-italic">
      <div className="flex items-start gap-3">
        <div className="bg-muted/20 text-muted mt-0.5 rounded-md p-1.5">
          <Radio aria-hidden="true" className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1 space-y-2">
          <div>
            <div className="text-sm font-medium text-[var(--color-user-text)]">
              Monitor matched {newCount} new line{newCount === 1 ? "" : "s"}
              {event.totalMatches !== newCount && (
                <span className="text-muted ml-1 font-normal">· {event.totalMatches} total</span>
              )}
            </div>
            <div className="text-muted mt-0.5 truncate text-xs" title={source}>
              from <span className="font-mono">{source}</span>
            </div>
          </div>
          {event.lines.length > 0 && (
            <pre className="border-l-2 border-[var(--color-user-border)] pl-3 font-mono text-xs leading-relaxed whitespace-pre-wrap text-[var(--color-user-text)]">
              {event.lines.join("\n")}
            </pre>
          )}
          {event.droppedLines ? (
            <div className="text-muted text-[11px] italic">
              {event.droppedLines} earlier line{event.droppedLines === 1 ? "" : "s"} dropped due to
              backpressure
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
