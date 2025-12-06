import { useCallback, useEffect } from "react";
import { usePersistedState, readPersistedState, updatePersistedState } from "./usePersistedState";
import { useProvidersConfig } from "./useProvidersConfig";

const GATEWAY_MODELS_KEY = "gateway-models";
const GATEWAY_AVAILABLE_KEY = "gateway-available";

/**
 * Check if a model is gateway-enabled (static read, no reactivity)
 */
export function isGatewayEnabled(modelId: string): boolean {
  const gatewayModels = readPersistedState<string[]>(GATEWAY_MODELS_KEY, []);
  return gatewayModels.includes(modelId);
}

/**
 * Check if the gateway provider is available (has coupon code configured)
 */
export function isGatewayAvailable(): boolean {
  return readPersistedState<boolean>(GATEWAY_AVAILABLE_KEY, false);
}

/**
 * Transform a model ID to gateway format if gateway is enabled AND available.
 * Falls back to direct provider if gateway is not configured.
 * Example: "anthropic:claude-opus-4-5" → "mux-gateway:anthropic/claude-opus-4-5"
 */
export function toGatewayModel(modelId: string): string {
  // Only transform if user enabled gateway for this model AND gateway is configured
  if (!isGatewayEnabled(modelId) || !isGatewayAvailable()) {
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

  // Sync gateway availability from provider config
  useEffect(() => {
    if (!config) return;
    const available = config["mux-gateway"]?.couponCodeSet ?? false;
    setGatewayAvailable(available);
  }, [config, setGatewayAvailable]);

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

  return { gatewayModels, isEnabled, toggle, gatewayAvailable };
}
