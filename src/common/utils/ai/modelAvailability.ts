import type { ProvidersConfigMap } from "@/common/orpc/types";
import { isModelAvailable } from "@/common/routing";
import { isGatewayModelAccessibleFromAuthoritativeCatalog } from "@/common/utils/providers/gatewayModelCatalog";

/**
 * Can the current routing state actually serve this model?
 *
 * Wraps the routing layer's isModelAvailable with the same provider
 * predicates the Settings UI uses (useRouting): a provider counts as
 * configured when `isConfigured` is set and it is not disabled, and gateway
 * accessibility consults the authoritative model catalog. Route priority and
 * per-model overrides are honored, so a gateway that is configured but not in
 * the priority list does not count — matching what a send would really do.
 *
 * Callers that cannot obtain a ProvidersConfigMap (degraded state, minimal
 * test mocks) must skip the check rather than pass an empty map:
 * "cannot determine" is not "unavailable".
 */
export function isModelServableWithProvidersConfig(args: {
  canonicalModel: string;
  routePriority?: string[];
  routeOverrides?: Record<string, string>;
  providersConfig: ProvidersConfigMap;
}): boolean {
  const providersConfig = args.providersConfig;
  return isModelAvailable(
    args.canonicalModel,
    args.routePriority ?? ["direct"],
    args.routeOverrides ?? {},
    (provider) =>
      providersConfig[provider]?.isConfigured === true &&
      providersConfig[provider]?.isEnabled !== false,
    (gateway, modelId) =>
      isGatewayModelAccessibleFromAuthoritativeCatalog(
        gateway,
        modelId,
        providersConfig[gateway]?.models,
        providersConfig[gateway]?.discoveredModels,
        providersConfig[gateway]?.removedModels
      )
  );
}
