/**
 * Service-tier helpers shared across the send path, slash commands, and UI.
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
import { getModelProvider } from "./models";

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
 * Slash-command keys that map to a one-shot service tier (e.g. `/fast`, `/slow`).
 * Kept as a const map so the parser, suggestions, and workflow-collision guards
 * stay in sync from a single source.
 */
export const SERVICE_TIER_COMMAND_KEYS = ["fast", "slow"] as const;
export type ServiceTierCommandKey = (typeof SERVICE_TIER_COMMAND_KEYS)[number];

/** Resolve a slash-command key into its service tier, or null when it isn't one. */
export function getServiceTierForCommandKey(key: string): ServiceTier | null {
  if (key === "fast") return SERVICE_TIER_FAST;
  if (key === "slow") return SERVICE_TIER_SLOW;
  return null;
}

/**
 * Whether a model honors a chat-level service-tier override.
 *
 * Today only OpenAI (GPT-class) models support `service_tier`, so we gate on the
 * provider. This is intentionally a single helper so the UI affordance, the send
 * path, and future providers all share one definition of "supported".
 */
export function supportsServiceTier(modelString: string): boolean {
  return getModelProvider(modelString) === "openai";
}

/**
 * Merge a service-tier override into provider options for a given model.
 *
 * Returns the options unchanged when there is no override or the model can't use
 * service tiers, so a stale override never leaks onto an unsupported request.
 * Centralized here so every send path (interactive hook, non-React storage path,
 * and one-shot `/fast` `/slow`) applies the override identically.
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
