import React, { useState, useCallback } from "react";
import { Plus, Loader2 } from "lucide-react";
import { SUPPORTED_PROVIDERS, PROVIDER_DISPLAY_NAMES } from "@/common/constants/providers";
import { KNOWN_MODELS } from "@/common/constants/knownModels";
import { useModelLRU } from "@/browser/hooks/useModelLRU";
import { useGateway } from "@/browser/hooks/useGatewayModels";
import { ModelRow } from "./ModelRow";
import { useAPI } from "@/browser/contexts/API";
import { useProvidersConfig } from "@/browser/hooks/useProvidersConfig";

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
  const { defaultModel, setDefaultModel } = useModelLRU();
  const gateway = useGateway();

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
  }));

  const customModels = getCustomModels();

  return (
    <div className="space-y-4">
      <p className="text-muted text-xs">
        Manage your models. Click the star to set a default model for new workspaces.
      </p>

      {/* Custom Models - shown first */}
      <div className="space-y-1.5">
        <div className="text-muted text-xs font-medium tracking-wide uppercase">Custom Models</div>

        {/* Add new model form */}
        <div className="border-border-medium bg-background-secondary rounded-md border p-2">
          <div className="flex flex-wrap gap-1.5">
            <select
              value={newModel.provider}
              onChange={(e) => setNewModel((prev) => ({ ...prev, provider: e.target.value }))}
              className="bg-modal-bg border-border-medium focus:border-accent shrink-0 rounded border px-2 py-1 text-xs focus:outline-none"
            >
              <option value="">Provider</option>
              {SUPPORTED_PROVIDERS.map((p) => (
                <option key={p} value={p}>
                  {PROVIDER_DISPLAY_NAMES[p]}
                </option>
              ))}
            </select>
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
            <button
              type="button"
              onClick={handleAddModel}
              disabled={!newModel.provider || !newModel.modelId.trim()}
              className="bg-accent hover:bg-accent-dark disabled:bg-border-medium flex shrink-0 items-center gap-1 rounded px-2 py-1 text-xs text-white transition-colors disabled:cursor-not-allowed"
            >
              <Plus className="h-3.5 w-3.5" />
              Add
            </button>
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
              isDefault={defaultModel === model.fullId}
              isEditing={isModelEditing}
              editValue={isModelEditing ? editing.newModelId : undefined}
              editError={isModelEditing ? error : undefined}
              saving={false}
              hasActiveEdit={editing !== null}
              isGatewayEnabled={gateway.modelUsesGateway(model.fullId)}
              onSetDefault={() => setDefaultModel(model.fullId)}
              onStartEdit={() => handleStartEdit(model.provider, model.modelId)}
              onSaveEdit={handleSaveEdit}
              onCancelEdit={handleCancelEdit}
              onEditChange={(value) =>
                setEditing((prev) => (prev ? { ...prev, newModelId: value } : null))
              }
              onRemove={() => handleRemoveModel(model.provider, model.modelId)}
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
            isCustom={false}
            isDefault={defaultModel === model.fullId}
            isEditing={false}
            isGatewayEnabled={gateway.modelUsesGateway(model.fullId)}
            onSetDefault={() => setDefaultModel(model.fullId)}
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
