import type { SlashSuggestion } from "@/browser/utils/slashCommands/types";
import type { AgentSkillDescriptor } from "@/common/types/agentSkill";

export interface InlineSkillSuggestionContext {
  /** The token typed after `$`. Empty string is allowed (just typed `$`). */
  partial: string;
  /** Already-loaded descriptors for current discovery target. */
  descriptors: AgentSkillDescriptor[];
}

/**
 * Returns suggestions for `$skill` autocomplete.
 *
 * - Filter rule: descriptor.name.startsWith(partial). Case-sensitive skill names are
 *   canonical lowercase IDs (validated by SkillNameSchema), so normalize the user's partial.
 * - Empty `partial` returns the full descriptor list (so typing just `$` opens the menu).
 * - Result order: descriptors order from caller (no re-sort). Caller already lists in
 *   scope-priority order.
 * - We do NOT filter out skills whose name collides with a slash command (e.g. `clear`):
 *   `$clear` should reference a skill named `clear` even though `/clear` is a built-in.
 */
export function getInlineSkillSuggestions(
  context: InlineSkillSuggestionContext
): SlashSuggestion[] {
  const lowered = context.partial.toLowerCase();
  return context.descriptors
    .filter((descriptor) => descriptor.name.startsWith(lowered))
    .map((descriptor) => ({
      id: `inline-skill:${descriptor.name}`,
      display: `$${descriptor.name}`,
      description: descriptor.description ?? "",
      replacement: `$${descriptor.name}`,
    }));
}
