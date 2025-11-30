import React, { useState, useEffect, useCallback } from "react";
import { Plus, Loader2 } from "lucide-react";
import type { ProvidersConfigMap } from "../types";
import { SUPPORTED_PROVIDERS, PROVIDER_DISPLAY_NAMES } from "@/common/constants/providers";
import { KNOWN_MODELS } from "@/common/constants/knownModels";
import { useModelLRU } from "@/browser/hooks/useModelLRU";
import { ModelRow } from "./ModelRow";

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
  const [config, setConfig] = useState<ProvidersConfigMap | null>(null);
  const [newModel, setNewModel] = useState<NewModelForm>({ provider: "", modelId: "" });
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState<EditingState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { defaultModel, setDefaultModel } = useModelLRU();

  // Load config on mount
  useEffect(() => {
    void (async () => {
      const cfg = await window.api.providers.getConfig();
      setConfig(cfg);
    })();
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

  const handleAddModel = useCallback(async () => {
    if (!config || !newModel.provider || !newModel.modelId.trim()) return;

    const trimmedModelId = newModel.modelId.trim();

    // Check for duplicates
    if (modelExists(newModel.provider, trimmedModelId)) {
      setError(`Model "${trimmedModelId}" already exists for this provider`);
      return;
    }

    setError(null);
    setSaving(true);
    try {
      const currentModels = config[newModel.provider]?.models ?? [];
      const updatedModels = [...currentModels, trimmedModelId];

      await window.api.providers.setModels(newModel.provider, updatedModels);

      // Refresh config
      const cfg = await window.api.providers.getConfig();
      setConfig(cfg);
      setNewModel({ provider: "", modelId: "" });

      // Notify other components about the change
      window.dispatchEvent(new Event("providers-config-changed"));
    } finally {
      setSaving(false);
    }
  }, [newModel, config, modelExists]);

  const handleRemoveModel = useCallback(
    async (provider: string, modelId: string) => {
      if (!config) return;
      setSaving(true);
      try {
        const currentModels = config[provider]?.models ?? [];
        const updatedModels = currentModels.filter((m) => m !== modelId);

        await window.api.providers.setModels(provider, updatedModels);

        // Refresh config
        const cfg = await window.api.providers.getConfig();
        setConfig(cfg);

        // Notify other components about the change
        window.dispatchEvent(new Event("providers-config-changed"));
      } finally {
        setSaving(false);
      }
    },
    [config]
  );

  const handleStartEdit = useCallback((provider: string, modelId: string) => {
    setEditing({ provider, originalModelId: modelId, newModelId: modelId });
    setError(null);
  }, []);

  const handleCancelEdit = useCallback(() => {
    setEditing(null);
    setError(null);
  }, []);

  const handleSaveEdit = useCallback(async () => {
    if (!config || !editing) return;

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
    setSaving(true);
    try {
      const currentModels = config[editing.provider]?.models ?? [];
      const updatedModels = currentModels.map((m) =>
        m === editing.originalModelId ? trimmedModelId : m
      );

      await window.api.providers.setModels(editing.provider, updatedModels);

      // Refresh config
      const cfg = await window.api.providers.getConfig();
      setConfig(cfg);
      setEditing(null);

      // Notify other components about the change
      window.dispatchEvent(new Event("providers-config-changed"));
    } finally {
      setSaving(false);
    }
  }, [editing, config, modelExists]);

  // Show loading state while config is being fetched
  if (config === null) {
    return (
      <div className="flex items-center justify-center gap-2 py-12">
        <Loader2 className="text-muted h-5 w-5 animate-spin" />
        <span className="text-muted text-sm">Loading settings...</span>
      </div>
    );
  }

  // Get all custom models across providers
  const getCustomModels = (): Array<{ provider: string; modelId: string; fullId: string }> => {
    const models: Array<{ provider: string; modelId: string; fullId: string }> = [];
    for (const [provider, providerConfig] of Object.entries(config)) {
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
    <div className="space-y-6">
      <p className="text-muted text-xs">
        Manage your models. Click the star to set a default model for new workspaces.
      </p>

      {/* Built-in Models */}
      <div className="space-y-2">
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
            onSetDefault={() => setDefaultModel(model.fullId)}
          />
        ))}
      </div>

      {/* Custom Models */}
      <div className="space-y-2">
        <div className="text-muted text-xs font-medium tracking-wide uppercase">Custom Models</div>

        {/* Add new model form */}
        <div className="border-border-medium bg-background-secondary rounded-md border p-3">
          <div className="flex gap-2">
            <select
              value={newModel.provider}
              onChange={(e) => setNewModel((prev) => ({ ...prev, provider: e.target.value }))}
              className="bg-modal-bg border-border-medium focus:border-accent rounded border px-2 py-1.5 text-sm focus:outline-none"
            >
              <option value="">Select provider</option>
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
              placeholder="model-id (e.g., gpt-4-turbo)"
              className="bg-modal-bg border-border-medium focus:border-accent flex-1 rounded border px-2 py-1.5 font-mono text-xs focus:outline-none"
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleAddModel();
              }}
            />
            <button
              type="button"
              onClick={() => void handleAddModel()}
              disabled={saving || !newModel.provider || !newModel.modelId.trim()}
              className="bg-accent hover:bg-accent-dark disabled:bg-border-medium flex items-center gap-1 rounded px-3 py-1.5 text-sm text-white transition-colors disabled:cursor-not-allowed"
            >
              <Plus className="h-4 w-4" />
              Add
            </button>
          </div>
          {error && !editing && <div className="text-error mt-2 text-xs">{error}</div>}
        </div>

        {/* List custom models */}
        {customModels.length > 0 ? (
          customModels.map((model) => {
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
                saving={saving}
                hasActiveEdit={editing !== null}
                onSetDefault={() => setDefaultModel(model.fullId)}
                onStartEdit={() => handleStartEdit(model.provider, model.modelId)}
                onSaveEdit={() => void handleSaveEdit()}
                onCancelEdit={handleCancelEdit}
                onEditChange={(value) =>
                  setEditing((prev) => (prev ? { ...prev, newModelId: value } : null))
                }
                onRemove={() => void handleRemoveModel(model.provider, model.modelId)}
              />
            );
          })
        ) : (
          <div className="text-muted py-4 text-center text-xs">
            No custom models. Add one above to use models not listed in built-in.
          </div>
        )}
      </div>
    </div>
  );
}
