import { useCallback, useEffect, useMemo } from "react";
import { usePersistedState, readPersistedState, updatePersistedState } from "./usePersistedState";
import { useProvidersConfig } from "./useProvidersConfig";

// localStorage keys
const GATEWAY_MODELS_KEY = "gateway-models"; // Models user has enabled for gateway routing
const GATEWAY_CONFIGURED_KEY = "gateway-available"; // Synced from provider config (coupon set)
const GATEWAY_ENABLED_KEY = "gateway-enabled"; // Global on/off toggle

/**
 * Providers that Mux Gateway supports routing to.
 * Based on Vercel AI Gateway supported providers.
 *
 * Excluded:
 * - ollama: Local-only provider, not routable through cloud gateway
 * - openrouter: Already a gateway/aggregator, routing through another gateway is redundant
 * - bedrock: Complex auth (AWS credentials), not simple API key routing
 * - mux-gateway: Already gateway format
 */
const GATEWAY_SUPPORTED_PROVIDERS = new Set(["anthropic", "openai", "google", "xai"]);

// ============================================================================
// Pure utility functions (no side effects, used for message sending)
// ============================================================================

/**
 * Extract provider from a model ID.
 */
function getProvider(modelId: string): string | null {
  const colonIndex = modelId.indexOf(":");
  return colonIndex === -1 ? null : modelId.slice(0, colonIndex);
}

/**
 * Check if a model's provider can route through Mux Gateway.
 */
export function isProviderSupported(modelId: string): boolean {
  const provider = getProvider(modelId);
  return provider !== null && GATEWAY_SUPPORTED_PROVIDERS.has(provider);
}

/**
 * Check if a model string is in mux-gateway format.
 */
export function isGatewayFormat(modelId: string): boolean {
  return modelId.startsWith("mux-gateway:");
}

/**
 * Migrate a mux-gateway model to canonical format and enable gateway toggle.
 * Converts "mux-gateway:provider/model" to "provider:model" and marks it for gateway routing.
 *
 * This provides forward compatibility for users who have directly specified
 * mux-gateway models in their config.
 */
export function migrateGatewayModel(modelId: string): string {
  if (!isGatewayFormat(modelId)) {
    return modelId;
  }

  // mux-gateway:anthropic/claude-opus-4-5 → anthropic:claude-opus-4-5
  const inner = modelId.slice("mux-gateway:".length);
  const slashIndex = inner.indexOf("/");
  if (slashIndex === -1) {
    return modelId; // Malformed, return as-is
  }

  const provider = inner.slice(0, slashIndex);
  const model = inner.slice(slashIndex + 1);
  const canonicalId = `${provider}:${model}`;

  // Auto-enable gateway for this model (one-time migration)
  const gatewayModels = readPersistedState<string[]>(GATEWAY_MODELS_KEY, []);
  if (!gatewayModels.includes(canonicalId)) {
    updatePersistedState(GATEWAY_MODELS_KEY, [...gatewayModels, canonicalId]);
  }

  return canonicalId;
}

/**
 * Transform a model ID to gateway format for API calls.
 * Returns original modelId if gateway routing shouldn't be used.
 *
 * Checks (all must pass):
 * 1. Gateway is globally enabled (user hasn't disabled it)
 * 2. Gateway is configured (coupon code set)
 * 3. Provider is supported by gateway
 * 4. User enabled gateway for this specific model
 *
 * Example: "anthropic:claude-opus-4-5" → "mux-gateway:anthropic/claude-opus-4-5"
 */
export function toGatewayModel(modelId: string): string {
  const globallyEnabled = readPersistedState<boolean>(GATEWAY_ENABLED_KEY, true);
  const configured = readPersistedState<boolean>(GATEWAY_CONFIGURED_KEY, false);
  const enabledModels = readPersistedState<string[]>(GATEWAY_MODELS_KEY, []);

  if (!globallyEnabled || !configured || !isProviderSupported(modelId)) {
    return modelId;
  }

  if (!enabledModels.includes(modelId)) {
    return modelId;
  }

  // Transform provider:model to mux-gateway:provider/model
  const provider = getProvider(modelId);
  if (!provider) return modelId;

  const model = modelId.slice(provider.length + 1);
  return `mux-gateway:${provider}/${model}`;
}

// ============================================================================
// Gateway state interface (returned by hook)
// ============================================================================

export interface GatewayState {
  /** Gateway is configured (coupon code set) and globally enabled */
  isActive: boolean;
  /** Gateway has coupon code configured */
  isConfigured: boolean;
  /** Gateway is globally enabled (master switch) */
  isEnabled: boolean;
  /** Toggle the global enabled state */
  toggleEnabled: () => void;
  /** Check if a specific model uses gateway routing */
  modelUsesGateway: (modelId: string) => boolean;
  /** Toggle gateway routing for a specific model */
  toggleModelGateway: (modelId: string) => void;
  /** Check if gateway toggle should be shown for a model (active + provider supported) */
  canToggleModel: (modelId: string) => boolean;
  /** Check if model is actively routing through gateway (for display) */
  isModelRoutingThroughGateway: (modelId: string) => boolean;
}

/**
 * Hook for gateway state management.
 *
 * Syncs gateway configuration from provider config to localStorage
 * so that toGatewayModel() can check it synchronously during message sending.
 */
export function useGateway(): GatewayState {
  const { config } = useProvidersConfig();

  const [enabledModels, setEnabledModels] = usePersistedState<string[]>(GATEWAY_MODELS_KEY, [], {
    listener: true,
  });
  const [isConfigured, setIsConfigured] = usePersistedState<boolean>(
    GATEWAY_CONFIGURED_KEY,
    false,
    { listener: true }
  );
  const [isEnabled, setIsEnabled] = usePersistedState<boolean>(GATEWAY_ENABLED_KEY, true, {
    listener: true,
  });

  // Sync gateway configuration from provider config
  useEffect(() => {
    if (!config) return;
    const configured = config["mux-gateway"]?.couponCodeSet ?? false;
    setIsConfigured(configured);
  }, [config, setIsConfigured]);

  const isActive = isConfigured && isEnabled;

  const toggleEnabled = useCallback(() => {
    setIsEnabled((prev) => !prev);
    // Also update localStorage synchronously
    updatePersistedState<boolean>(GATEWAY_ENABLED_KEY, (prev) => !prev);
  }, [setIsEnabled]);

  const modelUsesGateway = useCallback(
    (modelId: string) => enabledModels.includes(modelId),
    [enabledModels]
  );

  const toggleModelGateway = useCallback(
    (modelId: string) => {
      // Update React state for UI
      setEnabledModels((prev) =>
        prev.includes(modelId) ? prev.filter((m) => m !== modelId) : [...prev, modelId]
      );
      // Also update localStorage synchronously so toGatewayModel() sees it immediately
      // (usePersistedState batches writes in microtask, which can cause race conditions)
      updatePersistedState<string[]>(GATEWAY_MODELS_KEY, (prev) =>
        prev.includes(modelId) ? prev.filter((m) => m !== modelId) : [...prev, modelId]
      );
    },
    [setEnabledModels]
  );

  const canToggleModel = useCallback(
    (modelId: string) => isActive && isProviderSupported(modelId),
    [isActive]
  );

  const isModelRoutingThroughGateway = useCallback(
    (modelId: string) =>
      isActive && isProviderSupported(modelId) && enabledModels.includes(modelId),
    [isActive, enabledModels]
  );

  return useMemo(
    () => ({
      isActive,
      isConfigured,
      isEnabled,
      toggleEnabled,
      modelUsesGateway,
      toggleModelGateway,
      canToggleModel,
      isModelRoutingThroughGateway,
    }),
    [
      isActive,
      isConfigured,
      isEnabled,
      toggleEnabled,
      modelUsesGateway,
      toggleModelGateway,
      canToggleModel,
      isModelRoutingThroughGateway,
    ]
  );
}
