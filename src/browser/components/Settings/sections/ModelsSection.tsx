import React, { useState, useEffect, useCallback } from "react";
import { Plus, Trash2 } from "lucide-react";
import type { ProvidersConfigMap } from "../types";
import { SUPPORTED_PROVIDERS, PROVIDER_DISPLAY_NAMES } from "@/common/constants/providers";

interface NewModelForm {
  provider: string;
  modelId: string;
}

export function ModelsSection() {
  const [config, setConfig] = useState<ProvidersConfigMap>({});
  const [newModel, setNewModel] = useState<NewModelForm>({ provider: "", modelId: "" });
  const [saving, setSaving] = useState(false);

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

  const handleAddModel = useCallback(async () => {
    if (!newModel.provider || !newModel.modelId.trim()) return;

    setSaving(true);
    try {
      const currentModels = config[newModel.provider]?.models ?? [];
      const updatedModels = [...currentModels, newModel.modelId.trim()];

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
  }, [newModel, config]);

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
      </div>

      {/* List of custom models */}
      {allModels.length > 0 ? (
        <div className="space-y-2">
          <div className="text-muted text-xs font-medium tracking-wide uppercase">
            Custom Models
          </div>
          {allModels.map(({ provider, modelId }) => (
            <div
              key={`${provider}-${modelId}`}
              className="border-border-medium bg-background-secondary flex items-center justify-between rounded-md border px-4 py-2"
            >
              <div className="flex items-center gap-3">
                <span className="text-muted text-xs">
                  {PROVIDER_DISPLAY_NAMES[provider as keyof typeof PROVIDER_DISPLAY_NAMES] ??
                    provider}
                </span>
                <span className="text-foreground font-mono text-sm">{modelId}</span>
              </div>
              <button
                type="button"
                onClick={() => void handleRemoveModel(provider, modelId)}
                disabled={saving}
                className="text-muted hover:text-error p-1 transition-colors"
                title="Remove model"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}
        </div>
      ) : (
        <div className="text-muted py-8 text-center text-sm">
          No custom models configured. Add one above to get started.
        </div>
      )}
    </div>
  );
}
