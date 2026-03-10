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

function parseCanonical(canonicalModel: string): { origin: string; originModelId: string } {
  const colonIdx = canonicalModel.indexOf(":");
  const origin = getModelProvider(canonicalModel) || canonicalModel;
  const originModelId = colonIdx === -1 ? canonicalModel : canonicalModel.slice(colonIdx + 1);
  return { origin, originModelId };
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
  const { origin, originModelId } = parseCanonical(canonicalModel);

  const direct = (): RouteContext => ({
    canonical: canonicalModel,
    origin: origin as ProviderName,
    originModelId,
    routeProvider: origin as ProviderName,
    routeModelId: originModelId,
  });

  const viaGateway = (gateway: ProviderName): RouteContext => {
    const definition = getProviderDefinition(gateway);
    const toGatewayModelId = definition?.toGatewayModelId;
    return {
      canonical: canonicalModel,
      origin: origin as ProviderName,
      originModelId,
      routeProvider: gateway,
      routeModelId: toGatewayModelId ? toGatewayModelId(origin, originModelId) : originModelId,
    };
  };

  // 1. Check per-model override
  const override = routeOverrides[canonicalModel];
  if (override === "direct" || override === origin) {
    if (isConfigured(origin)) {
      return direct();
    }
    // Direct override not viable — fall through to priority list
  }

  if (override) {
    const definition = getProviderDefinition(override);
    if (
      definition?.kind === "gateway" &&
      definition.toGatewayModelId &&
      definition.routes?.includes(origin as ProviderName)
    ) {
      if (isConfigured(override)) {
        return viaGateway(override as ProviderName);
      }
    }
    // Override not viable — fall through to priority list
  }

  // 2. Walk routePriority
  for (const route of routePriority) {
    if (route === "direct") {
      if (isConfigured(origin)) {
        return direct();
      }
      continue;
    }

    const definition = getProviderDefinition(route);
    if (definition?.kind !== "gateway" || !definition.routes?.includes(origin as ProviderName)) {
      continue;
    }

    if (!definition.toGatewayModelId) {
      continue;
    }

    if (!isConfigured(route)) {
      continue;
    }

    return viaGateway(route as ProviderName);
  }

  // 3. Nothing configured — fall back to direct (will fail at credential check later)
  return direct();
}

/** Is this model reachable via any configured route (direct or gateway)? */
export function isModelAvailable(
  canonicalModel: string,
  isConfigured: (provider: string) => boolean
): boolean {
  const { origin } = parseCanonical(canonicalModel);
  if (isConfigured(origin)) {
    return true;
  }

  return GATEWAY_PROVIDERS.some((gateway) => {
    const definition = getProviderDefinition(gateway);
    return (
      definition?.routes?.includes(origin as ProviderName) &&
      definition.toGatewayModelId &&
      isConfigured(gateway)
    );
  });
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
    if (definition?.routes?.includes(origin as ProviderName) && definition.toGatewayModelId) {
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
