import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAPI } from "@/browser/contexts/API";
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

// Lightweight signal event dispatched when migrateGatewayModel enqueues items.
// The useGateway hook listens for this to bump a version counter, ensuring the
// drain effect re-runs even for late enrollments (after the hook has mounted).
const ENROLLMENT_PENDING_EVENT = "mux:gatewayEnrollmentPending";

// Global drain state shared across all useGateway hook instances.
// useGateway is mounted in multiple surfaces (title bar, model selector,
// settings); this singleton prevents duplicate concurrent drain IPC calls.
const enrollmentDrainState = {
  inFlight: false,
  retryTimer: null as number | null,
  retryDelayMs: 250,
};

// If model enrollment is requested before gwConfig hydrates, keep the latest
// models here and flush once we know the persisted enabled-state.
// Exported for testing only.
export const pendingGatewayModelsUntilHydrated = {
  models: null as string[] | null,
};
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
  pendingGatewayEnrollments.add(canonicalId);

  // Signal the hook to re-run the drain effect. Deferred via queueMicrotask
  // because migrateGatewayModel can be called during render; dispatching
  // synchronously during render would be a React anti-pattern.
  if (typeof window !== "undefined") {
    queueMicrotask(() => {
      if (typeof window !== "undefined") {
        window.dispatchEvent(new Event(ENROLLMENT_PENDING_EVENT));
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
  const isConfigured = gwConfig?.couponCodeSet ?? false;
  const isEnabled = gwConfig?.isEnabled ?? true;
  const enabledModels = useMemo(() => gwConfig?.gatewayModels ?? [], [gwConfig?.gatewayModels]);
  const isActive = isConfigured && isEnabled;

  // Bump a version counter when migrateGatewayModel enqueues items so the drain
  // effect re-runs for late enrollments (after the hook has already mounted).
  const [enrollVersion, setEnrollVersion] = useState(0);
  useEffect(() => {
    const handler = () => setEnrollVersion((v) => v + 1);
    window.addEventListener(ENROLLMENT_PENDING_EVENT, handler);
    return () => window.removeEventListener(ENROLLMENT_PENDING_EVENT, handler);
  }, []);

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

  const persistGatewayPrefs = useCallback(
    (nextEnabled: boolean, nextModels: string[]): boolean => {
      if (!api?.config?.updateMuxGatewayPrefs) {
        return false;
      }

      api.config
        .updateMuxGatewayPrefs({
          muxGatewayEnabled: nextEnabled,
          muxGatewayModels: nextModels,
        })
        .catch(() => {
          // Best-effort only.
        });

      return true;
    },
    [api]
  );

  // Drain pending gateway enrollments from migrateGatewayModel.
  // migrateGatewayModel queues models during render; this effect runs after
  // render to persist them. We wait until gwConfig and api are available,
  // then persist the queued canonical model IDs in a single batch.
  //
  // Durability: queued items are only removed after successful persistence.
  // If persistence fails, items stay queued and we schedule a bounded retry
  // (exponential backoff) to avoid tight failure loops during reconnects.
  useEffect(() => {
    // Wait for both provider config and API client before draining.
    // During reconnect/auth transitions api can be null while gwConfig is
    // populated — in that state, keep pending models queued for later.
    if (!gwConfig || !api || pendingGatewayEnrollments.size === 0) return;
    if (enrollmentDrainState.inFlight) return;

    const batch = [...pendingGatewayEnrollments];
    const nextModels = Array.from(new Set([...enabledModels, ...batch]));

    enrollmentDrainState.inFlight = true;
    updateOptimistically("mux-gateway", { gatewayModels: nextModels });

    let persistFailed = false;

    api.config
      .updateMuxGatewayPrefs({
        muxGatewayEnabled: isEnabled,
        muxGatewayModels: nextModels,
      })
      .then(() => {
        // Remove only the models persisted by this batch.
        for (const id of batch) pendingGatewayEnrollments.delete(id);

        // Reset retry state after success.
        enrollmentDrainState.retryDelayMs = 250;
        if (enrollmentDrainState.retryTimer != null) {
          window.clearTimeout(enrollmentDrainState.retryTimer);
          enrollmentDrainState.retryTimer = null;
        }
      })
      .catch(() => {
        persistFailed = true;
        // Keep queued models for retry and back off to avoid tight loops.
        if (enrollmentDrainState.retryTimer == null) {
          const delayMs = enrollmentDrainState.retryDelayMs;
          enrollmentDrainState.retryDelayMs = Math.min(delayMs * 2, 5_000);
          enrollmentDrainState.retryTimer = window.setTimeout(() => {
            enrollmentDrainState.retryTimer = null;
            window.dispatchEvent(new Event(ENROLLMENT_PENDING_EVENT));
          }, delayMs);
        }
      })
      .finally(() => {
        enrollmentDrainState.inFlight = false;

        // If new models were queued while this drain was in flight, process
        // them immediately after a successful persist.
        if (!persistFailed && pendingGatewayEnrollments.size > 0) {
          window.dispatchEvent(new Event(ENROLLMENT_PENDING_EVENT));
        }
      });
  }, [gwConfig, enabledModels, isEnabled, api, updateOptimistically, enrollVersion]);

  const toggleEnabled = useCallback(() => {
    const nextEnabled = !isEnabled;
    // Optimistic update for instant UI feedback
    updateOptimistically("mux-gateway", { isEnabled: nextEnabled });
    persistGatewayPrefs(nextEnabled, enabledModels);
  }, [enabledModels, isEnabled, persistGatewayPrefs, updateOptimistically]);

  const setEnabledModels = useCallback(
    (nextModels: string[]) => {
      // Keep writes centralized in this hook so all gateway actions (global toggle,
      // per-model toggle, and "enable all") persist from one config snapshot.
      updateOptimistically("mux-gateway", { gatewayModels: nextModels });

      const persistedEnabled = gwConfig?.isEnabled;
      if (persistedEnabled == null) {
        // Do not guess enabled-state before hydration. Persist once gwConfig is
        // available so we don't accidentally flip a user-disabled gateway on.
        pendingGatewayModelsUntilHydrated.models = nextModels;
        return;
      }

      if (!persistGatewayPrefs(persistedEnabled, nextModels)) {
        pendingGatewayModelsUntilHydrated.models = nextModels;
        return;
      }

      pendingGatewayModelsUntilHydrated.models = null;
    },
    [gwConfig?.isEnabled, persistGatewayPrefs, updateOptimistically]
  );

  // Flush any deferred model enrollment now that gateway enabled-state is known.
  useEffect(() => {
    const pendingModels = pendingGatewayModelsUntilHydrated.models;
    const persistedEnabled = gwConfig?.isEnabled;
    if (!pendingModels || persistedEnabled == null) {
      return;
    }

    if (!persistGatewayPrefs(persistedEnabled, pendingModels)) {
      return;
    }

    pendingGatewayModelsUntilHydrated.models = null;
  }, [gwConfig?.isEnabled, persistGatewayPrefs]);

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
