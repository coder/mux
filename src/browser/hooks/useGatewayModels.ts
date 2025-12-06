import { useCallback } from "react";
import { usePersistedState, readPersistedState, updatePersistedState } from "./usePersistedState";

const GATEWAY_MODELS_KEY = "gateway-models";

/**
 * Check if a model is gateway-enabled (static read, no reactivity)
 */
export function isGatewayEnabled(modelId: string): boolean {
  const gatewayModels = readPersistedState<string[]>(GATEWAY_MODELS_KEY, []);
  return gatewayModels.includes(modelId);
}

/**
 * Transform a model ID to gateway format if gateway is enabled for it.
 * Example: "anthropic:claude-opus-4-5" → "mux-gateway:anthropic/claude-opus-4-5"
 */
export function toGatewayModel(modelId: string): string {
  if (!isGatewayEnabled(modelId)) {
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
 */
export function useGatewayModels() {
  const [gatewayModels, setGatewayModels] = usePersistedState<string[]>(GATEWAY_MODELS_KEY, [], {
    listener: true,
  });

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

  return { gatewayModels, isEnabled, toggle };
}
