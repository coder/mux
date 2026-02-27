import { useCallback, useEffect, useMemo, useRef } from "react";
import { useAPI } from "@/browser/contexts/API";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import { GATEWAY_ENABLED_KEY, GATEWAY_MODELS_KEY } from "@/common/constants/storage";
import { useProvidersConfig } from "./useProvidersConfig";
import {
  MUX_GATEWAY_SUPPORTED_PROVIDERS,
  isValidProvider,
  type ProviderName,
} from "@/common/constants/providers";
import { CUSTOM_EVENTS } from "@/common/constants/events";
import type { ProvidersConfigMap } from "@/common/orpc/types";

// Queue of canonical model IDs needing gateway enrollment. Populated by
// migrateGatewayModel (called during render); drained by the useGateway hook
// effect after provider config loads. Using a Set deduplicates repeated calls.
// Exported for testing only.
export const pendingGatewayEnrollments = new Set<string>();

// Registered by useGateway instances so migrateGatewayModel can trigger
// best-effort enrollment flushes for legacy mux-gateway model strings.
const gatewayEnrollmentFlushListeners = new Set<() => void>();

function clearLegacyGatewayLocalPrefs(): void {
  // Gateway localStorage keys are deprecated; clear stale values so migration
  // logic doesn't overwrite newer backend-driven user preferences.
  updatePersistedState<boolean | undefined>(GATEWAY_ENABLED_KEY, undefined);
  updatePersistedState<string[] | undefined>(GATEWAY_MODELS_KEY, undefined);
}

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
 * mux-gateway models in their config. When a migration occurs, the canonical
 * model is queued for gateway enrollment so the useGateway hook can persist it
 * in muxGatewayModels (preserving routing intent).
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

  // Preserve gateway routing intent: queue the canonical model for enrollment.
  // The useGateway hook drains this queue after provider config loads,
  // persisting the model in muxGatewayModels so gateway routing continues
  // to work after the format migration.
  const beforeSize = pendingGatewayEnrollments.size;
  pendingGatewayEnrollments.add(canonicalId);

  // Only signal when the queue actually grew.
  if (pendingGatewayEnrollments.size !== beforeSize && typeof window !== "undefined") {
    // Deferred via queueMicrotask because migrateGatewayModel can be called
    // during render; dispatching synchronously would be a React anti-pattern.
    queueMicrotask(() => {
      for (const flushPendingEnrollments of gatewayEnrollmentFlushListeners) {
        flushPendingEnrollments();
      }
    });
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
  /** Replace the full set of gateway-enabled models */
  setEnabledModels: (modelIds: string[]) => void;
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
  const lastKnownConfiguredRef = useRef<boolean | null>(null);
  if (gwConfig?.couponCodeSet != null) {
    lastKnownConfiguredRef.current = gwConfig.couponCodeSet;
  }
  const isConfigured =
    config == null
      ? (gwConfig?.couponCodeSet ?? lastKnownConfiguredRef.current ?? false)
      : (gwConfig?.couponCodeSet ?? false);
  const isEnabled = gwConfig?.isEnabled ?? true;
  const enabledModels = useMemo(() => gwConfig?.gatewayModels ?? [], [gwConfig?.gatewayModels]);
  const isActive = isConfigured && isEnabled;

  const flushPendingEnrollments = useCallback(() => {
    if (!api || pendingGatewayEnrollments.size === 0) {
      return;
    }

    if (!gwConfig) {
      // During hydration, config is null and mux-gateway state is temporarily
      // unavailable. Keep queued enrollments so they flush once config loads.
      if (config != null) {
        pendingGatewayEnrollments.clear();
      }
      return;
    }

    const pendingModels = [...pendingGatewayEnrollments];
    const existingModels = gwConfig.gatewayModels ?? [];
    const newModels = pendingModels.filter((modelId) => !existingModels.includes(modelId));

    // No-op flush: pending models are already persisted.
    if (newModels.length === 0) {
      pendingGatewayEnrollments.clear();
      return;
    }

    const nextModels = [...existingModels, ...newModels];
    updateOptimistically("mux-gateway", { gatewayModels: nextModels });
    clearLegacyGatewayLocalPrefs();

    // Clear eagerly to avoid duplicate writes from multiple hook instances.
    pendingGatewayEnrollments.clear();

    void api.config
      .updateMuxGatewayPrefs({
        muxGatewayEnabled: gwConfig.isEnabled ?? true,
        muxGatewayModels: nextModels,
      })
      .catch(() => {
        // Best-effort persistence. Keep pending models so a future user action or
        // config refresh can flush them again.
        for (const modelId of pendingModels) {
          pendingGatewayEnrollments.add(modelId);
        }
      });
  }, [api, config, gwConfig, updateOptimistically]);

  // Register a best-effort flush callback so migrateGatewayModel can signal
  // late enrollments that happen after this hook mounts.
  useEffect(() => {
    gatewayEnrollmentFlushListeners.add(flushPendingEnrollments);
    return () => {
      gatewayEnrollmentFlushListeners.delete(flushPendingEnrollments);
    };
  }, [flushPendingEnrollments]);

  // Flush queued legacy enrollments after provider config loads.
  useEffect(() => {
    flushPendingEnrollments();
  }, [flushPendingEnrollments]);

  // Track whether a session-expired event arrived before config was hydrated.
  // updateOptimistically is a no-op when config is null, so we defer and apply
  // the update once gwConfig becomes available (see effect below).
  const sessionExpiredBeforeHydrationRef = useRef(false);

  // When gateway session expires (detected by stream error or account status check),
  // optimistically mark as unconfigured so routing stops immediately.
  // The MUX_GATEWAY_SESSION_EXPIRED event is dispatched by the chat event aggregator
  // and the account status hook; we handle it here to update provider config state.
  useEffect(() => {
    const handler = () => {
      if (config) {
        updateOptimistically("mux-gateway", { couponCodeSet: false });
      } else {
        // Config not loaded yet — defer so we apply it once hydrated
        sessionExpiredBeforeHydrationRef.current = true;
      }
    };
    window.addEventListener(CUSTOM_EVENTS.MUX_GATEWAY_SESSION_EXPIRED, handler);
    return () => window.removeEventListener(CUSTOM_EVENTS.MUX_GATEWAY_SESSION_EXPIRED, handler);
  }, [config, updateOptimistically]);

  // Apply deferred session-expired signal once config is hydrated.
  useEffect(() => {
    if (gwConfig && sessionExpiredBeforeHydrationRef.current) {
      sessionExpiredBeforeHydrationRef.current = false;
      updateOptimistically("mux-gateway", { couponCodeSet: false });
    }
  }, [gwConfig, updateOptimistically]);

  const toggleEnabled = useCallback(() => {
    const nextEnabled = !isEnabled;
    // Optimistic update for instant UI feedback.
    updateOptimistically("mux-gateway", { isEnabled: nextEnabled });

    clearLegacyGatewayLocalPrefs();

    api?.config
      .updateMuxGatewayPrefs({
        muxGatewayEnabled: nextEnabled,
        muxGatewayModels: enabledModels,
      })
      .catch(() => {
        // Best-effort only; backend configChanged will reconcile state.
      });
  }, [api, enabledModels, isEnabled, updateOptimistically]);

  const setEnabledModels = useCallback(
    (nextModels: string[]) => {
      // Keep writes centralized in this hook so all gateway actions (global toggle,
      // per-model toggle, and "enable all") persist through one API call pattern.
      updateOptimistically("mux-gateway", { gatewayModels: nextModels });

      clearLegacyGatewayLocalPrefs();

      api?.config
        .updateMuxGatewayPrefs({
          muxGatewayEnabled: isEnabled,
          muxGatewayModels: nextModels,
        })
        .catch(() => {
          // Best-effort only; backend configChanged will reconcile state.
        });
    },
    [api, isEnabled, updateOptimistically]
  );

  const modelUsesGateway = useCallback(
    (modelId: string) => enabledModels.includes(modelId),
    [enabledModels]
  );

  const toggleModelGateway = useCallback(
    (modelId: string) => {
      const nextModels = enabledModels.includes(modelId)
        ? enabledModels.filter((m) => m !== modelId)
        : [...enabledModels, modelId];
      setEnabledModels(nextModels);
    },
    [enabledModels, setEnabledModels]
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
      setEnabledModels,
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
      setEnabledModels,
      modelUsesGateway,
      toggleModelGateway,
      canToggleModel,
      isModelRoutingThroughGateway,
    ]
  );
}
