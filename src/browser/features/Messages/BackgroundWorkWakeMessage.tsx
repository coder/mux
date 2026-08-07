import { useState, type ReactElement } from "react";
import { BellRing, ChevronRight } from "lucide-react";
import { cn } from "@/common/lib/utils";
import type { BackgroundWorkWakeDisplayRecord, DisplayedMessage } from "@/common/types/message";
import { TranscriptQuoteRoot } from "./TranscriptQuoteBoundary";

interface BackgroundWorkWakeMessageProps {
  message: DisplayedMessage & { type: "user" };
  className?: string;
}

function summarizeOutcome(record: BackgroundWorkWakeDisplayRecord): string {
  switch (record.outcome) {
    case "completed":
      return `${record.title} completed`;
    case "failed":
      return `${record.title} failed`;
    case "interrupted":
      return `${record.title} was interrupted`;
    case "error":
      return `${record.title} ended with an error`;
  }
}

function summarizeRecords(records: BackgroundWorkWakeDisplayRecord[]): string {
  if (records.length === 1) {
    const record = records[0];
    return summarizeOutcome(record);
  }

  const completedCount = records.filter((record) => record.outcome === "completed").length;
  if (completedCount === records.length) {
    return `${records.length} background jobs completed`;
  }
  if (completedCount === 0) {
    return `${records.length} background jobs need attention`;
  }
  return `${records.length} background work updates`;
}

/**
 * Terminal background-work wakes are machine-authored resume events. Keep the
 * provider-facing prompt intact in history, but collapse it behind a quiet event
 * row so the transcript does not present it as user-authored input.
 */
export function BackgroundWorkWakeMessage(props: BackgroundWorkWakeMessageProps): ReactElement {
  const [expanded, setExpanded] = useState(false);
  const records = props.message.backgroundWorkWake?.records ?? [];
  const summary = summarizeRecords(records);

  return (
    <div
      className={cn("my-2 flex min-w-0 flex-col items-end", props.className)}
      data-message-block
      data-background-work-wake
    >
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((previous) => !previous)}
        className="text-muted hover:bg-muted/10 hover:text-foreground focus-visible:ring-ring focus-visible:ring-offset-background flex max-w-full cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-xs focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
      >
        <BellRing aria-hidden="true" className="size-3.5 shrink-0" />
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
