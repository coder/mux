import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowRight, Info, Loader2, Plus, ShieldCheck } from "lucide-react";
import { useProviderOptions } from "@/browser/hooks/useProviderOptions";
import { Button } from "@/browser/components/Button/Button";
import { ProviderIcon } from "@/browser/components/ProviderIcon/ProviderIcon";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/browser/components/SelectPrimitive/SelectPrimitive";
import { useAPI } from "@/browser/contexts/API";
import { useSettings } from "@/browser/contexts/SettingsContext";
import { useModelsFromSettings } from "@/browser/hooks/useModelsFromSettings";
import { useRouting } from "@/browser/hooks/useRouting";
import { useMinThinkingLevels } from "@/browser/hooks/useMinThinkingLevels";
import { usePersistedState } from "@/browser/hooks/usePersistedState";
import { useProvidersConfig } from "@/browser/hooks/useProvidersConfig";
import { KNOWN_MODELS } from "@/common/constants/knownModels";
import { isCodexOauthRequiredModelId } from "@/common/constants/codexOAuth";
import { usePolicy } from "@/browser/contexts/PolicyContext";
import {
  getExplicitGatewayPrefix,
  getModelProvider,
  supports1MContext,
} from "@/common/utils/ai/models";
import { getAllowedProvidersForUi, isModelAllowedByPolicy } from "@/browser/utils/policyUi";
import { LAST_CUSTOM_MODEL_PROVIDER_KEY } from "@/common/constants/storage";
import type { ProviderModelEntry } from "@/common/orpc/types";
import {
  getProviderModelEntryContextWindowTokens,
  getProviderModelEntryId,
  getProviderModelEntryMappedTo,
} from "@/common/utils/providers/modelEntries";
import { formatProviderDisplayName } from "@/common/utils/providers/customProviders";
import { ModelRow } from "./ModelRow";

// Providers to exclude from the custom models UI (handled specially or internal)
const HIDDEN_PROVIDERS = new Set(["mux-gateway"]);

// Shared header cell styles
const headerCellBase = "py-1.5 pr-2 text-xs font-medium text-muted";

// Table header component to avoid duplication
function ModelsTableHeader() {
  return (
    <thead>
      <tr className="border-border-medium bg-background-secondary/50 border-b">
        <th className={`${headerCellBase} pl-2 text-left md:pl-3`}>Model</th>
        <th className={`${headerCellBase} w-16 text-right md:w-20`}>Context</th>
        <th className={`${headerCellBase} w-32 text-left md:w-40`}>Route</th>
        <th className={`${headerCellBase} w-28 text-left md:w-32`}>Min Thinking</th>
        <th className={`${headerCellBase} w-28 text-right md:w-32 md:pr-3`}>Actions</th>
      </tr>
    </thead>
  );
}

interface EditableModelParameterOverrides {
  max_output_tokens: number | null;
  temperature: number | null;
  top_p: number | null;
}

interface EditingState {
  provider: string;
  originalModelId: string;
  newModelId: string;
  contextWindowTokens: string;
  mappedToModel: string;
  maxOutputTokens: string;
  temperature: string;
  topP: string;
  focus?: "model" | "context";
}

interface CustomModelInfo {
  provider: string;
  modelId: string;
  fullId: string;
  contextWindowTokens: number | null;
  mappedToModel: string | null;
  maxOutputTokens: number | null;
  temperature: number | null;
  topP: number | null;
}

export function parsePositiveIntegerInput(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return null;
  }

  return parsed;
}

function parseContextWindowTokensInput(value: string): number | null {
  return parsePositiveIntegerInput(value);
}

export function parseBoundedNumberInput(value: string, min: number, max: number): number | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    return null;
  }

  return parsed;
}

function getEditableModelParameterOverrides(
  modelParametersByModel: Record<
    string,
    { max_output_tokens?: number; temperature?: number; top_p?: number } | undefined
  >,
  modelId: string
): EditableModelParameterOverrides {
  const modelOverrides = modelParametersByModel[modelId];
  return {
    max_output_tokens:
      typeof modelOverrides?.max_output_tokens === "number"
        ? modelOverrides.max_output_tokens
        : null,
    temperature:
      typeof modelOverrides?.temperature === "number" ? modelOverrides.temperature : null,
    top_p: typeof modelOverrides?.top_p === "number" ? modelOverrides.top_p : null,
  };
}

function buildProviderModelEntry(
  modelId: string,
  contextWindowTokens: number | null,
  mappedToModel: string | null
): ProviderModelEntry {
  if (contextWindowTokens === null && mappedToModel === null) {
    return modelId;
  }

  const entry: Exclude<ProviderModelEntry, string> = { id: modelId };
  if (contextWindowTokens !== null) {
    entry.contextWindowTokens = contextWindowTokens;
  }
  if (mappedToModel !== null) {
    entry.mappedToModel = mappedToModel;
  }

  return entry;
}

export function buildUpdatedModelParameters(
  currentModelParameters: Record<string, Record<string, unknown>> | undefined,
  modelId: string,
  overrides: EditableModelParameterOverrides
): Record<string, Record<string, unknown>> | undefined {
  const nextModelParameters = { ...(currentModelParameters ?? {}) };
  const currentOverrides = nextModelParameters[modelId];
  const nextOverrides: Record<string, unknown> = {
    ...(typeof currentOverrides === "object" && currentOverrides !== null ? currentOverrides : {}),
  };

  if (overrides.max_output_tokens === null) {
    delete nextOverrides.max_output_tokens;
  } else {
    nextOverrides.max_output_tokens = overrides.max_output_tokens;
  }

  if (overrides.temperature === null) {
    delete nextOverrides.temperature;
  } else {
    nextOverrides.temperature = overrides.temperature;
  }

  if (overrides.top_p === null) {
    delete nextOverrides.top_p;
  } else {
    nextOverrides.top_p = overrides.top_p;
  }

  if (Object.keys(nextOverrides).length === 0) {
    delete nextModelParameters[modelId];
  } else {
    nextModelParameters[modelId] = nextOverrides;
  }

  return Object.keys(nextModelParameters).length > 0 ? nextModelParameters : undefined;
}

export function removeModelParameterEntry(
  currentModelParameters: Record<string, Record<string, unknown>> | undefined,
  modelId: string
): Record<string, Record<string, unknown>> | undefined {
  if (!currentModelParameters || !(modelId in currentModelParameters)) {
    return currentModelParameters;
  }

  const nextModelParameters = { ...currentModelParameters };
  delete nextModelParameters[modelId];
  return Object.keys(nextModelParameters).length > 0 ? nextModelParameters : undefined;
}

export function shouldShowModelInSettings(modelId: string, codexOauthConfigured: boolean): boolean {
  // OpenAI OAuth gating only applies to OpenAI-routed models; other providers can
  // reuse the same providerModelId string without requiring OpenAI OAuth.
  if (getModelProvider(modelId) !== "openai") {
    return true;
  }

  // Keep OAuth-required OpenAI models out of Settings until OAuth is connected,
  // so users don't pick defaults that fail at send time.
  return codexOauthConfigured || !isCodexOauthRequiredModelId(modelId);
}

export function shouldAllowRouteOverrideInSettings(modelId: string): boolean {
  // Explicit gateway rows already pin their route in the model ID. Wiring the
  // route picker here would mutate the canonical sibling row's override while
  // leaving the explicit row itself pinned to its gateway.
  return getExplicitGatewayPrefix(modelId) === undefined;
}

export function ModelsSection() {
  const policyState = usePolicy();
  const effectivePolicy =
    policyState.status.state === "enforced" ? (policyState.policy ?? null) : null;

  const { api } = useAPI();
  const { open: openSettings } = useSettings();
  const { config, loading, refresh, updateModelsOptimistically, updateOptimistically } =
    useProvidersConfig();
  const [lastProvider, setLastProvider] = usePersistedState(LAST_CUSTOM_MODEL_PROVIDER_KEY, "");
  const [newModelId, setNewModelId] = useState("");
  const [editing, setEditing] = useState<EditingState | null>(null);
  const [error, setError] = useState<string | null>(null);

  const allowedProviders = useMemo(
    () =>
      getAllowedProvidersForUi(effectivePolicy, config).filter(
        (provider) => !HIDDEN_PROVIDERS.has(provider)
      ),
    [effectivePolicy, config]
  );

  useEffect(() => {
    if (config === null || !lastProvider || allowedProviders.includes(lastProvider)) {
      return;
    }

    // Sync persisted lastProvider to backend provider config after providers finish loading.
    setLastProvider(allowedProviders[0] ?? "");
  }, [config, allowedProviders, lastProvider, setLastProvider]);

  const { defaultModel, setDefaultModel, hiddenModels, hideModel, unhideModel } =
    useModelsFromSettings();
  const routing = useRouting();
  const minThinking = useMinThinkingLevels();
  const { has1MContext, toggle1MContext } = useProviderOptions();

  // Read OAuth state from this component's provider config source to avoid
  // cross-hook timing mismatches while settings are loading/refetching.
  const codexOauthConfigured = config?.openai?.codexOauthSet === true;

  // "Treat as" dropdown should only list known models — custom models don't have
  // the metadata (pricing, context window, tokenizer) that mapping inherits.
  // Static list — React Compiler handles memoization; no manual useMemo needed.
  const knownModelIds = Object.values(KNOWN_MODELS)
    .map((model) => model.id)
    .sort();

  // Check if a model already exists (for duplicate prevention)
  const modelExists = useCallback(
    (provider: string, modelId: string, excludeOriginal?: string): boolean => {
      if (!config) return false;
      const currentModels = config[provider]?.models ?? [];
      return currentModels.some((entry) => {
        const currentModelId = getProviderModelEntryId(entry);
        return currentModelId === modelId && currentModelId !== excludeOriginal;
      });
    },
    [config]
  );

  const handleAddModel = useCallback(() => {
    if (!config || !lastProvider || !newModelId.trim()) return;

    // mux-gateway is a routing layer, not a provider users should add models under.
    if (HIDDEN_PROVIDERS.has(lastProvider)) {
      setError("Mux Gateway models can't be added directly. Enable Gateway per-model instead.");
      return;
    }
    const trimmedModelId = newModelId.trim();

    // Check for duplicates
    if (modelExists(lastProvider, trimmedModelId)) {
      setError(`Model "${trimmedModelId}" already exists for this provider`);
      return;
    }

    if (!api) return;
    setError(null);

    // Optimistic update - returns new models array for API call
    const updatedModels = updateModelsOptimistically(lastProvider, (models) => [
      ...models,
      trimmedModelId,
    ]);
    setNewModelId("");

    // Save in background
    void api.providers.setModels({ provider: lastProvider, models: updatedModels });
  }, [api, lastProvider, newModelId, config, modelExists, updateModelsOptimistically]);

  const handleRemoveModel = useCallback(
    (provider: string, modelId: string) => {
      if (!config || !api) return;

      // Optimistic update - returns new models array for API call
      const updatedModels = updateModelsOptimistically(provider, (models) =>
        models.filter((entry) => getProviderModelEntryId(entry) !== modelId)
      );

      const providerModelParameters = config[provider]?.modelParameters as
        | Record<string, Record<string, unknown>>
        | undefined;
      updateOptimistically(provider, {
        modelParameters: removeModelParameterEntry(providerModelParameters, modelId),
      });

      void (async () => {
        const setModelsResult = await api.providers.setModels({ provider, models: updatedModels });
        if (!setModelsResult.success) {
          setError(setModelsResult.error);
          void refresh();
          return;
        }

        const clearOverridesResult = await api.providers.setModelParameters({
          provider,
          modelId,
          overrides: {
            max_output_tokens: null,
            temperature: null,
            top_p: null,
          },
        });

        if (!clearOverridesResult.success) {
          setError(clearOverridesResult.error);
          void refresh();
        }
      })();
    },
    [api, config, refresh, updateModelsOptimistically, updateOptimistically]
  );

  const startModelEdit = useCallback((model: CustomModelInfo, focus: "model" | "context") => {
    setEditing({
      provider: model.provider,
      originalModelId: model.modelId,
      newModelId: model.modelId,
      contextWindowTokens:
        model.contextWindowTokens === null ? "" : String(model.contextWindowTokens),
      mappedToModel: model.mappedToModel ?? "",
      maxOutputTokens: model.maxOutputTokens === null ? "" : String(model.maxOutputTokens),
      temperature: model.temperature === null ? "" : String(model.temperature),
      topP: model.topP === null ? "" : String(model.topP),
      focus,
    });
    setError(null);
  }, []);

  const handleStartEdit = useCallback(
    (model: CustomModelInfo) => {
      startModelEdit(model, "model");
    },
    [startModelEdit]
  );

  const handleStartContextEdit = useCallback(
    (model: CustomModelInfo) => {
      startModelEdit(model, "context");
    },
    [startModelEdit]
  );

  const handleCancelEdit = useCallback(() => {
    setEditing(null);
    setError(null);
  }, []);

  const handleSaveEdit = useCallback(() => {
    if (!config || !editing || !api) return;

    const trimmedModelId = editing.newModelId.trim();
    if (!trimmedModelId) {
      setError("Model ID cannot be empty");
      return;
    }

    const contextWindowTokensInput = editing.contextWindowTokens.trim();
    const parsedContextWindowTokens = parseContextWindowTokensInput(contextWindowTokensInput);
    if (contextWindowTokensInput.length > 0 && parsedContextWindowTokens === null) {
      setError("Context window must be a positive integer");
      return;
    }

    const maxOutputTokensInput = editing.maxOutputTokens.trim();
    const parsedMaxOutputTokens = parsePositiveIntegerInput(maxOutputTokensInput);
    if (maxOutputTokensInput.length > 0 && parsedMaxOutputTokens === null) {
      setError("Max output tokens must be a positive integer");
      return;
    }

    const temperatureInput = editing.temperature.trim();
    const parsedTemperature = parseBoundedNumberInput(temperatureInput, 0, 2);
    if (temperatureInput.length > 0 && parsedTemperature === null) {
      setError("Temperature must be a number between 0 and 2");
      return;
    }

    const topPInput = editing.topP.trim();
    const parsedTopP = parseBoundedNumberInput(topPInput, 0, 1);
    if (topPInput.length > 0 && parsedTopP === null) {
      setError("Top P must be a number between 0 and 1");
      return;
    }

    // Only validate duplicates if the model ID actually changed
    if (trimmedModelId !== editing.originalModelId) {
      if (modelExists(editing.provider, trimmedModelId)) {
        setError(`Model "${trimmedModelId}" already exists for this provider`);
        return;
      }
    }

    setError(null);

    const mappedTo = editing.mappedToModel.trim() || null;
    const replacementEntry = buildProviderModelEntry(
      trimmedModelId,
      parsedContextWindowTokens,
      mappedTo
    );
    const overrides: EditableModelParameterOverrides = {
      max_output_tokens: parsedMaxOutputTokens,
      temperature: parsedTemperature,
      top_p: parsedTopP,
    };

    // Optimistic update - returns new models array for API call
    const updatedModels = updateModelsOptimistically(editing.provider, (models) => {
      const nextModels: ProviderModelEntry[] = [];
      let replaced = false;

      for (const modelEntry of models) {
        if (!replaced && getProviderModelEntryId(modelEntry) === editing.originalModelId) {
          nextModels.push(replacementEntry);
          replaced = true;
          continue;
        }

        nextModels.push(modelEntry);
      }

      if (!replaced) {
        nextModels.push(replacementEntry);
      }

      return nextModels;
    });

    const providerModelParameters = config[editing.provider]?.modelParameters as
      | Record<string, Record<string, unknown>>
      | undefined;
    let nextModelParameters = providerModelParameters;

    if (trimmedModelId !== editing.originalModelId) {
      nextModelParameters = removeModelParameterEntry(nextModelParameters, editing.originalModelId);
    }

    nextModelParameters = buildUpdatedModelParameters(
      nextModelParameters,
      trimmedModelId,
      overrides
    );

    updateOptimistically(editing.provider, {
      modelParameters: nextModelParameters,
    });

    const providerId = editing.provider;
    const originalModelId = editing.originalModelId;
    setEditing(null);

    void (async () => {
      const setModelsResult = await api.providers.setModels({
        provider: providerId,
        models: updatedModels,
      });
      if (!setModelsResult.success) {
        setError(setModelsResult.error);
        void refresh();
        return;
      }

      const setOverridesResult = await api.providers.setModelParameters({
        provider: providerId,
        modelId: trimmedModelId,
        overrides,
      });
      if (!setOverridesResult.success) {
        setError(setOverridesResult.error);
        void refresh();
        return;
      }

      if (trimmedModelId === originalModelId) {
        return;
      }

      const clearLegacyOverridesResult = await api.providers.setModelParameters({
        provider: providerId,
        modelId: originalModelId,
        overrides: {
          max_output_tokens: null,
          temperature: null,
          top_p: null,
        },
      });

      if (!clearLegacyOverridesResult.success) {
        setError(clearLegacyOverridesResult.error);
        void refresh();
      }
    })();
  }, [
    api,
    editing,
    config,
    modelExists,
    refresh,
    updateModelsOptimistically,
    updateOptimistically,
  ]);

  // Show loading state while config is being fetched
  if (loading || !config) {
    return (
      <div className="flex items-center justify-center gap-2 py-12">
        <Loader2 className="text-muted h-5 w-5 animate-spin" />
        <span className="text-muted text-sm">Loading settings...</span>
      </div>
    );
  }

  // Get all custom models across providers (excluding hidden providers like mux-gateway)
  const getCustomModels = (): CustomModelInfo[] => {
    const models: CustomModelInfo[] = [];

    for (const [provider, providerConfig] of Object.entries(config)) {
      // Skip hidden providers (mux-gateway models are routed, not managed as a standalone list)
      if (HIDDEN_PROVIDERS.has(provider)) continue;
      if (!providerConfig.models) continue;

      const modelParametersByModel =
        (providerConfig.modelParameters as Record<
          string,
          { max_output_tokens?: number; temperature?: number; top_p?: number } | undefined
        > | null) ?? {};

      for (const modelEntry of providerConfig.models) {
        const modelId = getProviderModelEntryId(modelEntry);
        const modelOverrides = getEditableModelParameterOverrides(modelParametersByModel, modelId);
        models.push({
          provider,
          modelId,
          fullId: `${provider}:${modelId}`,
          contextWindowTokens: getProviderModelEntryContextWindowTokens(modelEntry),
          mappedToModel: getProviderModelEntryMappedTo(modelEntry),
          maxOutputTokens: modelOverrides.max_output_tokens,
          temperature: modelOverrides.temperature,
          topP: modelOverrides.top_p,
        });
      }
    }

    return models;
  };

  // Get built-in models from KNOWN_MODELS.
  // Filter by policy so the settings table doesn't list models users can't ever select.
  const builtInModels = Object.values(KNOWN_MODELS)
    .map((model) => ({
      provider: model.provider,
      modelId: model.providerModelId,
      fullId: model.id,
      aliases: model.aliases,
    }))
    .filter((model) => shouldShowModelInSettings(model.fullId, codexOauthConfigured))
    .filter((model) => isModelAllowedByPolicy(effectivePolicy, model.fullId));

  const customModels = getCustomModels();

  return (
    <div className="space-y-4">
      {policyState.status.state === "enforced" && (
        <div className="border-border-medium bg-background-secondary/50 text-muted flex items-center gap-2 rounded-md border px-3 py-2 text-xs">
          <ShieldCheck className="h-4 w-4" aria-hidden />
          <span>Your settings are controlled by a policy.</span>
        </div>
      )}

      {/* Custom Models */}
      <div className="space-y-3">
        <div className="text-muted text-xs font-medium tracking-wide uppercase">Custom Models</div>

        {/* Add new model form - styled to match table */}
        <div className="border-border-medium overflow-hidden rounded-md border">
          <div className="border-border-medium bg-background-secondary/50 flex flex-wrap items-center gap-1.5 border-b px-2 py-1.5 md:px-3">
            <Select value={lastProvider} onValueChange={setLastProvider}>
              <SelectTrigger className="bg-background border-border-medium focus:border-accent h-7 w-auto shrink-0 rounded border px-2 text-xs">
                <SelectValue placeholder="Provider" />
              </SelectTrigger>
              <SelectContent>
                {allowedProviders.map((provider) => (
                  <SelectItem key={provider} value={provider}>
                    <span className="inline-flex items-center gap-1 whitespace-nowrap">
                      <ProviderIcon provider={provider} />
                      <span>{formatProviderDisplayName(provider, config?.[provider])}</span>
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <input
              type="text"
              value={newModelId}
              onChange={(e) => setNewModelId(e.target.value)}
              placeholder="model-id"
              className="bg-background border-border-medium focus:border-accent min-w-0 flex-1 rounded border px-2 py-1 font-mono text-xs focus:outline-none"
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleAddModel();
              }}
            />
            <Button
              type="button"
              size="sm"
              onClick={handleAddModel}
              disabled={!lastProvider || !newModelId.trim()}
              className="h-7 shrink-0 gap-1 px-2 text-xs"
            >
              <Plus className="h-3.5 w-3.5" />
              Add
            </Button>
          </div>
          {error && !editing && (
            <div className="text-error px-2 py-1.5 text-xs md:px-3">{error}</div>
          )}
        </div>

        {/* Table of custom models */}
        {customModels.length > 0 && (
          <div className="border-border-medium overflow-hidden rounded-md border">
            <table className="w-full">
              <ModelsTableHeader />
              <tbody>
                {customModels.map((model) => {
                  const isModelEditing =
                    editing?.provider === model.provider &&
                    editing?.originalModelId === model.modelId;
                  const allowRouteOverride = shouldAllowRouteOverrideInSettings(model.fullId);
                  return (
                    <ModelRow
                      key={model.fullId}
                      provider={model.provider}
                      modelId={model.modelId}
                      fullId={model.fullId}
                      mappedToModel={model.mappedToModel}
                      isCustom={true}
                      isDefault={defaultModel === model.fullId}
                      isEditing={isModelEditing}
                      editModelValue={isModelEditing ? editing.newModelId : undefined}
                      editContextValue={isModelEditing ? editing.contextWindowTokens : undefined}
                      editMappedToModel={isModelEditing ? editing.mappedToModel : undefined}
                      editMaxOutputTokensValue={
                        isModelEditing ? editing.maxOutputTokens : undefined
                      }
                      editTemperatureValue={isModelEditing ? editing.temperature : undefined}
                      editTopPValue={isModelEditing ? editing.topP : undefined}
                      editAutofocus={isModelEditing ? editing.focus : undefined}
                      customContextWindowTokens={model.contextWindowTokens}
                      allModels={knownModelIds}
                      editError={isModelEditing ? error : undefined}
                      saving={false}
                      hasActiveEdit={editing !== null}
                      resolvedRoute={routing.resolveRoute(model.fullId)}
                      autoResolvedRoute={routing.resolveAutoRoute(model.fullId)}
                      availableRoutes={routing.availableRoutes(model.fullId)}
                      is1MContextEnabled={has1MContext(model.fullId)}
                      onSetDefault={() => setDefaultModel(model.fullId)}
                      onStartEdit={() => handleStartEdit(model)}
                      onStartContextEdit={() => handleStartContextEdit(model)}
                      onSaveEdit={handleSaveEdit}
                      onCancelEdit={handleCancelEdit}
                      onEditModelChange={(value) =>
                        setEditing((prev) => (prev ? { ...prev, newModelId: value } : null))
                      }
                      onEditContextChange={(value) =>
                        setEditing((prev) =>
                          prev ? { ...prev, contextWindowTokens: value } : null
                        )
                      }
                      onEditMappedToModelChange={(value) =>
                        setEditing((prev) => (prev ? { ...prev, mappedToModel: value } : null))
                      }
                      onEditMaxOutputTokensChange={(value) =>
                        setEditing((prev) => (prev ? { ...prev, maxOutputTokens: value } : null))
                      }
                      onEditTemperatureChange={(value) =>
                        setEditing((prev) => (prev ? { ...prev, temperature: value } : null))
                      }
                      onEditTopPChange={(value) =>
                        setEditing((prev) => (prev ? { ...prev, topP: value } : null))
                      }
                      onRemove={() => handleRemoveModel(model.provider, model.modelId)}
                      isHiddenFromSelector={hiddenModels.includes(model.fullId)}
                      onToggleVisibility={() =>
                        hiddenModels.includes(model.fullId)
                          ? unhideModel(model.fullId)
                          : hideModel(model.fullId)
                      }
                      onSetRouteOverride={
                        allowRouteOverride
                          ? (route) => routing.setRouteOverride(model.fullId, route)
                          : undefined
                      }
                      minThinkingLevel={minThinking.getMinOverride(model.fullId)}
                      onSetMinThinkingLevel={(level) =>
                        minThinking.setMinThinkingLevel(model.fullId, level)
                      }
                      onToggle1MContext={
                        supports1MContext(model.fullId)
                          ? () => toggle1MContext(model.fullId)
                          : undefined
                      }
                    />
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Built-in Models */}
      <div className="space-y-3">
        <div className="text-muted text-xs font-medium tracking-wide uppercase">
          Built-in Models
        </div>
        <div className="border-border-medium overflow-hidden rounded-md border">
          <table className="w-full">
            <ModelsTableHeader />
            <tbody>
              {builtInModels.map((model) => (
                <ModelRow
                  key={model.fullId}
                  provider={model.provider}
                  modelId={model.modelId}
                  fullId={model.fullId}
                  aliases={model.aliases}
                  isCustom={false}
                  isDefault={defaultModel === model.fullId}
                  isEditing={false}
                  resolvedRoute={routing.resolveRoute(model.fullId)}
                  autoResolvedRoute={routing.resolveAutoRoute(model.fullId)}
                  availableRoutes={routing.availableRoutes(model.fullId)}
                  is1MContextEnabled={has1MContext(model.fullId)}
                  onSetDefault={() => setDefaultModel(model.fullId)}
                  isHiddenFromSelector={hiddenModels.includes(model.fullId)}
                  onToggleVisibility={() =>
                    hiddenModels.includes(model.fullId)
                      ? unhideModel(model.fullId)
                      : hideModel(model.fullId)
                  }
                  onSetRouteOverride={(route) => routing.setRouteOverride(model.fullId, route)}
                  minThinkingLevel={minThinking.getMinOverride(model.fullId)}
                  onSetMinThinkingLevel={(level) =>
                    minThinking.setMinThinkingLevel(model.fullId, level)
                  }
                  onToggle1MContext={
                    supports1MContext(model.fullId)
                      ? () => toggle1MContext(model.fullId)
                      : undefined
                  }
                />
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="border-border-medium bg-background-secondary/40 text-muted rounded-md border px-3 py-2.5 text-xs">
        <div className="flex items-start gap-2">
          <Info className="text-accent mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <div className="space-y-1">
            <p>
              Agent-specific model defaults and thinking levels (Compact and others) are configured
              in <span className="text-foreground font-medium">Settings → Agents</span>.
            </p>
            <Button
              type="button"
              variant="link"
              size="sm"
              onClick={() => openSettings("tasks")}
              className="text-accent h-auto px-0 py-0 text-xs"
            >
              Open Agents settings
              <ArrowRight className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      </div>

      {/* Oneshot Tips */}
      <div className="space-y-2">
        <div className="text-muted text-xs font-medium tracking-wide uppercase">
          Quick Shortcuts
        </div>
        <div className="border-border-medium bg-background-secondary/50 rounded-md border px-3 py-2.5 text-xs leading-relaxed">
          <p className="text-foreground mb-1.5 font-medium">
            Use model aliases as slash commands for one-shot overrides:
          </p>
          <div className="text-muted space-y-0.5 font-mono">
            <div>
              <span className="text-accent">/sonnet</span> explain this code
              <span className="text-muted/60 ml-2">— send one message with Sonnet</span>
            </div>
            <div>
              <span className="text-accent">/opus+high</span> deep review
              <span className="text-muted/60 ml-2">— Opus with high thinking</span>
            </div>
            <div>
              <span className="text-accent">/haiku+0</span> quick answer
              <span className="text-muted/60 ml-2">— Haiku with thinking off</span>
            </div>
            <div>
              <span className="text-accent">/+2</span> analyze this
              <span className="text-muted/60 ml-2">— current model, thinking level 2</span>
            </div>
          </div>
          <p className="text-muted mt-1.5">
            Numeric levels are relative to each model (0=lowest allowed, 1=next, etc.). Named
            levels: off, low, med, high, max.
          </p>
        </div>
      </div>
    </div>
  );
}
