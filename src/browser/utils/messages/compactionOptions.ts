/**
 * Compaction options transformation
 *
 * Single source of truth for converting compaction metadata into SendMessageOptions.
 * Used by both ChatInput (initial send) and useResumeManager (resume after interruption).
 */

import { readPersistedState } from "@/browser/hooks/usePersistedState";
import { AGENT_AI_DEFAULTS_KEY } from "@/common/constants/storage";
import type { SendMessageOptions } from "@/common/orpc/types";
import type { CompactionRequestData } from "@/common/types/message";
import type { AgentAiDefaults } from "@/common/types/agentAiDefaults";
import { coerceThinkingLevel } from "@/common/types/thinking";
import { enforceThinkingPolicy } from "@/common/utils/thinking/policy";

/**
 * Apply compaction-specific option overrides to base options.
 *
 * This function is the single source of truth for how compaction metadata
 * transforms workspace defaults. Both initial sends and stream resumption
 * use this function to ensure consistent behavior.
 *
 * @param baseOptions - Workspace default options (from localStorage or useSendMessageOptions)
 * @param compactData - Compaction request metadata from /compact command
 * @returns Final SendMessageOptions with compaction overrides applied
 */
export function applyCompactionOverrides(
  baseOptions: SendMessageOptions,
  compactData: CompactionRequestData
): SendMessageOptions {
  const compactionModel = compactData.model ?? baseOptions.model;

  const agentAiDefaults = readPersistedState<AgentAiDefaults>(AGENT_AI_DEFAULTS_KEY, {});
  const preferredThinking = agentAiDefaults.compact?.thinkingLevel;

  const requestedThinking =
    coerceThinkingLevel(preferredThinking ?? baseOptions.thinkingLevel) ?? "off";
  const thinkingLevel = enforceThinkingPolicy(compactionModel, requestedThinking);

  return {
    ...baseOptions,
    agentId: "compact",
    model: compactionModel,
    thinkingLevel,
    maxOutputTokens: compactData.maxOutputTokens,
    // Disable all tools during compaction - regex .* matches all tool names
    toolPolicy: [{ regex_match: ".*", action: "disable" }],
  };
}
