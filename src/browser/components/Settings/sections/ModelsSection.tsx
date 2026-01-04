import React, { useState, useCallback, useEffect, useRef } from "react";
import { Plus, Loader2 } from "lucide-react";
import { SUPPORTED_PROVIDERS, PROVIDER_DISPLAY_NAMES } from "@/common/constants/providers";
import { KNOWN_MODELS } from "@/common/constants/knownModels";
import { useModelsFromSettings } from "@/browser/hooks/useModelsFromSettings";
import { useGateway } from "@/browser/hooks/useGatewayModels";
import { ModelRow } from "./ModelRow";
import { useAPI } from "@/browser/contexts/API";
import { useProvidersConfig } from "@/browser/hooks/useProvidersConfig";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/browser/components/ui/select";
import { Button } from "@/browser/components/ui/button";
import { ModelSelector } from "@/browser/components/ModelSelector";
import { MODE_AI_DEFAULTS_KEY } from "@/common/constants/storage";
import { normalizeModeAiDefaults, type ModeAiDefaults } from "@/common/types/modeAiDefaults";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";

// Providers to exclude from the custom models UI (handled specially or internal)
const HIDDEN_PROVIDERS = new Set(["mux-gateway"]);

interface NewModelForm {
  provider: string;
  modelId: string;
}

interface EditingState {
  provider: string;
  originalModelId: string;
  newModelId: string;
}

export function ModelsSection() {
  const { api } = useAPI();
  const { config, loading, updateModelsOptimistically } = useProvidersConfig();
  const [newModel, setNewModel] = useState<NewModelForm>({ provider: "", modelId: "" });
  const [editing, setEditing] = useState<EditingState | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Compaction model state
  const [compactionModel, setCompactionModelState] = useState<string>("");
  const [compactionLoaded, setCompactionLoaded] = useState(false);
  const compactionSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const selectableProviders = SUPPORTED_PROVIDERS.filter(
    (provider) => !HIDDEN_PROVIDERS.has(provider)
  );
  const { models, defaultModel, setDefaultModel, hiddenModels, hideModel, unhideModel } =
    useModelsFromSettings();
  const gateway = useGateway();

  // Load compaction model from config on mount
  useEffect(() => {
    if (!api) return;

    void api.config
      .getConfig()
      .then((cfg) => {
        const normalized = normalizeModeAiDefaults(cfg.modeAiDefaults ?? {});
        setCompactionModelState(normalized.compact?.modelString ?? "");
        setCompactionLoaded(true);
      })
      .catch(() => {
        setCompactionLoaded(true);
      });
  }, [api]);

  // Debounced save for compaction model changes
  const setCompactionModel = useCallback(
    (model: string) => {
      setCompactionModelState(model);

      // Clear any pending save
      if (compactionSaveTimerRef.current) {
        clearTimeout(compactionSaveTimerRef.current);
      }

      compactionSaveTimerRef.current = setTimeout(() => {
        if (!api) return;

        // Update local cache immediately for non-React readers
        updatePersistedState<ModeAiDefaults>(
          MODE_AI_DEFAULTS_KEY,
          (prev) => {
            const next = { ...prev };
            if (!model) {
              if (next.compact) {
                delete next.compact.modelString;
                if (!next.compact.thinkingLevel) delete next.compact;
              }
            } else {
              next.compact = { ...next.compact, modelString: model };
            }
            return next;
          },
          {}
        );

        // Persist to backend
        void api.config.getConfig().then((cfg) => {
          const existing = normalizeModeAiDefaults(cfg.modeAiDefaults ?? {});
          const updated: ModeAiDefaults = { ...existing };

          if (!model) {
            if (updated.compact) {
              delete updated.compact.modelString;
              if (!updated.compact.thinkingLevel) {
                delete updated.compact;
              }
            }
          } else {
            updated.compact = { ...updated.compact, modelString: model };
          }

          void api.config.updateModeAiDefaults({ modeAiDefaults: updated });
        });
      }, 400);
    },
    [api]
  );

  // Cleanup save timer on unmount
  useEffect(() => {
    return () => {
      if (compactionSaveTimerRef.current) {
        clearTimeout(compactionSaveTimerRef.current);
      }
    };
  }, []);

  // Check if a model already exists (for duplicate prevention)
  const modelExists = useCallback(
    (provider: string, modelId: string, excludeOriginal?: string): boolean => {
      if (!config) return false;
      const currentModels = config[provider]?.models ?? [];
      return currentModels.some((m) => m === modelId && m !== excludeOriginal);
    },
    [config]
  );

  const handleAddModel = useCallback(() => {
    if (!config || !newModel.provider || !newModel.modelId.trim()) return;

    // mux-gateway is a routing layer, not a provider users should add models under.
    if (HIDDEN_PROVIDERS.has(newModel.provider)) {
      setError("Mux Gateway models can't be added directly. Enable Gateway per-model instead.");
      return;
    }
    const trimmedModelId = newModel.modelId.trim();

    // Check for duplicates
    if (modelExists(newModel.provider, trimmedModelId)) {
      setError(`Model "${trimmedModelId}" already exists for this provider`);
      return;
    }

    if (!api) return;
    setError(null);

    // Optimistic update - returns new models array for API call
    const updatedModels = updateModelsOptimistically(newModel.provider, (models) => [
      ...models,
      trimmedModelId,
    ]);
    setNewModel({ provider: "", modelId: "" });

    // Save in background
    void api.providers.setModels({ provider: newModel.provider, models: updatedModels });
  }, [api, newModel, config, modelExists, updateModelsOptimistically]);

  const handleRemoveModel = useCallback(
    (provider: string, modelId: string) => {
      if (!config || !api) return;

      // Optimistic update - returns new models array for API call
      const updatedModels = updateModelsOptimistically(provider, (models) =>
        models.filter((m) => m !== modelId)
      );

      // Save in background
      void api.providers.setModels({ provider, models: updatedModels });
    },
    [api, config, updateModelsOptimistically]
  );

  const handleStartEdit = useCallback((provider: string, modelId: string) => {
    setEditing({ provider, originalModelId: modelId, newModelId: modelId });
    setError(null);
  }, []);

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

    // Only validate duplicates if the model ID actually changed
    if (trimmedModelId !== editing.originalModelId) {
      if (modelExists(editing.provider, trimmedModelId)) {
        setError(`Model "${trimmedModelId}" already exists for this provider`);
        return;
      }
    }

    setError(null);

    // Optimistic update - returns new models array for API call
    const updatedModels = updateModelsOptimistically(editing.provider, (models) =>
      models.map((m) => (m === editing.originalModelId ? trimmedModelId : m))
    );
    setEditing(null);

    // Save in background
    void api.providers.setModels({ provider: editing.provider, models: updatedModels });
  }, [api, editing, config, modelExists, updateModelsOptimistically]);

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
  const getCustomModels = (): Array<{ provider: string; modelId: string; fullId: string }> => {
    const models: Array<{ provider: string; modelId: string; fullId: string }> = [];
    for (const [provider, providerConfig] of Object.entries(config)) {
      // Skip hidden providers (mux-gateway models are accessed via the cloud toggle, not listed separately)
      if (HIDDEN_PROVIDERS.has(provider)) continue;
      if (providerConfig.models) {
        for (const modelId of providerConfig.models) {
          models.push({ provider, modelId, fullId: `${provider}:${modelId}` });
        }
      }
    }
    return models;
  };

  // Get built-in models from KNOWN_MODELS
  const builtInModels = Object.values(KNOWN_MODELS).map((model) => ({
    provider: model.provider,
    modelId: model.providerModelId,
    fullId: model.id,
    aliases: model.aliases,
    contextWindow: model.contextWindow,
    description: model.description,
  }));

  const customModels = getCustomModels();

  return (
    <div className="space-y-4">
      {/* Model Defaults */}
      {compactionLoaded && (
        <div className="border-border-medium bg-background-secondary rounded-md border p-3">
          <div className="text-foreground mb-3 text-sm font-medium">Model Defaults</div>

          {/* Default Model */}
          <div className="mb-4 space-y-1">
            <div className="text-muted text-xs">Default Model</div>
            <ModelSelector
              value={defaultModel}
              onChange={setDefaultModel}
              models={models}
              hiddenModels={hiddenModels}
            />
            <div className="text-muted-light text-[10px]">Used for new workspaces</div>
          </div>

          {/* Compaction Model */}
          <div className="space-y-1">
            <div className="text-muted text-xs">Compaction Model</div>
            <ModelSelector
              value={compactionModel}
              emptyLabel="Use workspace model"
              onChange={setCompactionModel}
              models={models}
              hiddenModels={hiddenModels}
            />
            <div className="text-muted-light text-[10px]">
              Model used for compacting history. Falls back to workspace model if not set.
            </div>
          </div>
        </div>
      )}

      {/* Custom Models - shown first */}
      <div className="space-y-1.5">
        <div className="text-muted text-xs font-medium tracking-wide uppercase">Custom Models</div>

        {/* Add new model form */}
        <div className="border-border-medium bg-background-secondary rounded-md border p-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <Select
              value={newModel.provider}
              onValueChange={(value) => setNewModel((prev) => ({ ...prev, provider: value }))}
            >
              <SelectTrigger className="bg-modal-bg border-border-medium focus:border-accent h-7 w-auto shrink-0 rounded border px-2 text-xs">
                <SelectValue placeholder="Provider" />
              </SelectTrigger>
              <SelectContent>
                {selectableProviders.map((provider) => (
                  <SelectItem key={provider} value={provider}>
                    {PROVIDER_DISPLAY_NAMES[provider]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <input
              type="text"
              value={newModel.modelId}
              onChange={(e) => setNewModel((prev) => ({ ...prev, modelId: e.target.value }))}
              placeholder="model-id"
              className="bg-modal-bg border-border-medium focus:border-accent min-w-0 flex-1 rounded border px-2 py-1 font-mono text-xs focus:outline-none"
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleAddModel();
              }}
            />
            <Button
              type="button"
              size="sm"
              onClick={handleAddModel}
              disabled={!newModel.provider || !newModel.modelId.trim()}
              className="h-7 shrink-0 gap-1 px-2 text-xs"
            >
              <Plus className="h-3.5 w-3.5" />
              Add
            </Button>
          </div>
          {error && !editing && <div className="text-error mt-1.5 text-xs">{error}</div>}
        </div>

        {/* List custom models */}
        {customModels.map((model) => {
          const isModelEditing =
            editing?.provider === model.provider && editing?.originalModelId === model.modelId;
          return (
            <ModelRow
              key={model.fullId}
              provider={model.provider}
              modelId={model.modelId}
              fullId={model.fullId}
              isCustom={true}
              isEditing={isModelEditing}
              editValue={isModelEditing ? editing.newModelId : undefined}
              editError={isModelEditing ? error : undefined}
              saving={false}
              hasActiveEdit={editing !== null}
              isGatewayEnabled={gateway.modelUsesGateway(model.fullId)}
              onStartEdit={() => handleStartEdit(model.provider, model.modelId)}
              onSaveEdit={handleSaveEdit}
              onCancelEdit={handleCancelEdit}
              onEditChange={(value) =>
                setEditing((prev) => (prev ? { ...prev, newModelId: value } : null))
              }
              onRemove={() => handleRemoveModel(model.provider, model.modelId)}
              isHiddenFromSelector={hiddenModels.includes(model.fullId)}
              onToggleVisibility={() =>
                hiddenModels.includes(model.fullId)
                  ? unhideModel(model.fullId)
                  : hideModel(model.fullId)
              }
              onToggleGateway={
                gateway.canToggleModel(model.fullId)
                  ? () => gateway.toggleModelGateway(model.fullId)
                  : undefined
              }
            />
          );
        })}
      </div>

      {/* Built-in Models */}
      <div className="space-y-1.5">
        <div className="text-muted text-xs font-medium tracking-wide uppercase">
          Built-in Models
        </div>
        {builtInModels.map((model) => (
          <ModelRow
            key={model.fullId}
            provider={model.provider}
            modelId={model.modelId}
            fullId={model.fullId}
            aliases={model.aliases}
            contextWindow={model.contextWindow}
            description={model.description}
            isCustom={false}
            isEditing={false}
            isGatewayEnabled={gateway.modelUsesGateway(model.fullId)}
            isHiddenFromSelector={hiddenModels.includes(model.fullId)}
            onToggleVisibility={() =>
              hiddenModels.includes(model.fullId)
                ? unhideModel(model.fullId)
                : hideModel(model.fullId)
            }
            onToggleGateway={
              gateway.canToggleModel(model.fullId)
                ? () => gateway.toggleModelGateway(model.fullId)
                : undefined
            }
          />
        ))}
      </div>
    </div>
  );
}
