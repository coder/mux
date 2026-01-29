/**
 * Hash skill (#skill) suggestions generation.
 *
 * Unlike slash commands (which must be at the start of input), hash skill mentions
 * can appear anywhere in the message, allowing multiple skills in one message.
 */

import type { AgentSkillDescriptor } from "@/common/types/agentSkill";
import type { SlashSuggestion } from "./slashCommands/types";
import { findHashSkillAtCursor } from "@/common/utils/hashSkillMentions";

export interface HashSkillSuggestionContext {
  agentSkills?: AgentSkillDescriptor[];
}

export interface HashSkillSuggestionResult {
  suggestions: SlashSuggestion[];
  match: { startIndex: number; endIndex: number } | null;
}

const formatScopeLabel = (scope: string): string => {
  if (scope === "global") {
    return "user";
  }
  return scope;
};

/**
 * Get hash skill suggestions based on the current cursor position.
 *
 * Returns suggestions only when the cursor is within a #skill token.
 */
export function getHashSkillSuggestions(
  input: string,
  cursor: number,
  context: HashSkillSuggestionContext = {}
): HashSkillSuggestionResult {
  const match = findHashSkillAtCursor(input, cursor);

  if (!match) {
    return { suggestions: [], match: null };
  }

  const partial = match.query.toLowerCase();
  const skills = context.agentSkills ?? [];

  const suggestions = skills
    .filter((skill) => {
      if (!partial) return true;
      return skill.name.toLowerCase().startsWith(partial);
    })
    .map((skill) => ({
      id: `hash-skill:${skill.name}`,
      display: `#${skill.name}`,
      description: `${skill.description} (${formatScopeLabel(skill.scope)})`,
      replacement: `#${skill.name}`,
    }));

  return {
    suggestions,
    match: { startIndex: match.startIndex, endIndex: match.endIndex },
  };
}
