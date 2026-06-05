/**
 * Service-tier helpers shared across the send path and UI.
 *
 * A "service tier" tells the provider how to schedule a request. OpenAI exposes
 * this as `service_tier` (e.g. `priority` for low latency, `flex` for cheaper but
 * slower). To keep the product generic for future providers, we surface it in the
 * UI as **Fast** / **Slow** rather than the provider-specific wire values.
 *
 * Mapping (the only place this translation should live):
 * - Fast → `priority` (low latency, higher cost)
 * - Slow → `flex`     (lower cost, higher latency)
 * - Auto → no override (falls back to the provider/global default)
 */

import { type ServiceTier } from "@/common/config/schemas/providersConfig";
import type { MuxProviderOptions } from "@/common/types/providerOptions";
import { PROVIDER_DEFINITIONS } from "@/common/constants/providers";
import { getExplicitGatewayPrefix, getModelProvider } from "./models";

/** Wire value for the user-facing "Fast" speed. */
export const SERVICE_TIER_FAST: ServiceTier = "priority";
/** Wire value for the user-facing "Slow" speed. */
export const SERVICE_TIER_SLOW: ServiceTier = "flex";

/** Generic, provider-agnostic speed buckets used for UI state and styling. */
export type ServiceTierSpeed = "fast" | "slow" | "default";

/** Collapse a concrete service tier (or absence of one) into a UI speed bucket. */
export function getServiceTierSpeed(tier: ServiceTier | null | undefined): ServiceTierSpeed {
  if (tier === SERVICE_TIER_FAST) return "fast";
  if (tier === SERVICE_TIER_SLOW) return "slow";
  // "auto" / "default" / null / undefined all render as the neutral (grey) state.
  return "default";
}

/** Human-readable label for a speed bucket. */
export function getServiceTierSpeedLabel(speed: ServiceTierSpeed): string {
  switch (speed) {
    case "fast":
      return "Fast";
    case "slow":
      return "Slow";
    case "default":
      return "Auto";
  }
}

/**
 * Whether a model honors a chat-level service-tier override.
 *
 * Today only OpenAI (GPT-class) models support `service_tier`. Critically, the
 * backend only forwards `providerOptions.openai.serviceTier` when the request is
 * routed either directly to OpenAI or through a *passthrough* gateway. Non-passthrough
 * gateways (e.g. openrouter, github-copilot) drop the field, so a model like
 * `openrouter:openai/gpt-5` — which canonicalizes to `openai` — would silently ignore
 * the tier. We mirror that routing here so the UI never advertises a no-op override.
 *
 * This is intentionally a single helper so the UI affordance, the send path, and
 * future providers all share one definition of "supported".
 */
export function supportsServiceTier(modelString: string): boolean {
  if (getModelProvider(modelString) !== "openai") {
    return false;
  }
  const gatewayPrefix = getExplicitGatewayPrefix(modelString);
  if (gatewayPrefix) {
    // Only passthrough gateways forward OpenAI provider options to the request.
    const def = PROVIDER_DEFINITIONS[gatewayPrefix];
    return def != null && "passthrough" in def && def.passthrough === true;
  }
  return true;
}

/**
 * Merge a service-tier override into provider options for a given model.
 *
 * Returns the options unchanged when there is no override or the model can't use
 * service tiers, so a stale override never leaks onto an unsupported request.
 * Centralized here so every send path (interactive hook and non-React storage path)
 * applies the override identically.
 */
export function withServiceTierOverride(
  providerOptions: MuxProviderOptions,
  serviceTier: ServiceTier | null | undefined,
  modelString: string
): MuxProviderOptions {
  if (!serviceTier || !supportsServiceTier(modelString)) {
    return providerOptions;
  }
  return {
    ...providerOptions,
    openai: { ...providerOptions.openai, serviceTier },
  };
}
