import React from "react";
import { Activity } from "lucide-react";
import { cn } from "@/common/lib/utils";
import {
  ToolContainer,
  ToolHeader,
  ExpandIcon,
  StatusIndicator,
  ToolDetails,
  ToolIcon,
  ErrorBox,
} from "./Shared/ToolPrimitives";
import {
  useToolExpansion,
  getStatusDisplay,
  isToolErrorResult,
  type ToolStatus,
} from "./Shared/toolUtils";
import { HeartbeatToolResultSchema } from "@/common/utils/tools/toolDefinitions";
import type { HeartbeatToolArgs, HeartbeatToolResult } from "@/common/types/tools";
import {
  HEARTBEAT_DEFAULT_CONTEXT_MODE,
  HEARTBEAT_DEFAULT_MESSAGE_BODY,
  type HeartbeatContextMode,
} from "@/constants/heartbeat";

/**
 * Transcript card for the `heartbeat` tool — the agent's recurring, idle-gated
 * self check-in. Reads as a glanceable status pill (cadence + state) in the
 * header and expands to the full schedule and check-in prompt.
 *
 * Mirrors the heartbeat backend (HeartbeatToolResultSchema / src/constants/heartbeat.ts):
 * `action` is get | set | unset, and a successful result carries the resolved
 * `settings` (null when nothing is configured) plus a human `summary`.
 */

type HeartbeatSuccess = Extract<HeartbeatToolResult, { success: true }>;
type HeartbeatSettings = NonNullable<HeartbeatSuccess["settings"]>;

// Terse, card-friendly context-mode copy. The config modal
// (WorkspaceHeartbeatModal) uses more verbose, instruction-flavored labels;
// a transcript card wants short descriptive blurbs instead.
const CONTEXT_MODES: Record<HeartbeatContextMode, { label: string; blurb: string }> = {
  normal: { label: "Normal", blurb: "Continues with full context" },
  compact: { label: "Compact", blurb: "Compacts context before each check-in" },
  reset: { label: "Reset", blurb: "Starts each check-in from a fresh boundary" },
};

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

/** Human cadence for the expanded detail, e.g. "30 minutes", "2 hours", "1 hour". */
export function formatHeartbeatInterval(ms: number): string {
  if (ms % HOUR_MS === 0) {
    const hours = ms / HOUR_MS;
    return `${hours} ${hours === 1 ? "hour" : "hours"}`;
  }
  if (ms % MINUTE_MS === 0) {
    const minutes = ms / MINUTE_MS;
    return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  }
  return `${ms} ms`;
}

/** Compact cadence for the header pill, e.g. "30m", "2h". */
export function formatHeartbeatIntervalShort(ms: number): string {
  if (ms % HOUR_MS === 0) return `${ms / HOUR_MS}h`;
  if (ms % MINUTE_MS === 0) return `${ms / MINUTE_MS}m`;
  return `${ms} ms`;
}

/**
 * Narrow an arbitrary tool result to a successful heartbeat payload. Results
 * flow verbatim from persisted transcripts, so we validate against the schema
 * rather than trusting the shape (self-healing: a malformed result simply
 * renders no settings instead of throwing).
 */
function extractHeartbeatSuccess(result: unknown): HeartbeatSuccess | null {
  const parsed = HeartbeatToolResultSchema.safeParse(result);
  return parsed.success && parsed.data.success ? parsed.data : null;
}

type BadgeTone = "enabled" | "disabled" | "cleared";

// Green (live) shares the GoalStatusBadge palette so "active/healthy" reads the
// same across tool cards; amber means "kept but won't progress" (paused);
// muted means "not scheduled" (cleared / not set).
const BADGE_CLASSES: Record<BadgeTone, string> = {
  enabled: "bg-success/10 text-success border-success/40",
  disabled: "bg-warning-overlay text-warning border-warning/40",
  cleared: "bg-white/5 text-secondary border-white/10",
};

const HeartbeatBadge: React.FC<{ tone: BadgeTone; label: string }> = (props) => (
  <span
    className={cn(
      "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-1.5 py-0.5",
      "text-[10px] font-medium leading-none tracking-wide uppercase",
      BADGE_CLASSES[props.tone]
    )}
  >
    {props.tone === "enabled" ? (
      // Pulsing dot signals a live, ticking schedule; CSS gates it on reduced-motion.
      <span className="heartbeat-dot bg-success inline-block h-1.5 w-1.5 rounded-full" />
    ) : (
      <Activity aria-hidden="true" className="h-2.5 w-2.5" />
    )}
    {props.label}
  </span>
);

// The signature visual: a slim ECG strip that scans while the heartbeat is live.
const PULSE_TRACE_POINTS =
  "0,14 40,14 50,14 54,5 58,23 62,14 96,14 160,14 166,14 170,5 174,23 178,14 212,14 240,14";

const PulseTrace: React.FC<{ live: boolean }> = (props) => (
  <svg
    viewBox="0 0 240 28"
    preserveAspectRatio="none"
    className="block h-[26px] w-full"
    aria-hidden="true"
  >
    <line
      x1="0"
      y1="14"
      x2="240"
      y2="14"
      stroke="currentColor"
      strokeWidth="1"
      className="text-secondary"
      opacity="0.18"
    />
    <polyline
      points={PULSE_TRACE_POINTS}
      fill="none"
      stroke={props.live ? "var(--color-success)" : "var(--color-warning)"}
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={props.live ? "heartbeat-trace" : undefined}
      opacity={props.live ? 1 : 0.55}
    />
  </svg>
);

const HeartbeatStat: React.FC<{ label: string; value: React.ReactNode }> = (props) => (
  <div className="flex flex-col gap-0.5">
    <dt className="text-secondary text-[10px] tracking-wide uppercase">{props.label}</dt>
    <dd className="text-foreground leading-tight">{props.value}</dd>
  </div>
);

interface HeartbeatToolCallProps {
  args: HeartbeatToolArgs;
  result?: unknown;
  status?: ToolStatus;
  /** Initial expansion fallback (until the user toggles this tool in the workspace). */
  defaultExpanded?: boolean;
}

export const HeartbeatToolCall: React.FC<HeartbeatToolCallProps> = (props) => {
  const status = props.status ?? "pending";
  const { expanded, toggleExpanded } = useToolExpansion(props.defaultExpanded ?? false);

  const action = props.args.action;
  const errorResult = isToolErrorResult(props.result) ? props.result : null;
  const success = extractHeartbeatSuccess(props.result);
  const settings: HeartbeatSettings | null = success?.settings ?? null;
  const summary = success?.summary ?? null;

  const verb =
    action === "get"
      ? "Read heartbeat"
      : action === "unset"
        ? "Clear heartbeat"
        : "Schedule heartbeat";

  const live = settings?.enabled ?? false;
  const ctx = CONTEXT_MODES[settings?.contextMode ?? HEARTBEAT_DEFAULT_CONTEXT_MODE];
  // WorkspaceService only persists `message` when a custom one is provided, so the
  // common case has no stored text — fall back to the built-in default body and mark
  // it as such, rather than hiding the prompt section entirely. An empty string means
  // the custom message was explicitly cleared, so treat that as "no custom prompt" too.
  const message = settings?.message ?? "";
  const hasCustomMessage = message.length > 0;
  const promptBody = hasCustomMessage ? message : HEARTBEAT_DEFAULT_MESSAGE_BODY;

  // Header pill: live cadence (green), paused (amber), or cleared/not-set (muted).
  let badge: { tone: BadgeTone; label: string } | null = null;
  if (action === "unset") {
    badge = { tone: "cleared", label: "Cleared" };
  } else if (settings) {
    badge = settings.enabled
      ? { tone: "enabled", label: `Every ${formatHeartbeatIntervalShort(settings.intervalMs)}` }
      : { tone: "disabled", label: "Paused" };
  } else if (action === "get" && status === "completed") {
    badge = { tone: "cleared", label: "Not set" };
  }

  return (
    <ToolContainer expanded={expanded} className="@container">
      <ToolHeader onClick={toggleExpanded}>
        <ExpandIcon expanded={expanded}>▶</ExpandIcon>
        <ToolIcon toolName="heartbeat" />
        <span className="text-secondary font-medium whitespace-nowrap">{verb}</span>
        {badge && <HeartbeatBadge tone={badge.tone} label={badge.label} />}
        {summary && (
          <span className="text-foreground hidden truncate italic @sm:inline">{summary}</span>
        )}
        <StatusIndicator status={status}>{getStatusDisplay(status)}</StatusIndicator>
      </ToolHeader>

      {expanded && (
        <ToolDetails>
          {errorResult && <ErrorBox>{errorResult.error}</ErrorBox>}

          {settings && (
            <div className="bg-code-bg space-y-3 rounded px-3 py-2.5 text-[11px] leading-relaxed">
              <PulseTrace live={live} />

              <dl className="grid grid-cols-2 gap-x-6 gap-y-3">
                <HeartbeatStat
                  label="State"
                  value={
                    <span className={live ? "text-success" : "text-warning"}>
                      {live ? "Enabled" : "Paused"}
                    </span>
                  }
                />
                <HeartbeatStat
                  label="Cadence"
                  value={
                    <span className="counter-nums">
                      every {formatHeartbeatInterval(settings.intervalMs)}
                    </span>
                  }
                />
                <HeartbeatStat label="Context" value={ctx.label} />
                <HeartbeatStat label="Trigger" value="When idle" />
              </dl>

              <div className="text-muted text-[10.5px] leading-relaxed">
                {ctx.blurb}.
                {live
                  ? " Fires only after the workspace goes idle for the interval — deferred while you're actively working."
                  : " No check-ins will run until re-enabled."}
              </div>

              <div>
                <div className="text-secondary mb-1 text-[10px] tracking-wide uppercase">
                  Check-in prompt
                  {!hasCustomMessage && (
                    <span className="text-muted tracking-normal normal-case"> · default</span>
                  )}
                </div>
                <div className="text-foreground border-l-2 border-white/10 pl-2.5 italic">
                  {promptBody}
                </div>
              </div>
            </div>
          )}

          {action === "unset" && !errorResult && (
            <div className="text-muted px-3 py-2 text-[11px]">
              Recurring check-ins removed for this workspace.
            </div>
          )}

          {action === "get" && !settings && !errorResult && status === "completed" && (
            <div className="text-muted px-3 py-2 text-[11px] italic">
              No heartbeat is configured for this workspace.
            </div>
          )}

          {status === "executing" && (
            <div className="text-muted px-3 py-2 text-[11px] italic">
              Updating heartbeat settings…
            </div>
          )}
        </ToolDetails>
      )}
    </ToolContainer>
  );
};
