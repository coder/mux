import type { APIClient } from "@/browser/contexts/API";
import type {
  FastModePreviousServiceTier,
  ServiceTier,
} from "@/common/config/schemas/providersConfig";

export interface FastModeServiceTierChange {
  apiValue: ServiceTier | "";
  serviceTier: ServiceTier | undefined;
  previousServiceTier: FastModePreviousServiceTier | undefined;
}

type ProviderConfigWriter = Pick<APIClient["providers"], "setProviderConfig">;

/**
 * Fast mode is a temporary priority-tier override. The restore target lives in
 * providers.jsonc so every browser origin and desktop client observes the same state.
 */
export function getFastModeServiceTierChange(
  currentServiceTier: ServiceTier | undefined,
  previousServiceTier?: FastModePreviousServiceTier
): FastModeServiceTierChange {
  if (currentServiceTier !== "priority") {
    return {
      apiValue: "priority",
      serviceTier: "priority",
      previousServiceTier: currentServiceTier ?? "unset",
    };
  }

  const restoreServiceTier = previousServiceTier ?? "auto";
  return {
    apiValue: restoreServiceTier === "unset" ? "" : restoreServiceTier,
    serviceTier: restoreServiceTier === "unset" ? undefined : restoreServiceTier,
    previousServiceTier: undefined,
  };
}

/** Persist the shared restore target and service-tier override in a safe order. */
export async function applyFastModeServiceTierChange(
  providers: ProviderConfigWriter,
  currentServiceTier: ServiceTier | undefined,
  previousServiceTier?: FastModePreviousServiceTier
): Promise<FastModeServiceTierChange | null> {
  const change = getFastModeServiceTierChange(currentServiceTier, previousServiceTier);

  if (currentServiceTier !== "priority") {
    const rememberResult = await providers.setProviderConfig({
      provider: "openai",
      keyPath: ["fastModePreviousServiceTier"],
      value: change.previousServiceTier ?? "unset",
    });
    if (!rememberResult.success) return null;
  }

  const tierResult = await providers.setProviderConfig({
    provider: "openai",
    keyPath: ["serviceTier"],
    value: change.apiValue,
  });
  if (!tierResult.success) return null;

  if (currentServiceTier === "priority") {
    const clearResult = await providers.setProviderConfig({
      provider: "openai",
      keyPath: ["fastModePreviousServiceTier"],
      value: "",
    });
    if (!clearResult.success) return null;
  }

  return change;
}
