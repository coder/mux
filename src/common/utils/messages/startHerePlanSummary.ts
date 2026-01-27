import type { MuxMessage } from "@/common/types/message";

const START_HERE_PLAN_PATH_NOTE_MARKER = "*Plan file preserved at:*";

function getTextContent(message: MuxMessage): string {
  return (
    message.parts
      ?.filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n") ?? ""
  );
}

/**
 * The ProposePlanToolCall "Start Here" flow replaces chat history with a single
 * assistant message that contains the full plan and a plan-path footer.
 *
 * We detect that message so we can avoid re-injecting the plan (and avoid telling
 * the exec agent to re-read the plan file), which would waste tokens and often
 * results in redundant file reads.
 */
export function isStartHerePlanSummaryMessage(message: MuxMessage): boolean {
  if (message.role !== "assistant") return false;

  // The Start Here summary is stored as a user-compaction-style message so it
  // survives history replacement and can be distinguished from normal plan output.
  if (message.metadata?.compacted !== "user") return false;
  if (message.metadata?.agentId !== "plan") return false;

  // The Start Here id prefix isn't enough by itself, since Start Here can be used for
  // arbitrary messages. The ProposePlanToolCall Start Here summary always includes the
  // plan-path footer, which is a stronger signal.
  return getTextContent(message).includes(START_HERE_PLAN_PATH_NOTE_MARKER);
}

export function hasStartHerePlanSummary(messages: MuxMessage[]): boolean {
  const lastAssistantMessage = [...messages].reverse().find((m) => m.role === "assistant");
  return lastAssistantMessage ? isStartHerePlanSummaryMessage(lastAssistantMessage) : false;
}
