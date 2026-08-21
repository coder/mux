/**
 * Pure field-wise resolver for agent AI settings (model, thinkingLevel,
 * reasoningMode). Every execution surface resolves through this one precedence
 * order; adapters differ only in which input tiers they supply:
 *
 *   1. explicit invocation overrides
 *   2. target workspace per-agent bucket
 *   3. target configured profile (delegated `subagent` override, then base)
 *   4. target definition frontmatter `ai` defaults
 *   5. ancestors child to root (config profile, then definition defaults);
 *      implicit fallback ancestors contribute reasoningMode only
 *   6. parent runtime hint
 *   7. root workspace / activity fallbacks
 *   8. system fallback (default model, thinking off, no reasoning preference)
 *
 * Each field resolves independently: a model-only value at a higher tier never
 * blocks thinking or reasoning from lower tiers. Invalid persisted/config
 * candidates fall through with a diagnostic (self-healing); invalid explicit
 * values throw so callers surface an error instead of silently running a
 * fallback model. No I/O, no logging.
 */

import { DEFAULT_MODEL } from "@/common/constants/knownModels";
import type {
  AgentAiSettingsLayerValues,
  AiSettingSource,
  ResolveAgentAiSettingsInput,
  ResolvedAgentAiSettings,
} from "@/common/types/agentAiSettings";
import {
  coerceOpenAIReasoningMode,
  coerceThinkingLevel,
  type OpenAIReasoningMode,
  type ThinkingLevel,
} from "@/common/types/thinking";
import { normalizeModelInput } from "@/common/utils/ai/normalizeModelInput";
import { openaiProModeAvailable } from "@/common/utils/ai/proMode";
import {
  enforceThinkingPolicy,
  lookupMinThinkingLevelOverride,
  resolveMinimumThinkingLevel,
  resolveThinkingInput,
} from "@/common/utils/thinking/policy";

export class InvalidExplicitAiSettingError extends Error {
  readonly field: "model";
  readonly value: string;

  constructor(field: "model", value: string) {
    super(`Invalid explicit ${field}: "${value}"`);
    this.name = "InvalidExplicitAiSettingError";
    this.field = field;
    this.value = value;
  }
}

interface Candidate {
  values: AgentAiSettingsLayerValues;
  source: AiSettingSource;
  /** Implicit fallback ancestors inherit reasoningMode only. */
  reasoningOnly?: boolean;
}

function buildCandidates(input: ResolveAgentAiSettingsInput): Candidate[] {
  const candidates: Candidate[] = [];
  const defaults = input.agentAiDefaults ?? {};

  if (input.targetWorkspaceSettings) {
    candidates.push({
      values: input.targetWorkspaceSettings,
      source: { tier: "workspace", agentId: input.targetAgentId },
    });
  }

  const pushConfig = (agentId: string, reasoningOnly: boolean) => {
    const entry = defaults[agentId];
    if (!entry) return;
    if (input.profile === "subagent" && entry.subagent) {
      candidates.push({
        values: {
          model: entry.subagent.modelString,
          thinkingLevel: entry.subagent.thinkingLevel,
          reasoningMode: entry.subagent.reasoningMode,
        },
        source: { tier: "config-subagent", agentId },
        reasoningOnly,
      });
    }
    candidates.push({
      values: {
        model: entry.modelString,
        thinkingLevel: entry.thinkingLevel,
        reasoningMode: entry.reasoningMode,
      },
      source: { tier: "config", agentId },
      reasoningOnly,
    });
  };

  pushConfig(input.targetAgentId, false);

  if (input.targetDefinitionAiDefaults) {
    candidates.push({
      values: {
        model: input.targetDefinitionAiDefaults.model,
        thinkingLevel: input.targetDefinitionAiDefaults.thinkingLevel,
      },
      source: { tier: "definition", agentId: input.targetAgentId },
    });
  }

  for (const ancestor of input.ancestors ?? []) {
    if (ancestor.agentId === input.targetAgentId) continue;
    const reasoningOnly = !ancestor.declared;
    pushConfig(ancestor.agentId, reasoningOnly);
    if (ancestor.definitionAiDefaults && ancestor.declared) {
      candidates.push({
        values: {
          model: ancestor.definitionAiDefaults.model,
          thinkingLevel: ancestor.definitionAiDefaults.thinkingLevel,
        },
        source: { tier: "definition", agentId: ancestor.agentId },
      });
    }
  }

  if (input.parentRuntime) {
    candidates.push({ values: input.parentRuntime, source: { tier: "parent-runtime" } });
  }

  for (const fallback of input.fallbacks ?? []) {
    candidates.push({ values: fallback, source: { tier: "fallback" } });
  }

  return candidates;
}

export function resolveAgentAiSettings(
  input: ResolveAgentAiSettingsInput
): ResolvedAgentAiSettings {
  const diagnostics: string[] = [];
  const candidates = buildCandidates(input);
  const providersConfig = input.providersConfig ?? null;

  // --- model ---
  let selectedModel: string | undefined;
  let modelSource: AiSettingSource | undefined;

  const explicitModel =
    typeof input.explicit?.model === "string" && input.explicit.model.trim().length > 0
      ? input.explicit.model
      : undefined;
  if (explicitModel !== undefined) {
    const normalized = normalizeModelInput(explicitModel).model;
    if (normalized == null) {
      throw new InvalidExplicitAiSettingError("model", explicitModel);
    }
    selectedModel = normalized;
    modelSource = { tier: "explicit" };
  } else {
    for (const candidate of candidates) {
      if (candidate.reasoningOnly) continue;
      const raw = candidate.values.model;
      if (typeof raw !== "string" || raw.trim().length === 0) continue;
      const normalized = normalizeModelInput(raw).model;
      if (normalized == null) {
        diagnostics.push(`skipped invalid model "${raw}" from ${candidate.source.tier}`);
        continue;
      }
      selectedModel = normalized;
      modelSource = candidate.source;
      break;
    }
  }

  if (selectedModel === undefined || modelSource === undefined) {
    const fallbackDefault = normalizeModelInput(input.defaultModel).model ?? DEFAULT_MODEL;
    selectedModel = fallbackDefault;
    modelSource = { tier: "default" };
  }

  // --- thinkingLevel (numeric explicit input maps into the resolved model's policy) ---
  let selectedThinking: ThinkingLevel | undefined;
  let thinkingSource: AiSettingSource | undefined;

  if (input.explicit?.thinkingLevel != null) {
    selectedThinking = resolveThinkingInput(
      input.explicit.thinkingLevel,
      selectedModel,
      providersConfig
    );
    thinkingSource = { tier: "explicit" };
  } else {
    for (const candidate of candidates) {
      if (candidate.reasoningOnly) continue;
      if (candidate.values.thinkingLevel === undefined) continue;
      const coerced = coerceThinkingLevel(candidate.values.thinkingLevel);
      if (coerced === undefined) {
        diagnostics.push(
          `skipped invalid thinkingLevel "${String(candidate.values.thinkingLevel)}" from ${candidate.source.tier}`
        );
        continue;
      }
      selectedThinking = coerced;
      thinkingSource = candidate.source;
      break;
    }
  }

  if (selectedThinking === undefined || thinkingSource === undefined) {
    selectedThinking = "off";
    thinkingSource = { tier: "default" };
  }

  // --- reasoningMode ---
  let selectedReasoning: OpenAIReasoningMode | undefined;
  let reasoningSource: AiSettingSource | undefined;

  if (input.explicit?.reasoningMode != null) {
    selectedReasoning = input.explicit.reasoningMode;
    reasoningSource = { tier: "explicit" };
  } else {
    for (const candidate of candidates) {
      if (candidate.values.reasoningMode === undefined) continue;
      const coerced = coerceOpenAIReasoningMode(candidate.values.reasoningMode);
      if (coerced === undefined) {
        diagnostics.push(
          `skipped invalid reasoningMode "${String(candidate.values.reasoningMode)}" from ${candidate.source.tier}`
        );
        continue;
      }
      selectedReasoning = coerced;
      reasoningSource = candidate.source;
      break;
    }
  }

  // --- effective values (provider-safe) ---
  const minThinkingFloor = resolveMinimumThinkingLevel(
    selectedModel,
    lookupMinThinkingLevelOverride(input.minThinkingLevelByModel, selectedModel),
    providersConfig
  );
  const effectiveThinking = enforceThinkingPolicy(
    selectedModel,
    selectedThinking,
    minThinkingFloor,
    providersConfig
  );

  const proAvailable =
    input.proModeAvailable ?? openaiProModeAvailable(selectedModel, { providersConfig });
  const reasoningUnavailable = selectedReasoning === "pro" && !proAvailable;
  const effectiveReasoning = reasoningUnavailable ? undefined : selectedReasoning;

  return {
    selected: {
      model: selectedModel,
      thinkingLevel: selectedThinking,
      ...(selectedReasoning !== undefined ? { reasoningMode: selectedReasoning } : {}),
    },
    effective: {
      model: selectedModel,
      thinkingLevel: effectiveThinking,
      ...(effectiveReasoning !== undefined ? { reasoningMode: effectiveReasoning } : {}),
    },
    sources: {
      model: modelSource,
      thinkingLevel: thinkingSource,
      ...(reasoningSource !== undefined ? { reasoningMode: reasoningSource } : {}),
    },
    adjustments: {
      thinkingClamped: effectiveThinking !== selectedThinking,
      reasoningUnavailable,
    },
    diagnostics,
  };
}
