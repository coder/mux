import React, { useState, useEffect, useCallback } from "react";
import { Plus, Trash2, Pencil, Check, X, Loader2, Star } from "lucide-react";
import type { ProvidersConfigMap } from "../types";
import { SUPPORTED_PROVIDERS, PROVIDER_DISPLAY_NAMES } from "@/common/constants/providers";
import { KNOWN_MODELS } from "@/common/constants/knownModels";
import { cn } from "@/common/lib/utils";
import { useModelLRU } from "@/browser/hooks/useModelLRU";
import { TooltipWrapper, Tooltip } from "@/browser/components/Tooltip";

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

  // Model row component for consistent styling
  const ModelRow = ({
    provider,
    modelId,
    fullId,
    aliases,
    isCustom,
  }: {
    provider: string;
    modelId: string;
    fullId: string;
    aliases?: string[];
    isCustom: boolean;
  }) => {
    const isEditing =
      editing?.provider === provider && editing?.originalModelId === modelId && isCustom;
    const isDefault = defaultModel === fullId;

    return (
      <div
        key={fullId}
        className="border-border-medium bg-background-secondary flex items-center justify-between rounded-md border px-4 py-2"
      >
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <span className="text-muted w-20 shrink-0 text-xs">
            {PROVIDER_DISPLAY_NAMES[provider as keyof typeof PROVIDER_DISPLAY_NAMES] ?? provider}
          </span>
          {isEditing ? (
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <input
                type="text"
                value={editing.newModelId}
                onChange={(e) =>
                  setEditing((prev) => (prev ? { ...prev, newModelId: e.target.value } : null))
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
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-foreground min-w-0 truncate font-mono text-sm">{modelId}</span>
              {aliases && aliases.length > 0 && (
                <span className="text-muted-light text-xs">
                  aliases: {aliases.map((a) => `/${a}`).join(", ")}
                </span>
              )}
            </div>
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
              {/* Favorite/default button */}
              <TooltipWrapper inline>
                <button
                  type="button"
                  onClick={() => {
                    if (!isDefault) setDefaultModel(fullId);
                  }}
                  className={cn(
                    "p-1 transition-colors",
                    isDefault
                      ? "cursor-default text-yellow-400"
                      : "text-muted hover:text-yellow-400"
                  )}
                  disabled={isDefault}
                  aria-label={isDefault ? "Current default model" : "Set as default model"}
                >
                  <Star className={cn("h-4 w-4", isDefault && "fill-current")} />
                </button>
                <Tooltip className="tooltip" align="center">
                  {isDefault ? "Default model" : "Set as default"}
                </Tooltip>
              </TooltipWrapper>
              {/* Edit/delete buttons only for custom models */}
              {isCustom && (
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
            </>
          )}
        </div>
      </div>
    );
  };

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
          customModels.map((model) => (
            <ModelRow
              key={model.fullId}
              provider={model.provider}
              modelId={model.modelId}
              fullId={model.fullId}
              isCustom={true}
            />
          ))
        ) : (
          <div className="text-muted py-4 text-center text-xs">
            No custom models. Add one above to use models not listed in built-in.
          </div>
        )}
      </div>
    </div>
  );
}
