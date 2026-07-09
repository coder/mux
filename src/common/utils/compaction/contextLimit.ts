/**
 * Shared context limit utilities for compaction logic.
 *
 * Used by autoCompactionCheck and contextSwitchCheck to calculate
 * effective context limits accounting for auth-route caps and the 1M context toggle.
 */

import {
  getCodexOauthCompatibilityModelId,
  getCodexOauthContextWindowOverride,
  isCodexOauthAllowedModel,
  isCodexOauthRequiredModel,
} from "@/common/constants/codexOAuth";
import type { ProvidersConfigMap } from "@/common/orpc/types";
import { supports1MContext } from "@/common/utils/ai/models";
import {
  getModelContextWindowOverride,
  resolveModelForMetadata,
} from "@/common/utils/providers/modelEntries";
import { getModelStats } from "@/common/utils/tokens/modelStats";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function hasNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function hasCodexOauthTokens(config: unknown): boolean {
  const record = asRecord(config);
  if (!record) {
    return false;
  }

  if (record.codexOauthSet === true) {
    return true;
  }

  // Backend compaction can receive raw providers.jsonc config in older tests/fallback paths.
  // Detect the stored token shape without importing node-only OAuth parsing into common code.
  const oauth = asRecord(record.codexOauth);
  return (
    oauth?.type === "oauth" &&
    hasNonEmptyString(oauth.access) &&
    hasNonEmptyString(oauth.refresh) &&
    typeof oauth.expires === "number" &&
    Number.isFinite(oauth.expires)
  );
}

function hasOpenAIApiKey(config: unknown): boolean {
  const record = asRecord(config);
  if (!record) {
    return false;
  }

  const apiKeySource = record.apiKeySource;
  if (apiKeySource === "config" || apiKeySource === "file" || apiKeySource === "env") {
    return true;
  }

  return record.apiKeySet === true || hasNonEmptyString(record.apiKey);
}

function getCodexOauthContextLimit(
  model: string,
  providersConfig: ProvidersConfigMap | null
): number | null {
  const compatibilityModelId = getCodexOauthCompatibilityModelId(model, providersConfig);
  if (compatibilityModelId === null || !isCodexOauthAllowedModel(model, providersConfig)) {
    return null;
  }

  const oauthLimit = getCodexOauthContextWindowOverride(compatibilityModelId);
  if (oauthLimit == null) {
    return null;
  }

  const openAIConfig = providersConfig?.openai;
  if (!hasCodexOauthTokens(openAIConfig)) {
    return null;
  }

  if (isCodexOauthRequiredModel(model, providersConfig)) {
    return oauthLimit;
  }

  if (!hasOpenAIApiKey(openAIConfig)) {
    return oauthLimit;
  }

  const record = asRecord(openAIConfig);
  return record?.codexOauthDefaultAuth === "apiKey" ? null : oauthLimit;
}

/**
 * Get effective context limit for a model, accounting for custom overrides, auth-route caps, and 1M toggle.
 *
 * @param model - Model ID (e.g., "anthropic:claude-sonnet-4-5")
 * @param use1M - Whether 1M context is enabled in settings
 * @param providersConfig - Provider configuration map for custom model overrides
 * @returns Max input tokens, or null if no limit is known
 */
export function getEffectiveContextLimit(
  model: string,
  use1M: boolean,
  providersConfig: ProvidersConfigMap | null = null
): number | null {
  const metadataModel = resolveModelForMetadata(model, providersConfig);
  const customOverride = getModelContextWindowOverride(model, providersConfig);
  const stats = getModelStats(metadataModel);
  const baseLimit = customOverride ?? stats?.max_input_tokens ?? null;
  if (!baseLimit) return null;

  // ChatGPT/Codex OAuth can impose a smaller routing-layer cap than the public OpenAI
  // API metadata. Cap the effective window so auto-compaction and token meters compact
  // before OAuth requests reach provider-side validation failures.
  const codexOauthLimit = getCodexOauthContextLimit(model, providersConfig);
  if (codexOauthLimit != null) {
    return Math.min(baseLimit, codexOauthLimit);
  }

  // Anthropic's optional 1M beta is a runtime capability, so it must be gated on the
  // runtime model, not the mapped metadata model. Native 1M models already expose their
  // larger window through model stats above.
  if (supports1MContext(model) && use1M) return 1_000_000;
  return baseLimit;
}
