import type { MuxMessage } from "@/common/types/message";

const START_HERE_PLAN_PATH_NOTE_MARKER = "*Plan file preserved at:*";
const START_HERE_PLAN_PLACEHOLDER_PREFIX = "*Plan saved to ";

function getTextContent(message: MuxMessage): string {
  return (
    message.parts
      ?.filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n") ?? ""
  );
}

function getPlanBodyText(startHereText: string): string {
  // The footer marker is the most stable, explicit signal that the ProposePlanToolCall
  // Start Here summary was used.
  const textWithoutFooter = startHereText.split(START_HERE_PLAN_PATH_NOTE_MARKER)[0] ?? "";

  // The Start Here content always prefixes the plan with a single H1 title.
  const textWithoutStartHereHeading = textWithoutFooter.replace(/^#.*\n+/, "");

  // ProposePlanToolCall adds a short note to discourage redundant plan-file reads.
  // If the plan content was missing (placeholder-only), we don't want that note to
  // cause a false positive.
  const textWithoutNote = textWithoutStartHereHeading.replace(
    /Note: This chat already contains the full plan[^\n]*/g,
    ""
  );

  return textWithoutNote.trim();
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
  const text = getTextContent(message);
  if (!text.includes(START_HERE_PLAN_PATH_NOTE_MARKER)) return false;

  // ProposePlanToolCall can render Start Here for results without embedded content.
  // In that case, the "plan" body is just a placeholder like: "*Plan saved to …*".
  // We should *not* treat that as a full in-chat plan summary, otherwise exec won't
  // get prompted to read the plan file.
  const planBody = getPlanBodyText(text);
  if (planBody.length === 0) return false;
  if (planBody.startsWith(START_HERE_PLAN_PLACEHOLDER_PREFIX)) return false;

  return true;
}

export function hasStartHerePlanSummary(messages: MuxMessage[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isStartHerePlanSummaryMessage(messages[i])) return true;
  }

  return false;
}
