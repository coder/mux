/** Default per-turn usage cap for the experimental advisor tool. */
export const ADVISOR_DEFAULT_MAX_USES_PER_TURN = 3;

/**
 * Shared guidance for when the advisor tool is appropriate.
 * Reused by the tool description now and future system-prompt wiring later.
 */
export const ADVISOR_USAGE_GUIDANCE =
  "Use this when you need help with planning ambiguity or high-impact architectural decisions, " +
  "when weighing tradeoffs between approaches, or after repeated failures when the strategy is unclear.";

/** Description shown to the model when the advisor tool is registered. */
export const ADVISOR_TOOL_DESCRIPTION =
  "Ask a stronger model for strategic advice based on the live conversation transcript. " +
  ADVISOR_USAGE_GUIDANCE;

/** System prompt for the nested advisor model call. */
export const ADVISOR_SYSTEM_PROMPT = `You are an internal strategic advisor assisting another software engineering agent.

Provide concise, actionable advice grounded in the conversation so far.
Focus on the highest-leverage guidance:
- clarify the best strategy when the path is ambiguous
- compare tradeoffs between plausible approaches
- identify key risks, assumptions, and next steps

If the current direction already looks sound, confirm it briefly and explain why.
Advise the calling agent directly; do not ask the user follow-up questions.
Do not call tools.`;
