import { useCallback, useEffect, useMemo } from "react";
import { useAPI } from "@/browser/contexts/API";
import { useProvidersConfig } from "./useProvidersConfig";
import {
  MUX_GATEWAY_SUPPORTED_PROVIDERS,
  isValidProvider,
  type ProviderName,
} from "@/common/constants/providers";
import { CUSTOM_EVENTS, createCustomEvent } from "@/common/constants/events";
import type { ProvidersConfigMap } from "@/common/orpc/types";

// Models confirmed enrolled by the useGateway handler. Once confirmed,
// migrateGatewayModel stops dispatching for that model. Set is only populated
// after the handler verifies config is loaded and persists the enrollment.
const confirmedEnrollments = new Set<string>();

// ============================================================================
// Pure utility functions (no side effects, used for message sending)
// ============================================================================

/**
 * Extract provider from a model ID.
 */
function getProvider(modelId: string): ProviderName | null {
  const colonIndex = modelId.indexOf(":");
  if (colonIndex === -1) {
    return null;
  }

  const provider = modelId.slice(0, colonIndex);
  return isValidProvider(provider) ? provider : null;
}

/**
 * Check if a model's provider can route through Mux Gateway.
 */
export function isProviderSupported(modelId: string): boolean {
  const provider = getProvider(modelId);
  return provider !== null && MUX_GATEWAY_SUPPORTED_PROVIDERS.has(provider);
}

/**
 * Check if a model string is in mux-gateway format.
 */
export function isGatewayFormat(modelId: string): boolean {
  return modelId.startsWith("mux-gateway:");
}

/**
 * Migrate a mux-gateway model to canonical format.
 * Converts "mux-gateway:provider/model" to "provider:model".
 *
 * This provides forward compatibility for users who have directly specified
 * mux-gateway models in their config. When a migration occurs, dispatches
 * MUX_GATEWAY_ENROLL_MODEL so the useGateway hook can persist gateway
 * enrollment for the canonical model ID (preserving routing intent).
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

  // Preserve gateway routing intent: dispatch enrollment event so the
  // useGateway hook persists this model in muxGatewayModels.
  // Deferred via setTimeout: migrateGatewayModel runs during render,
  // before the useGateway effect listener subscribes. Deferring ensures
  // the event reaches the listener after React commits and runs effects.
  // We keep dispatching until the handler confirms enrollment
  // (confirmedEnrollments). If the handler skips because config isn't
  // loaded yet, the model stays unconfirmed and retries on the next render.
  if (!confirmedEnrollments.has(canonicalId) && typeof window !== "undefined") {
    setTimeout(() => {
      // Re-check: window may have been torn down between render and timeout
      // (e.g., during test cleanup)
      if (typeof window !== "undefined") {
        window.dispatchEvent(
          createCustomEvent(CUSTOM_EVENTS.MUX_GATEWAY_ENROLL_MODEL, { modelId: canonicalId })
        );
      }
    }, 0);
  }

  return canonicalId;
}

/**
 * Check if a model would route through gateway given the current provider config.
 *
 * All must pass:
 * 1. Gateway is globally enabled (user hasn't disabled it)
 * 2. Gateway is configured (coupon code set)
 * 3. Provider is supported by gateway
 * 4. User enabled gateway for this specific model
 *
 * Example: "anthropic:claude-opus-4-5" → "mux-gateway:anthropic/claude-opus-4-5"
 */
export function toGatewayModel(
  modelId: string,
  providersConfig: ProvidersConfigMap | null
): string {
  const gwConfig = providersConfig?.["mux-gateway"];
  const globallyEnabled = gwConfig?.isEnabled ?? true;
  const configured = gwConfig?.couponCodeSet ?? false;
  const enabledModels = gwConfig?.gatewayModels ?? [];

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
  /** Which models are enabled for gateway routing */
  enabledModels: string[];
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
 * All gateway state is derived from the backend provider config (via useProvidersConfig).
 * Optimistic updates via updateOptimistically give instant UI feedback; the backend
 * emits configChanged after persisting, which triggers a re-fetch that confirms.
 */
export function useGateway(): GatewayState {
  const { api } = useAPI();
  const { config, updateOptimistically } = useProvidersConfig();

  // Derive all state from backend-provided config (single source of truth)
  const gwConfig = config?.["mux-gateway"];
  const isConfigured = gwConfig?.couponCodeSet ?? false;
  const isEnabled = gwConfig?.isEnabled ?? true;
  const enabledModels = useMemo(() => gwConfig?.gatewayModels ?? [], [gwConfig?.gatewayModels]);
  const isActive = isConfigured && isEnabled;

  // When gateway session expires (detected by stream error or account status check),
  // optimistically mark as unconfigured so routing stops immediately.
  // The MUX_GATEWAY_SESSION_EXPIRED event is dispatched by the chat event aggregator
  // and the account status hook; we handle it here to update provider config state.
  useEffect(() => {
    const handler = () => {
      updateOptimistically("mux-gateway", { couponCodeSet: false });
    };
    window.addEventListener(CUSTOM_EVENTS.MUX_GATEWAY_SESSION_EXPIRED, handler);
    return () => window.removeEventListener(CUSTOM_EVENTS.MUX_GATEWAY_SESSION_EXPIRED, handler);
  }, [updateOptimistically]);

  const persistGatewayPrefs = useCallback(
    (nextEnabled: boolean, nextModels: string[]) => {
      api?.config
        .updateMuxGatewayPrefs({
          muxGatewayEnabled: nextEnabled,
          muxGatewayModels: nextModels,
        })
        .catch(() => {
          // Best-effort only.
        });
    },
    [api]
  );

  // When migrateGatewayModel converts a legacy mux-gateway: model string,
  // it dispatches this event so we can persist the model's gateway enrollment.
  // This preserves the user's routing intent during the format migration.
  // We skip enrollment until provider config is loaded (gwConfig non-null) to
  // avoid overwriting existing backend models with an empty array.
  useEffect(() => {
    const handler = (e: CustomEvent<{ modelId: string }>) => {
      if (!gwConfig) return; // Config not loaded yet; will retry on next render
      const { modelId } = e.detail;
      // Mark confirmed so migrateGatewayModel stops dispatching for this model
      confirmedEnrollments.add(modelId);
      if (!enabledModels.includes(modelId)) {
        const nextModels = [...enabledModels, modelId];
        updateOptimistically("mux-gateway", { gatewayModels: nextModels });
        persistGatewayPrefs(isEnabled, nextModels);
      }
    };
    window.addEventListener(CUSTOM_EVENTS.MUX_GATEWAY_ENROLL_MODEL, handler as EventListener);
    return () =>
      window.removeEventListener(CUSTOM_EVENTS.MUX_GATEWAY_ENROLL_MODEL, handler as EventListener);
  }, [gwConfig, enabledModels, isEnabled, persistGatewayPrefs, updateOptimistically]);

  const toggleEnabled = useCallback(() => {
    const nextEnabled = !isEnabled;
    // Optimistic update for instant UI feedback
    updateOptimistically("mux-gateway", { isEnabled: nextEnabled });
    persistGatewayPrefs(nextEnabled, enabledModels);
  }, [enabledModels, isEnabled, persistGatewayPrefs, updateOptimistically]);

  const modelUsesGateway = useCallback(
    (modelId: string) => enabledModels.includes(modelId),
    [enabledModels]
  );

  const toggleModelGateway = useCallback(
    (modelId: string) => {
      const nextModels = enabledModels.includes(modelId)
        ? enabledModels.filter((m) => m !== modelId)
        : [...enabledModels, modelId];
      // Optimistic update for instant UI feedback
      updateOptimistically("mux-gateway", { gatewayModels: nextModels });
      persistGatewayPrefs(isEnabled, nextModels);
    },
    [enabledModels, isEnabled, persistGatewayPrefs, updateOptimistically]
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
      enabledModels,
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
      enabledModels,
      modelUsesGateway,
      toggleModelGateway,
      canToggleModel,
      isModelRoutingThroughGateway,
    ]
  );
}
