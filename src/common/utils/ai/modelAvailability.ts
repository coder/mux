import type { ProvidersConfigMap } from "@/common/orpc/types";
import { isModelAvailable } from "@/common/routing";
import { isGatewayModelAccessibleFromAuthoritativeCatalog } from "@/common/utils/providers/gatewayModelCatalog";
import { canDirectOpenAIServeModel } from "@/common/utils/providers/codexOauthRouting";

/**
 * Provider-configured predicate shared by the routing UI (useRouting) and the
 * send-path availability check below. One definition, two consumers — the
 * Settings picker and the skill-routing verdict must never disagree.
 */
export function isRouteProviderConfigured(
  providersConfig: ProvidersConfigMap,
  provider: string
): boolean {
  return (
    providersConfig[provider]?.isConfigured === true &&
    providersConfig[provider]?.isEnabled !== false
  );
}

/** Gateway-catalog accessibility predicate; see isRouteProviderConfigured. */
export function isRouteGatewayModelAccessible(
  providersConfig: ProvidersConfigMap,
  gateway: string,
  modelId: string
): boolean {
  return isGatewayModelAccessibleFromAuthoritativeCatalog(
    gateway,
    modelId,
    providersConfig[gateway]?.models,
    providersConfig[gateway]?.discoveredModels,
    providersConfig[gateway]?.removedModels
  );
}

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
 *
 * Known one-directional gap: enforced-policy model gating (policyService
 * isModelAllowed, applied inside the node-side gateway checker) is not
 * consulted here, so this can over-report availability for policy-blocked
 * gateway models — the send then fails with the provider's own error rather
 * than the actionable class message. It can never spuriously block.
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
    (provider) => {
      if (!isRouteProviderConfigured(providersConfig, provider)) {
        return false;
      }
      // OpenAI's isConfigured can mean Codex-OAuth-only credentials, which
      // serve only the OAuth-allowed model set — a direct route the factory
      // would reject (api_key_not_found) must not win over a later gateway or
      // suppress the actionable class error.
      if (provider === "openai") {
        return canDirectOpenAIServeModel(args.canonicalModel, providersConfig);
      }
      return true;
    },
    (gateway, modelId) => isRouteGatewayModelAccessible(providersConfig, gateway, modelId)
  );
}
