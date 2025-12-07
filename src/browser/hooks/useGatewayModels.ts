import { useCallback, useEffect } from "react";
import { usePersistedState, readPersistedState, updatePersistedState } from "./usePersistedState";
import { useProvidersConfig } from "./useProvidersConfig";

const GATEWAY_MODELS_KEY = "gateway-models";
const GATEWAY_AVAILABLE_KEY = "gateway-available";
const GATEWAY_ENABLED_KEY = "gateway-enabled";

/**
 * Providers that Mux Gateway supports routing to.
 * Based on Vercel AI Gateway supported providers.
 * Only models from these providers can use the gateway toggle.
 *
 * Excluded:
 * - ollama: Local-only provider, not routable through cloud gateway
 * - openrouter: Already a gateway/aggregator, routing through another gateway is redundant
 * - bedrock: Complex auth (AWS credentials), not simple API key routing
 * - mux-gateway: Already gateway format
 */
const GATEWAY_SUPPORTED_PROVIDERS = new Set(["anthropic", "openai", "google", "xai"]);

/**
 * Check if a model's provider is supported by Mux Gateway.
 * @param modelId Full model ID (e.g., "anthropic:claude-opus-4-5")
 */
export function isGatewaySupported(modelId: string): boolean {
  const colonIndex = modelId.indexOf(":");
  if (colonIndex === -1) return false;
  const provider = modelId.slice(0, colonIndex);
  return GATEWAY_SUPPORTED_PROVIDERS.has(provider);
}

/**
 * Check if a model is gateway-enabled (static read, no reactivity)
 */
export function isGatewayEnabled(modelId: string): boolean {
  const gatewayModels = readPersistedState<string[]>(GATEWAY_MODELS_KEY, []);
  return gatewayModels.includes(modelId);
}

/**
 * Check if a model string is in mux-gateway format.
 * @param modelId Model string to check
 * @returns true if model is "mux-gateway:provider/model" format
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
 *
 * @param modelId Model string that may be in gateway format
 * @returns Canonical model ID (e.g., "anthropic:claude-opus-4-5")
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
 * Check if the gateway provider is available (has coupon code configured)
 */
export function isGatewayAvailable(): boolean {
  return readPersistedState<boolean>(GATEWAY_AVAILABLE_KEY, false);
}

/**
 * Check if the gateway is globally enabled (user toggle, defaults to true when available)
 */
export function isGatewayGloballyEnabled(): boolean {
  return readPersistedState<boolean>(GATEWAY_ENABLED_KEY, true);
}

/**
 * Set the global gateway enabled state
 */
export function setGatewayGloballyEnabled(enabled: boolean): void {
  updatePersistedState(GATEWAY_ENABLED_KEY, enabled);
}

/**
 * Transform a model ID to gateway format if gateway is enabled AND available AND supported.
 * Falls back to direct provider if:
 * - Gateway is not configured (no coupon code)
 * - User hasn't enabled gateway for this model
 * - Provider is not supported by gateway
 *
 * Example: "anthropic:claude-opus-4-5" → "mux-gateway:anthropic/claude-opus-4-5"
 */
export function toGatewayModel(modelId: string): string {
  // Only transform if:
  // 1. Gateway is globally enabled (user hasn't disabled it)
  // 2. User enabled gateway for this specific model
  // 3. Gateway is configured (coupon code set)
  // 4. Provider is supported by gateway
  if (
    !isGatewayGloballyEnabled() ||
    !isGatewayEnabled(modelId) ||
    !isGatewayAvailable() ||
    !isGatewaySupported(modelId)
  ) {
    return modelId;
  }
  // Transform provider:model to mux-gateway:provider/model
  const colonIndex = modelId.indexOf(":");
  if (colonIndex === -1) {
    return modelId;
  }
  const provider = modelId.slice(0, colonIndex);
  const model = modelId.slice(colonIndex + 1);
  return `mux-gateway:${provider}/${model}`;
}

/**
 * Toggle gateway mode for a model (static update, no reactivity)
 */
export function toggleGatewayModel(modelId: string): void {
  const gatewayModels = readPersistedState<string[]>(GATEWAY_MODELS_KEY, []);
  if (gatewayModels.includes(modelId)) {
    updatePersistedState(
      GATEWAY_MODELS_KEY,
      gatewayModels.filter((m) => m !== modelId)
    );
  } else {
    updatePersistedState(GATEWAY_MODELS_KEY, [...gatewayModels, modelId]);
  }
}

/**
 * Hook to manage which models use the Mux Gateway.
 * Returns reactive state and toggle function.
 *
 * Also syncs gateway availability from provider config to localStorage
 * so that toGatewayModel() can check it synchronously.
 */
export function useGatewayModels() {
  const { config } = useProvidersConfig();
  const [gatewayModels, setGatewayModels] = usePersistedState<string[]>(GATEWAY_MODELS_KEY, [], {
    listener: true,
  });
  const [gatewayAvailable, setGatewayAvailable] = usePersistedState<boolean>(
    GATEWAY_AVAILABLE_KEY,
    false,
    { listener: true }
  );
  const [gatewayGloballyEnabled, setGatewayGloballyEnabled] = usePersistedState<boolean>(
    GATEWAY_ENABLED_KEY,
    true,
    { listener: true }
  );

  // Sync gateway availability from provider config
  useEffect(() => {
    if (!config) return;
    const available = config["mux-gateway"]?.couponCodeSet ?? false;
    setGatewayAvailable(available);
  }, [config, setGatewayAvailable]);

  const toggleGloballyEnabled = useCallback(() => {
    setGatewayGloballyEnabled((prev) => !prev);
  }, [setGatewayGloballyEnabled]);

  const isEnabled = useCallback(
    (modelId: string) => gatewayModels.includes(modelId),
    [gatewayModels]
  );

  const toggle = useCallback(
    (modelId: string) => {
      setGatewayModels((prev) => {
        if (prev.includes(modelId)) {
          return prev.filter((m) => m !== modelId);
        }
        return [...prev, modelId];
      });
    },
    [setGatewayModels]
  );

  return {
    gatewayModels,
    isEnabled,
    toggle,
    gatewayAvailable,
    gatewayGloballyEnabled,
    toggleGloballyEnabled,
  };
}
