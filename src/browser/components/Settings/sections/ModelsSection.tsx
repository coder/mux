import React, { useState, useEffect, useCallback } from "react";
import { Plus, Trash2, Pencil, Check, X } from "lucide-react";
import type { ProvidersConfigMap } from "../types";
import { SUPPORTED_PROVIDERS, PROVIDER_DISPLAY_NAMES } from "@/common/constants/providers";

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
  const [config, setConfig] = useState<ProvidersConfigMap>({});
  const [newModel, setNewModel] = useState<NewModelForm>({ provider: "", modelId: "" });
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState<EditingState | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Load config on mount
  useEffect(() => {
    void (async () => {
      const cfg = await window.api.providers.getConfig();
      setConfig(cfg);
    })();
  }, []);

  // Get all custom models across providers
  const getAllModels = (): Array<{ provider: string; modelId: string }> => {
    const models: Array<{ provider: string; modelId: string }> = [];
    for (const [provider, providerConfig] of Object.entries(config)) {
      if (providerConfig.models) {
        for (const modelId of providerConfig.models) {
          models.push({ provider, modelId });
        }
      }
    }
    return models;
  };

  // Check if a model already exists (for duplicate prevention)
  const modelExists = useCallback(
    (provider: string, modelId: string, excludeOriginal?: string): boolean => {
      const currentModels = config[provider]?.models ?? [];
      return currentModels.some((m) => m === modelId && m !== excludeOriginal);
    },
    [config]
  );

  const handleAddModel = useCallback(async () => {
    if (!newModel.provider || !newModel.modelId.trim()) return;

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
    if (!editing) return;

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

  const allModels = getAllModels();

  return (
    <div className="space-y-4">
      <p className="text-muted text-xs">
        Add custom models to use with your providers. These will appear in the model selector.
      </p>

      {/* Add new model form */}
      <div className="border-border-medium bg-background-secondary rounded-md border p-4">
        <div className="mb-3 text-sm font-medium">Add Custom Model</div>
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

      {/* List of custom models */}
      {allModels.length > 0 ? (
        <div className="space-y-2">
          <div className="text-muted text-xs font-medium tracking-wide uppercase">
            Custom Models
          </div>
          {allModels.map(({ provider, modelId }) => {
            const isEditing =
              editing?.provider === provider && editing?.originalModelId === modelId;

            return (
              <div
                key={`${provider}-${modelId}`}
                className="border-border-medium bg-background-secondary flex items-center justify-between rounded-md border px-4 py-2"
              >
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  <span className="text-muted shrink-0 text-xs">
                    {PROVIDER_DISPLAY_NAMES[provider as keyof typeof PROVIDER_DISPLAY_NAMES] ??
                      provider}
                  </span>
                  {isEditing ? (
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                      <input
                        type="text"
                        value={editing.newModelId}
                        onChange={(e) =>
                          setEditing((prev) =>
                            prev ? { ...prev, newModelId: e.target.value } : null
                          )
                        }
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void handleSaveEdit();
                          if (e.key === "Escape") handleCancelEdit();
                        }}
                        className="bg-modal-bg border-border-medium focus:border-accent min-w-0 flex-1 rounded border px-2 py-1 font-mono text-xs focus:outline-none"
                        autoFocus
                      />
                      {error && <div className="text-error text-xs">{error}</div>}
                    </div>
                  ) : (
                    <span className="text-foreground min-w-0 truncate font-mono text-sm">
                      {modelId}
                    </span>
                  )}
                </div>
                <div className="ml-2 flex shrink-0 items-center gap-1">
                  {isEditing ? (
                    <>
                      <button
                        type="button"
                        onClick={() => void handleSaveEdit()}
                        disabled={saving}
                        className="text-accent hover:text-accent-dark p-1 transition-colors"
                        title="Save changes (Enter)"
                      >
                        <Check className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        onClick={handleCancelEdit}
                        disabled={saving}
                        className="text-muted hover:text-foreground p-1 transition-colors"
                        title="Cancel (Escape)"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={() => handleStartEdit(provider, modelId)}
                        disabled={saving || editing !== null}
                        className="text-muted hover:text-foreground p-1 transition-colors disabled:opacity-50"
                        title="Edit model"
                      >
                        <Pencil className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleRemoveModel(provider, modelId)}
                        disabled={saving || editing !== null}
                        className="text-muted hover:text-error p-1 transition-colors disabled:opacity-50"
                        title="Remove model"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="text-muted py-8 text-center text-sm">
          No custom models configured. Add one above to get started.
        </div>
      )}
    </div>
  );
}
