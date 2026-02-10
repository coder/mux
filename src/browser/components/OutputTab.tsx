import React from "react";
import { Trash2 } from "lucide-react";
import { useAPI } from "@/browser/contexts/API";
import { isAbortError } from "@/browser/utils/isAbortError";

type LogLevel = "error" | "warn" | "info" | "debug";

interface LogEntry {
  timestamp: number;
  level: LogLevel;
  message: string;
  location: string;
}

interface LogBatch {
  entries: LogEntry[];
  isInitial: boolean;
}

const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

interface OutputTabProps {
  workspaceId: string;
}

export function OutputTab(props: OutputTabProps) {
  const { api } = useAPI();

  const [entries, setEntries] = React.useState<LogEntry[]>([]);
  const [levelFilter, setLevelFilter] = React.useState<LogLevel>("info");
  const [autoScroll, setAutoScroll] = React.useState(true);

  const scrollRef = React.useRef<HTMLDivElement>(null);

  // The log stream is global/workspace-agnostic, but RightSidebar tabs are scoped per-workspace.
  // Include the workspace ID in the subscription effect so switching workspaces cleanly resets the stream.
  const workspaceId = props.workspaceId;

  React.useEffect(() => {
    if (!api) return;

    const controller = new AbortController();
    const { signal } = controller;

    let iterator: AsyncIterator<LogBatch> | null = null;

    void (async () => {
      try {
        const subscribedIterator = await api.general.subscribeLogs(
          { level: levelFilter },
          { signal }
        );

        // oRPC iterators don’t eagerly close. If we’re already aborted, explicitly close.
        if (signal.aborted) {
          void subscribedIterator.return?.();
          return;
        }

        iterator = subscribedIterator;

        for await (const batch of subscribedIterator) {
          if (signal.aborted) break;
          setEntries((prev) => (batch.isInitial ? batch.entries : [...prev, ...batch.entries]));
        }
      } catch (error) {
        if (signal.aborted || isAbortError(error)) return;
        console.warn("Log subscription error:", error);
      }
    })();

    return () => {
      controller.abort();
      void iterator?.return?.();
    };
  }, [api, levelFilter, workspaceId]);

  // Auto-scroll on new entries when the user is at the bottom.
  React.useEffect(() => {
    if (!autoScroll) return;
    if (!scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [entries, autoScroll]);

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 20;
    setAutoScroll(isAtBottom);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
        <LevelFilterDropdown value={levelFilter} onChange={setLevelFilter} />
        <button
          type="button"
          className="text-muted hover:text-foreground hover:bg-hover flex h-6 w-6 items-center justify-center rounded border-none bg-transparent p-0 transition-colors"
          onClick={() => setEntries([])}
          title="Clear"
          aria-label="Clear output"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>

      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto font-mono text-xs"
      >
        {entries.map((entry, i) => (
          <LogLine key={i} entry={entry} />
        ))}
      </div>
    </div>
  );
}

function LevelFilterDropdown(props: { value: LogLevel; onChange: (level: LogLevel) => void }) {
  return (
    <label className="text-muted flex items-center gap-2 text-xs">
      <span>Level</span>
      <select
        className="border-border bg-background-secondary hover:bg-hover h-7 rounded border px-2 py-1 text-xs"
        value={props.value}
        onChange={(e) => {
          const next = e.currentTarget.value;
          if ((LOG_LEVELS as readonly string[]).includes(next)) {
            props.onChange(next as LogLevel);
          }
        }}
      >
        {LOG_LEVELS.map((level) => (
          <option key={level} value={level}>
            {level}
          </option>
        ))}
      </select>
    </label>
  );
}

function LogLine(props: { entry: LogEntry }) {
  const { entry } = props;

  const levelColor: string =
    entry.level === "error"
      ? "var(--color-error)"
      : entry.level === "warn"
        ? "var(--color-warning)"
        : entry.level === "debug"
          ? "var(--color-muted-foreground)"
          : "var(--color-foreground)";

  return (
    <div className="hover:bg-hover flex gap-2 px-3 py-0.5">
      <span className="text-muted shrink-0">{formatTime(entry.timestamp)}</span>
      <span style={{ color: levelColor }} className="shrink-0 w-12">
        {entry.level.toUpperCase()}
      </span>
      <span className="text-muted shrink-0">{entry.location}</span>
      <span className="break-all">{entry.message}</span>
    </div>
  );
}

function formatTime(timestampMs: number): string {
  const date = new Date(timestampMs);
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  const ms = String(date.getMilliseconds()).padStart(3, "0");
  return `${hh}:${mm}:${ss}.${ms}`;
}
