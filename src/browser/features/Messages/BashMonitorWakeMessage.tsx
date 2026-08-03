import { useState, type ReactElement } from "react";
import { ChevronRight, Radar } from "lucide-react";
import { cn } from "@/common/lib/utils";
import type { BashMonitorWakeDisplayRecord, DisplayedMessage } from "@/common/types/message";
import { TranscriptQuoteRoot } from "./TranscriptQuoteBoundary";

interface BashMonitorWakeMessageProps {
  message: DisplayedMessage & { type: "user" };
  className?: string;
}

function summarizeRecords(records: BashMonitorWakeDisplayRecord[]): string {
  if (records.length === 1) {
    const record = records[0];
    return record.kind === "monitor-lost"
      ? `${record.displayName} monitor stopped after restart`
      : `${record.displayName} monitor matched`;
  }

  const matchCount = records.filter((record) => record.kind === "match").length;
  if (matchCount === records.length) {
    return `${records.length} background monitors matched`;
  }
  if (matchCount === 0) {
    return `${records.length} background monitors stopped after restart`;
  }
  return `${records.length} background monitor updates`;
}

/**
 * Monitor wakes are machine-authored events, not user prompts. Keep them visible
 * for transcript continuity without giving them a full user bubble, metadata row,
 * or duplicate status badge. Right-align the compact wake like the user-side event that
 * resumed the turn, while keeping the model-facing prompt available on demand.
 */
export function BashMonitorWakeMessage(props: BashMonitorWakeMessageProps): ReactElement {
  const [expanded, setExpanded] = useState(false);
  const records = props.message.bashMonitorWake?.records ?? [];
  const summary = summarizeRecords(records);

  return (
    <div
      className={cn("my-2 flex min-w-0 flex-col items-end", props.className)}
      data-message-block
      data-bash-monitor-wake
    >
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((previous) => !previous)}
        className="text-muted hover:bg-muted/10 hover:text-foreground focus-visible:ring-ring focus-visible:ring-offset-background flex max-w-full cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-xs focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
      >
        <Radar aria-hidden="true" className="size-3.5 shrink-0" />
        <span className="truncate">{summary}</span>
        <ChevronRight
          aria-hidden="true"
          className={cn(
            "size-3 shrink-0 transition-transform duration-200",
            expanded && "rotate-90"
          )}
        />
        <span className="sr-only">{expanded ? "Hide details" : "Show details"}</span>
      </button>
      {expanded && (
        <TranscriptQuoteRoot text={props.message.content} className="mt-1.5 w-full">
          <pre className="text-muted bg-muted/5 border-border max-h-[40vh] overflow-y-auto rounded-md border p-2 text-xs leading-relaxed whitespace-pre-wrap">
            {props.message.content}
          </pre>
        </TranscriptQuoteRoot>
      )}
    </div>
  );
}
