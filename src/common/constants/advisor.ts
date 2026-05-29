import type { AdvisorPackage } from "@/common/types/advisor";

/** Fallback per-turn usage cap when an advisor file doesn't override it. */
export const ADVISOR_DEFAULT_MAX_USES_PER_TURN = 3;

/** Tail-biased truncation budget for same-step commentary included in advisor handoffs. */
export const ADVISOR_HANDOFF_MAX_TEXT_CHARS = 4000;

/** Tail-biased truncation budget for same-step reasoning included in advisor handoffs. */
export const ADVISOR_HANDOFF_MAX_REASONING_CHARS = 4000;

/**
 * Shared guidance for when and how to use the advisor tool.
 *
 * Lives on the tool description (rebuilt per stream so the live advisor
 * catalog inlines below it). Repeating this in the system prompt is
 * intentionally avoided post-GA: the model attends to tool descriptions
 * during selection more reliably than to prose buried in the system message,
 * and the duplicate text spent prompt-budget for no quality lift.
 */
export const ADVISOR_USAGE_GUIDANCE =
  "Use this when you need help with planning ambiguity or high-impact architectural decisions, " +
  "when weighing tradeoffs between approaches, or after repeated failures when the strategy is unclear. " +
  "The advisor has no tools — it cannot read files, run commands, search code, or browse — and only " +
  "sees the existing conversation transcript plus your `question`. Before calling, make sure the " +
  "relevant files, errors, and options are already visible in the transcript (read them first) or paste " +
  "the essential excerpts into `question`. Frame a specific decision or tradeoff; do not ask the advisor " +
  "to investigate something it cannot see.";

/**
 * Static base description for the advisor tool.
 *
 * The executor wraps this with the configured advisor catalog at registration
 * time (see {@link buildAdvisorToolDescription}). This base value is only
 * surfaced when an advisor catalog is unavailable (e.g., when introspecting
 * TOOL_DEFINITIONS shapes in tests).
 */
export const ADVISOR_TOOL_DESCRIPTION =
  "Ask a configured advisor for strategic guidance based on the live conversation transcript. " +
  ADVISOR_USAGE_GUIDANCE +
  " Pass `advisor_name` to select which advisor handles the request and a brief `question` summarizing the decision or ambiguity.";

/**
 * Build the runtime tool description that lists the live advisor catalog.
 *
 * The catalog is injected into the description so the model has a single
 * authoritative location to discover available advisors. Keeping the catalog
 * out of the system prompt mirrors how skills + sub-agent descriptors are
 * surfaced via tool descriptions instead of free-form prompt text.
 */
export function buildAdvisorToolDescription(
  advisors: ReadonlyArray<Pick<AdvisorPackage, "directoryName" | "frontmatter">>
): string {
  if (advisors.length === 0) {
    // The tool should never be registered without at least one advisor — but
    // returning a useful description here makes failures debuggable rather
    // than blank.
    return `${ADVISOR_TOOL_DESCRIPTION}\n\nNo advisors configured. The user must add at least one ADVISOR.md file before this tool can be used.`;
  }

  const lines: string[] = [];
  lines.push(ADVISOR_TOOL_DESCRIPTION);
  lines.push("");
  lines.push("Available advisors:");
  for (const advisor of advisors) {
    // `description` is single-line per the schema; collapse defensively in
    // case authors slip a newline through YAML.
    const description = advisor.frontmatter.description.replace(/\s+/g, " ").trim();
    lines.push(`- ${advisor.directoryName}: ${description}`);
  }
  return lines.join("\n");
}

/**
 * System prompt for the nested advisor model call.
 *
 * Per-advisor body fragments append to this base prompt at execute time —
 * the base sets the role boundary the calling assistant cannot violate, and
 * the body adds advisor-specific persona/voice/focus.
 */
export const ADVISOR_SYSTEM_PROMPT = `You are a strategic advisor for the calling assistant.

Your job is to help the calling assistant decide what to do next based on the live conversation transcript.
You are not the assistant responding to the end user.
You have no tools available. You cannot execute commands, inspect files, edit code, browse, or call tools.

Provide concise, actionable guidance grounded in the conversation so far.
Focus on the highest-leverage advice:
- clarify the best strategy when the path is ambiguous
- compare tradeoffs between plausible approaches
- identify key risks, assumptions, and next steps

Address the calling assistant directly, not the end user.
Do not ask the end user follow-up questions.
Do not speak as if you are about to take actions yourself.
Do not narrate tool use, file inspection, or implementation steps as your own actions.
You may suggest user-facing wording when helpful, but keep the response addressed to the calling assistant.

If the current direction already looks sound, confirm it briefly and explain why.
Keep the response concise and pointed.
The final user message may contain a structured advisor handoff summarizing the immediate consultation request and same-step context.`;

/**
 * Compose the per-advisor system prompt by appending the advisor's body to
 * the shared base. The body is optional — when omitted, the base prompt
 * is used unchanged.
 */
export function composeAdvisorSystemPrompt(advisorBody: string | undefined): string {
  const body = advisorBody?.trim();
  if (!body) {
    return ADVISOR_SYSTEM_PROMPT;
  }
  return `${ADVISOR_SYSTEM_PROMPT}\n\n${body}`;
}
