import { matchesNameBySegmentPrefix } from "@/browser/utils/suggestionMatching";
import type { SlashSuggestion } from "@/browser/utils/slashCommands/types";
import type { AgentSkillDescriptor } from "@/common/types/agentSkill";

interface InlineSkillSuggestionContext {
  /** The token typed after `$`. Empty string is allowed (just typed `$`). */
  partial: string;
  /** Already-loaded descriptors for current discovery target. */
  descriptors: AgentSkillDescriptor[];
}

interface InlineSkillSuggestionRefreshContext {
  inputChanged: boolean;
  previousPartial: string | null;
  partial: string;
  previousDescriptors: AgentSkillDescriptor[] | null;
  descriptors: AgentSkillDescriptor[];
}

const INLINE_SKILL_INSERT_EXISTING_SEPARATOR_RE = /[\s.,;:!?)\]}>"'`]/;

export function shouldRefreshInlineSkillSuggestions(
  context: InlineSkillSuggestionRefreshContext
): boolean {
  return (
    context.inputChanged ||
    context.previousPartial !== context.partial ||
    context.previousDescriptors !== context.descriptors
  );
}

export function getInlineSkillInsertionTrailingText(after: string): "" | " " {
  // At end-of-input, add a space so the cursor is ready for continued typing.
  // Before whitespace, punctuation, or closers, skip the space to avoid doubling.
  if (after.length === 0) return " ";
  if (INLINE_SKILL_INSERT_EXISTING_SEPARATOR_RE.test(after[0] ?? "")) return "";
  return " ";
}

/**
 * Returns suggestions for `$skill` autocomplete.
 *
 * - Filter rule: full-name prefix or hyphen-segment prefix, matching slash skill commands.
 * - Empty `partial` returns the full descriptor list (so typing just `$` opens the menu).
 * - Result order: descriptors order from caller (no re-sort). Caller already lists in
 *   scope-priority order.
 * - We do NOT filter out skills whose name collides with a slash command (e.g. `clear`):
 *   `$clear` should reference a skill named `clear` even though `/clear` is a built-in.
 * - user-invocable: false skills are hidden (inline `$skill` is a user-facing surface).
 */
export function getInlineSkillSuggestions(
  context: InlineSkillSuggestionContext
): SlashSuggestion[] {
  return context.descriptors
    .filter((descriptor) => descriptor.userInvocable !== false)
    .filter((descriptor) => matchesNameBySegmentPrefix(descriptor.name, context.partial))
    .map((descriptor) => ({
      id: `inline-skill:${descriptor.name}`,
      display: `$${descriptor.name}`,
      description: descriptor.description ?? "",
      replacement: `$${descriptor.name}`,
    }));
}
