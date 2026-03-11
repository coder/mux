import {
  GATEWAY_PROVIDERS,
  PROVIDER_DEFINITIONS,
  type ProviderName,
} from "@/common/constants/providers";
import { getModelProvider } from "@/common/utils/ai/models";

import type { AvailableRoute, RouteContext } from "./types";

interface RoutingProviderDefinition {
  displayName: string;
  kind: "direct" | "gateway" | "local";
  routes?: readonly ProviderName[];
  toGatewayModelId?: (origin: string, modelId: string) => string;
}

function getProviderDefinition(provider: string): RoutingProviderDefinition | undefined {
  if (!(provider in PROVIDER_DEFINITIONS)) {
    return undefined;
  }

  return PROVIDER_DEFINITIONS[provider as ProviderName] as RoutingProviderDefinition;
}

function parseCanonical(canonicalModel: string): {
  origin: ProviderName;
  originModelId: string;
} {
  const colonIdx = canonicalModel.indexOf(":");
  const origin = (getModelProvider(canonicalModel) || canonicalModel) as ProviderName;
  const originModelId = colonIdx === -1 ? canonicalModel : canonicalModel.slice(colonIdx + 1);
  return { origin, originModelId };
}

function directRouteContext(
  canonicalModel: string,
  parsed: ReturnType<typeof parseCanonical>
): RouteContext {
  return {
    canonical: canonicalModel,
    origin: parsed.origin,
    originModelId: parsed.originModelId,
    routeProvider: parsed.origin,
    routeModelId: parsed.originModelId,
  };
}

function gatewayRouteContext(
  canonicalModel: string,
  parsed: ReturnType<typeof parseCanonical>,
  gateway: ProviderName
): RouteContext {
  const definition = getProviderDefinition(gateway);
  const toGatewayModelId = definition?.toGatewayModelId;
  return {
    canonical: canonicalModel,
    origin: parsed.origin,
    originModelId: parsed.originModelId,
    routeProvider: gateway,
    routeModelId: toGatewayModelId
      ? toGatewayModelId(parsed.origin, parsed.originModelId)
      : parsed.originModelId,
  };
}

function getConfiguredDirectRouteContext(
  canonicalModel: string,
  parsed: ReturnType<typeof parseCanonical>,
  isConfigured: (provider: string) => boolean
): RouteContext | null {
  return isConfigured(parsed.origin) ? directRouteContext(canonicalModel, parsed) : null;
}

function getConfiguredGatewayRouteContext(
  canonicalModel: string,
  parsed: ReturnType<typeof parseCanonical>,
  gateway: string,
  isConfigured: (provider: string) => boolean
): RouteContext | null {
  const definition = getProviderDefinition(gateway);
  if (
    definition?.kind !== "gateway" ||
    !definition.toGatewayModelId ||
    !definition.routes?.includes(parsed.origin) ||
    !isConfigured(gateway)
  ) {
    return null;
  }

  return gatewayRouteContext(canonicalModel, parsed, gateway as ProviderName);
}

// Keep active-route discovery separate from resolveRoute's last-resort direct fallback
// so browser availability checks stay aligned with the current override/priority state.
function findActiveRouteContext(
  canonicalModel: string,
  parsed: ReturnType<typeof parseCanonical>,
  routePriority: string[],
  routeOverrides: Record<string, string>,
  isConfigured: (provider: string) => boolean
): RouteContext | null {
  // 1. Check per-model override
  const override = routeOverrides[canonicalModel];
  if (override === "direct" || override === parsed.origin) {
    const direct = getConfiguredDirectRouteContext(canonicalModel, parsed, isConfigured);
    if (direct) {
      return direct;
    }
    // Direct override not viable — fall through to priority list
  }

  if (override) {
    const viaOverride = getConfiguredGatewayRouteContext(
      canonicalModel,
      parsed,
      override,
      isConfigured
    );
    if (viaOverride) {
      return viaOverride;
    }
    // Override not viable — fall through to priority list
  }

  // 2. Walk routePriority
  for (const route of routePriority) {
    if (route === "direct") {
      const direct = getConfiguredDirectRouteContext(canonicalModel, parsed, isConfigured);
      if (direct) {
        return direct;
      }
      continue;
    }

    const viaPriority = getConfiguredGatewayRouteContext(
      canonicalModel,
      parsed,
      route,
      isConfigured
    );
    if (viaPriority) {
      return viaPriority;
    }
  }

  return null;
}

/**
 * Pure route resolution. Given a canonical model string and routing config,
 * determine which provider to route through.
 */
export function resolveRoute(
  canonicalModel: string,
  routePriority: string[],
  routeOverrides: Record<string, string>,
  isConfigured: (provider: string) => boolean
): RouteContext {
  const parsed = parseCanonical(canonicalModel);
  const resolved = findActiveRouteContext(
    canonicalModel,
    parsed,
    routePriority,
    routeOverrides,
    isConfigured
  );
  if (resolved) {
    return resolved;
  }

  // 3. Nothing configured — fall back to direct (will fail at credential check later)
  return directRouteContext(canonicalModel, parsed);
}

/** Is this model reachable via the current configured routing state? */
export function isModelAvailable(
  canonicalModel: string,
  routePriority: string[],
  routeOverrides: Record<string, string>,
  isConfigured: (provider: string) => boolean
): boolean {
  const parsed = parseCanonical(canonicalModel);
  return (
    findActiveRouteContext(canonicalModel, parsed, routePriority, routeOverrides, isConfigured) !=
    null
  );
}

/** Which routes can reach this model? Returns all possible routes with configuration status. */
export function availableRoutes(
  canonicalModel: string,
  isConfigured: (provider: string) => boolean
): AvailableRoute[] {
  const { origin } = parseCanonical(canonicalModel);
  const routes: AvailableRoute[] = [];

  // Add gateways that can route this origin
  for (const gateway of GATEWAY_PROVIDERS) {
    const definition = getProviderDefinition(gateway);
    if (definition?.routes?.includes(origin) && definition.toGatewayModelId) {
      routes.push({
        route: gateway,
        displayName: definition.displayName,
        isConfigured: isConfigured(gateway),
      });
    }
  }

  // Add direct route
  const originDefinition = getProviderDefinition(origin);
  if (originDefinition) {
    routes.push({
      route: "direct",
      displayName: `Direct (${originDefinition.displayName})`,
      isConfigured: isConfigured(origin),
    });
  }

  return routes;
}
