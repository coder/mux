import {
  GATEWAY_PROVIDERS,
  PROVIDER_DEFINITIONS,
  type ProviderName,
} from "@/common/constants/providers";
import { getExplicitGatewayPrefix, normalizeToCanonical } from "@/common/utils/ai/models";

import type { AvailableRoute, RouteContext } from "./types";

interface RoutingProviderDefinition {
  displayName: string;
  kind: "direct" | "gateway" | "local";
  routes?: readonly ProviderName[];
  toGatewayModelId?: (origin: string, modelId: string) => string;
}

interface ParsedRoutingInput {
  origin: ProviderName;
  originModelId: string;
  explicitGateway?: ProviderName;
  explicitGatewayModelId?: string;
}

function getProviderDefinition(provider: string): RoutingProviderDefinition | undefined {
  if (!(provider in PROVIDER_DEFINITIONS)) {
    return undefined;
  }

  return PROVIDER_DEFINITIONS[provider as ProviderName] as RoutingProviderDefinition;
}

function parseRoutingInput(modelInput: string): ParsedRoutingInput {
  const explicitGateway = getExplicitGatewayPrefix(modelInput);
  const explicitGatewayModelId =
    explicitGateway == null ? undefined : modelInput.slice(modelInput.indexOf(":") + 1);

  const canonicalModel = normalizeToCanonical(modelInput);
  const colonIdx = canonicalModel.indexOf(":");
  const origin = (
    colonIdx === -1 ? canonicalModel : canonicalModel.slice(0, colonIdx)
  ) as ProviderName;
  const originModelId = colonIdx === -1 ? canonicalModel : canonicalModel.slice(colonIdx + 1);

  return {
    origin,
    originModelId,
    explicitGateway,
    explicitGatewayModelId,
  };
}

function directRouteContext(
  modelInput: string,
  parsed: ReturnType<typeof parseRoutingInput>
): RouteContext {
  return {
    canonical: modelInput,
    origin: parsed.origin,
    originModelId: parsed.originModelId,
    routeProvider: parsed.origin,
    routeModelId: parsed.originModelId,
  };
}

function explicitGatewayRouteContext(
  modelInput: string,
  parsed: ReturnType<typeof parseRoutingInput>
): RouteContext {
  const explicitGateway = parsed.explicitGateway;
  const explicitGatewayModelId = parsed.explicitGatewayModelId;
  if (explicitGateway == null || explicitGatewayModelId == null) {
    throw new Error("Explicit gateway route context requires an explicit gateway input");
  }

  return {
    canonical: modelInput,
    origin: parsed.origin,
    originModelId: parsed.originModelId,
    routeProvider: explicitGateway,
    // Preserve the caller's explicit gateway suffix instead of re-synthesizing it,
    // so slash-format gateways like OpenRouter don't double-prefix the origin.
    routeModelId: explicitGatewayModelId,
  };
}

function gatewayRouteContext(
  modelInput: string,
  parsed: ReturnType<typeof parseRoutingInput>,
  gateway: ProviderName
): RouteContext {
  const definition = getProviderDefinition(gateway);
  const toGatewayModelId = definition?.toGatewayModelId;
  return {
    canonical: modelInput,
    origin: parsed.origin,
    originModelId: parsed.originModelId,
    routeProvider: gateway,
    routeModelId: toGatewayModelId
      ? toGatewayModelId(parsed.origin, parsed.originModelId)
      : parsed.originModelId,
  };
}

function getConfiguredDirectRouteContext(
  modelInput: string,
  parsed: ReturnType<typeof parseRoutingInput>,
  isConfigured: (provider: string) => boolean
): RouteContext | null {
  return isConfigured(parsed.origin) ? directRouteContext(modelInput, parsed) : null;
}

function getConfiguredExplicitGatewayRouteContext(
  modelInput: string,
  parsed: ReturnType<typeof parseRoutingInput>,
  isConfigured: (provider: string) => boolean
): RouteContext | null {
  if (parsed.explicitGateway == null || !isConfigured(parsed.explicitGateway)) {
    return null;
  }

  return explicitGatewayRouteContext(modelInput, parsed);
}

function getConfiguredGatewayRouteContext(
  modelInput: string,
  parsed: ReturnType<typeof parseRoutingInput>,
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

  return gatewayRouteContext(modelInput, parsed, gateway as ProviderName);
}

// Keep active-route discovery separate from resolveRoute's last-resort fallback
// so browser availability checks stay aligned with the current override/priority state.
function findActiveRouteContext(
  modelInput: string,
  parsed: ReturnType<typeof parseRoutingInput>,
  routePriority: string[],
  routeOverrides: Record<string, string>,
  isConfigured: (provider: string) => boolean
): RouteContext | null {
  // Explicit gateway is a preferred first candidate, not a dead-end.
  // If the gateway itself is configured, use it; otherwise fall through
  // to canonical override/priority routing so the underlying model
  // stays reachable via other configured routes.
  if (parsed.explicitGateway != null) {
    const explicit = getConfiguredExplicitGatewayRouteContext(modelInput, parsed, isConfigured);
    if (explicit) {
      return explicit;
    }
    // Fall through to canonical routing below
  }

  // 1. Check per-model override
  const override = routeOverrides[modelInput];
  if (override === "direct" || override === parsed.origin) {
    const direct = getConfiguredDirectRouteContext(modelInput, parsed, isConfigured);
    if (direct) {
      return direct;
    }
    // Direct override not viable — fall through to priority list
  }

  if (override) {
    const viaOverride = getConfiguredGatewayRouteContext(
      modelInput,
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
      const direct = getConfiguredDirectRouteContext(modelInput, parsed, isConfigured);
      if (direct) {
        return direct;
      }
      continue;
    }

    const viaPriority = getConfiguredGatewayRouteContext(modelInput, parsed, route, isConfigured);
    if (viaPriority) {
      return viaPriority;
    }
  }

  return null;
}

/**
 * Pure route resolution. Given a routing input and routing config,
 * determine which provider to route through.
 */
export function resolveRoute(
  modelInput: string,
  routePriority: string[],
  routeOverrides: Record<string, string>,
  isConfigured: (provider: string) => boolean
): RouteContext {
  const parsed = parseRoutingInput(modelInput);
  const resolved = findActiveRouteContext(
    modelInput,
    parsed,
    routePriority,
    routeOverrides,
    isConfigured
  );
  if (resolved) {
    return resolved;
  }

  // 3. Nothing configured — fall back to direct (will fail at credential check later)
  return directRouteContext(modelInput, parsed);
}

/** Is this model reachable via the current configured routing state? */
export function isModelAvailable(
  modelInput: string,
  routePriority: string[],
  routeOverrides: Record<string, string>,
  isConfigured: (provider: string) => boolean
): boolean {
  const parsed = parseRoutingInput(modelInput);
  return (
    findActiveRouteContext(modelInput, parsed, routePriority, routeOverrides, isConfigured) != null
  );
}

/** Which routes can reach this model? Returns all possible routes with configuration status. */
export function availableRoutes(
  modelInput: string,
  isConfigured: (provider: string) => boolean
): AvailableRoute[] {
  const { origin } = parseRoutingInput(modelInput);
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
