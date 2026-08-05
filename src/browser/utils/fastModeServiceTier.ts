import { readPersistedState, updatePersistedState } from "@/browser/hooks/usePersistedState";
import { FAST_MODE_PREVIOUS_SERVICE_TIER_KEY } from "@/common/constants/storage";
import type { ServiceTier } from "@/common/config/schemas/providersConfig";

type RestorableServiceTier = Exclude<ServiceTier, "priority">;
type PersistedPreviousServiceTier = RestorableServiceTier | "unset";

export interface FastModeServiceTierChange {
  apiValue: ServiceTier | "";
  serviceTier: ServiceTier | undefined;
  previousServiceTier: PersistedPreviousServiceTier | undefined;
}

/**
 * Fast mode is a temporary priority-tier override. Remember the user's current
 * non-priority tier so turning Fast off restores flex/default/unset instead of
 * silently replacing it with auto.
 */
export function getFastModeServiceTierChange(
  currentServiceTier: ServiceTier | undefined
): FastModeServiceTierChange {
  if (currentServiceTier !== "priority") {
    return {
      apiValue: "priority",
      serviceTier: "priority",
      previousServiceTier: currentServiceTier ?? "unset",
    };
  }

  const previousServiceTier = readPersistedState<PersistedPreviousServiceTier>(
    FAST_MODE_PREVIOUS_SERVICE_TIER_KEY,
    "auto"
  );
  return {
    apiValue: previousServiceTier === "unset" ? "" : previousServiceTier,
    serviceTier: previousServiceTier === "unset" ? undefined : previousServiceTier,
    previousServiceTier: undefined,
  };
}

/** Persist the restore target only after the provider config mutation succeeds. */
export function commitFastModeServiceTierChange(change: FastModeServiceTierChange): void {
  updatePersistedState(FAST_MODE_PREVIOUS_SERVICE_TIER_KEY, change.previousServiceTier);
}
