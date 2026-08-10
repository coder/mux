import type { ReactElement } from "react";
import { BellRing } from "lucide-react";
import type { DisplayedMessage } from "@/common/types/message";
import { BACKGROUND_WORK_WAKE_OPENINGS } from "@/common/utils/machineTurnPrompts";
import { CollapsibleMachineMessage } from "./CollapsibleMachineMessage";

interface BackgroundWorkWakeMessageProps {
  message: DisplayedMessage & { type: "user" };
  summary: string;
  className?: string;
}

export function getBackgroundWorkWakeSummary(content: string): string | null {
  const normalized = content.trimStart();
  if (normalized.startsWith(BACKGROUND_WORK_WAKE_OPENINGS.workspaceTurnsTerminal)) {
    return "Background workspace turn finished";
  }
  if (normalized.startsWith(BACKGROUND_WORK_WAKE_OPENINGS.awaitableWorkActive)) {
    return "Waiting for background work";
  }
  if (normalized.startsWith(BACKGROUND_WORK_WAKE_OPENINGS.subagentsCompleted)) {
    return "Background sub-agents finished";
  }
  if (normalized.startsWith(BACKGROUND_WORK_WAKE_OPENINGS.subagentsFailed)) {
    return "Background sub-agents failed";
  }
  return null;
}

/**
 * Background-work prompts are machine-authored control events, not user input. Keep the exact
 * model-facing directive inspectable without letting implementation details dominate the transcript.
 */
export function BackgroundWorkWakeMessage(props: BackgroundWorkWakeMessageProps): ReactElement {
  return (
    <CollapsibleMachineMessage
      content={props.message.content}
      summary={props.summary}
      icon={<BellRing aria-hidden="true" className="size-3.5 shrink-0" />}
      marker="background-work-wake"
      className={props.className}
    />
  );
}
