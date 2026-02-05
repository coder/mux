import { useCallback, useMemo } from "react";
import { readPersistedString, usePersistedState } from "./usePersistedState";
import { KNOWN_MODELS } from "@/common/constants/knownModels";
import { WORKSPACE_DEFAULTS } from "@/constants/workspaceDefaults";
import { useProvidersConfig } from "./useProvidersConfig";
import { usePolicy } from "@/browser/contexts/PolicyContext";
import { useAPI } from "@/browser/contexts/API";
import { migrateGatewayModel } from "./useGatewayModels";
import { isValidProvider } from "@/common/constants/providers";
import { isModelAllowedByPolicy } from "@/browser/utils/policyUi";
import type { ProvidersConfigMap } from "@/common/orpc/types";
import { DEFAULT_MODEL_KEY, HIDDEN_MODELS_KEY } from "@/common/constants/storage";

const BUILT_IN_MODELS: string[] = Object.values(KNOWN_MODELS).map((m) => m.id);
const BUILT_IN_MODEL_SET = new Set<string>(BUILT_IN_MODELS);

function getCustomModels(config: ProvidersConfigMap | null): string[] {
  if (!config) return [];
  const models: string[] = [];
  for (const [provider, info] of Object.entries(config)) {
    // Skip mux-gateway - those models are accessed via the cloud toggle, not listed separately
    if (provider === "mux-gateway") continue;
    if (!info.models) continue;
    for (const modelId of info.models) {
      models.push(`${provider}:${modelId}`);
    }
  }
  return models;
}

export function filterHiddenModels(models: string[], hiddenModels: string[]): string[] {
  if (hiddenModels.length === 0) {
    return models;
  }

  const hidden = new Set(hiddenModels);
  return models.filter((m) => !hidden.has(m));
}
function dedupeKeepFirst(models: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of models) {
    if (seen.has(m)) continue;
    seen.add(m);
    out.push(m);
  }
  return out;
}

export function getSuggestedModels(config: ProvidersConfigMap | null): string[] {
  const customModels = getCustomModels(config);
  return dedupeKeepFirst([...customModels, ...BUILT_IN_MODELS]);
}

export function getDefaultModel(): string {
  const fallback = WORKSPACE_DEFAULTS.model;
  const persisted = readPersistedString(DEFAULT_MODEL_KEY);
  if (!persisted) return fallback;

  // Migrate legacy mux-gateway format to canonical form.
  const canonical = migrateGatewayModel(persisted).trim();
  return canonical || fallback;
}

/**
 * Source-of-truth for selectable models.
 *
 * The model selector should be driven by Settings (built-in + custom).
 * When a model is selected that isn't built-in, we persist it into Settings so it becomes
 * discoverable/manageable there.
 */
export function useModelsFromSettings() {
  const policyState = usePolicy();
  const effectivePolicy =
    policyState.status.state === "enforced" ? (policyState.policy ?? null) : null;
  const { api } = useAPI();

  const persistModelPrefs = useCallback(
    (patch: { defaultModel?: string; hiddenModels?: string[] }) => {
      if (!api?.config?.updateModelPreferences) {
        return;
      }

      api.config.updateModelPreferences(patch).catch(() => {
        // Best-effort only; startup seeding will heal the cache next time.
      });
    },
    [api]
  );
  const { config, refresh } = useProvidersConfig();

  const [defaultModel, setDefaultModel] = usePersistedState<string>(
    DEFAULT_MODEL_KEY,
    WORKSPACE_DEFAULTS.model,
    { listener: true }
  );

  const setDefaultModelAndPersist = useCallback(
    (next: string | ((prev: string) => string)) => {
      setDefaultModel((prev) => {
        const resolved = typeof next === "function" ? next(prev) : next;
        const canonical = migrateGatewayModel(resolved).trim();
        const canonicalPrev = migrateGatewayModel(prev).trim();

        if (canonical !== canonicalPrev) {
          persistModelPrefs({ defaultModel: canonical });
        }

        return canonical;
      });
    },
    [persistModelPrefs, setDefaultModel]
  );

  const [hiddenModels, setHiddenModels] = usePersistedState<string[]>(HIDDEN_MODELS_KEY, [], {
    listener: true,
  });

  const customModels = useMemo(() => {
    const next = filterHiddenModels(getCustomModels(config), hiddenModels);
    return effectivePolicy ? next.filter((m) => isModelAllowedByPolicy(effectivePolicy, m)) : next;
  }, [config, hiddenModels, effectivePolicy]);

  const models = useMemo(() => {
    const next = filterHiddenModels(getSuggestedModels(config), hiddenModels);
    return effectivePolicy ? next.filter((m) => isModelAllowedByPolicy(effectivePolicy, m)) : next;
  }, [config, hiddenModels, effectivePolicy]);

  /**
   * If a model is selected that isn't built-in, persist it as a provider custom model.
   */
  const ensureModelInSettings = useCallback(
    (modelString: string) => {
      if (!api) return;

      const canonical = migrateGatewayModel(modelString).trim();
      if (!canonical) return;
      if (BUILT_IN_MODEL_SET.has(canonical)) return;

      if (!isModelAllowedByPolicy(effectivePolicy, canonical)) {
        return;
      }

      const colonIndex = canonical.indexOf(":");
      if (colonIndex === -1) return;

      const provider = canonical.slice(0, colonIndex);
      const modelId = canonical.slice(colonIndex + 1);
      if (!provider || !modelId) return;
      if (provider === "mux-gateway") return;
      if (!isValidProvider(provider)) return;

      const run = async () => {
        const providerConfig = config ?? (await api.providers.getConfig());
        const existingModels = providerConfig[provider]?.models ?? [];
        if (existingModels.includes(modelId)) return;

        await api.providers.setModels({ provider, models: [...existingModels, modelId] });
        await refresh();
      };

      run().catch(() => {
        // Ignore failures - user can still manage models via Settings
      });
    },
    [api, config, refresh, effectivePolicy]
  );

  const hideModel = useCallback(
    (modelString: string) => {
      const canonical = migrateGatewayModel(modelString).trim();
      if (!canonical) {
        return;
      }

      setHiddenModels((prev) => {
        if (prev.includes(canonical)) {
          return prev;
        }

        const nextHiddenModels = [...prev, canonical];
        persistModelPrefs({ hiddenModels: nextHiddenModels });
        return nextHiddenModels;
      });
    },
    [persistModelPrefs, setHiddenModels]
  );

  const unhideModel = useCallback(
    (modelString: string) => {
      const canonical = migrateGatewayModel(modelString).trim();
      if (!canonical) {
        return;
      }

      setHiddenModels((prev) => {
        const nextHiddenModels = prev.filter((m) => m !== canonical);
        if (nextHiddenModels.length === prev.length) {
          return prev;
        }

        persistModelPrefs({ hiddenModels: nextHiddenModels });
        return nextHiddenModels;
      });
    },
    [persistModelPrefs, setHiddenModels]
  );

  return {
    ensureModelInSettings,
    models,
    customModels,
    hiddenModels,
    hideModel,
    unhideModel,
    defaultModel,
    setDefaultModel: setDefaultModelAndPersist,
  };
}
