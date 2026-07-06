import { useState, type ReactElement } from "react";
import { ChevronRight, Radar } from "lucide-react";
import { cn } from "@/common/lib/utils";
import type { BashMonitorWakeDisplayRecord } from "@/common/types/message";

interface BashMonitorWakeMessageContentProps {
  /** Full wake prompt text (matched lines, task_await guidance) shown when expanded. */
  content: string;
  records: BashMonitorWakeDisplayRecord[];
}

function describeRecord(record: BashMonitorWakeDisplayRecord): string {
  const inverted = record.filterExclude ? " (inverted)" : "";
  const lost = record.kind === "monitor-lost" ? " — monitor lost" : "";
  return `${record.displayName} · /${record.filter}/${inverted}${lost}`;
}

/**
 * Compact card for synthetic bash-monitor wake turns. The raw prompt is
 * model-facing plumbing (matched lines, task_await guidance), so the transcript
 * shows a one-line summary per monitor and keeps the full prompt collapsed
 * behind a details toggle. Follows the plain-text-inside-the-bubble layout of
 * GoalSyntheticMessageContent — the user bubble already provides the framing.
 */
export function BashMonitorWakeMessageContent(
  props: BashMonitorWakeMessageContentProps
): ReactElement {
  const [expanded, setExpanded] = useState(false);

  const hasMatch = props.records.some((record) => record.kind === "match");
  const hasLost = props.records.some((record) => record.kind === "monitor-lost");
  const title = hasLost
    ? hasMatch
      ? "Background monitor updates"
      : "Background monitors lost (Mux restarted)"
    : "Background monitor matched output";

  return (
    <div>
      <div className="flex items-start gap-2.5">
        <Radar aria-hidden="true" className="text-muted mt-0.5 size-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="text-sm leading-snug font-medium text-[var(--color-user-text)]">
            {title}
          </div>
          {props.records.map((record, index) => (
            <div key={index} className="text-muted mt-0.5 truncate text-xs leading-snug">
              {describeRecord(record)}
            </div>
          ))}
        </div>
      </div>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((prev) => !prev)}
        className="text-muted hover:text-foreground mt-1.5 flex cursor-pointer items-center gap-1 text-xs"
      >
        <ChevronRight
          aria-hidden="true"
          className={cn("size-3 transition-transform duration-200", expanded && "rotate-90")}
        />
        {expanded ? "Hide details" : "Show details"}
      </button>
      {expanded && (
        <pre className="text-muted mt-1.5 max-h-[40vh] overflow-y-auto text-xs leading-relaxed whitespace-pre-wrap">
          {props.content}
        </pre>
      )}
    </div>
  );
}
