import type { TimelineEventKind } from "@/common/orpc/schemas/timeline";
import { WORKFLOW_RESULT_MESSAGE_OPENING } from "@/common/utils/workflowRunMessages";

// Fallback openings used when specific muxMetadata is absent or only a persisted digest remains.
// Prompt producers and timeline classification share them so their wording cannot drift.
export const BASH_MONITOR_WAKE_HEADINGS = {
  matched: "A background bash monitor matched output.",
  lost: "Mux restarted and background bash monitors were lost.",
  mixed: "Background bash monitor updates (including monitors lost to a Mux restart).",
} as const;

export const BACKGROUND_WORK_WAKE_OPENINGS = {
  subagentsCompleted: "Background sub-agent task(s) have completed.",
  subagentsFailed: "Background sub-agent task(s) failed terminally and will not produce reports.",
  workspaceTurnsTerminal: "Background workspace turn(s) have reached a terminal state:",
  awaitableWorkActive: "You have active background ",
} as const;

const PROMPT_OPENINGS_BY_KIND: ReadonlyArray<{
  kind: TimelineEventKind;
  openings: readonly string[];
}> = [
  { kind: "turn.monitor_wake", openings: Object.values(BASH_MONITOR_WAKE_HEADINGS) },
  { kind: "workflow.result", openings: [WORKFLOW_RESULT_MESSAGE_OPENING] },
  { kind: "turn.background_wake", openings: Object.values(BACKGROUND_WORK_WAKE_OPENINGS) },
];

/**
 * Classifies a machine-authored turn from its prompt text. Also used on persisted timeline rows,
 * whose digest is whitespace-collapsed, so every opening above must stay single-spaced.
 */
export function classifyMachineTurnPromptKind(text: string): TimelineEventKind | null {
  const normalized = text.trimStart();
  for (const entry of PROMPT_OPENINGS_BY_KIND) {
    if (entry.openings.some((opening) => normalized.startsWith(opening))) {
      return entry.kind;
    }
  }
  return null;
}
