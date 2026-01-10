import React, { useState, useCallback, useRef, useEffect } from "react";
import { Plus, Loader2, Check, ChevronDown } from "lucide-react";
import { SUPPORTED_PROVIDERS, PROVIDER_DISPLAY_NAMES } from "@/common/constants/providers";
import { KNOWN_MODELS } from "@/common/constants/knownModels";
import { LAST_CUSTOM_MODEL_PROVIDER_KEY, PREFERRED_COMPACTION_MODEL_KEY } from "@/common/constants/storage";
import { useModelsFromSettings, getSuggestedModels } from "@/browser/hooks/useModelsFromSettings";
import { useGateway } from "@/browser/hooks/useGatewayModels";
import { usePersistedState } from "@/browser/hooks/usePersistedState";
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
import { Popover, PopoverContent, PopoverTrigger } from "@/browser/components/ui/popover";
import { Button } from "@/browser/components/ui/button";
import { getModelName } from "@/common/utils/ai/models";
import { cn } from "@/common/lib/utils";

/** Searchable model dropdown for settings */
function SearchableModelSelect(props: {
  value: string;
  onChange: (value: string) => void;
  models: string[];
  placeholder?: string;
  emptyOption?: { value: string; label: string };
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus search input when popover opens
  useEffect(() => {
    if (isOpen) {
      const timer = setTimeout(() => inputRef.current?.focus(), 50);
      return () => clearTimeout(timer);
    } else {
      setSearch("");
    }
  }, [isOpen]);

  const searchLower = search.toLowerCase();
  const filteredModels = props.models.filter(
    (m) => m.toLowerCase().includes(searchLower) || getModelName(m).toLowerCase().includes(searchLower)
  );

  const displayValue = props.emptyOption && !props.value
    ? props.emptyOption.label
    : getModelName(props.value) ?? props.placeholder ?? "Select model";

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        <button className="bg-modal-bg border-border-medium focus:border-accent flex h-8 w-full items-center justify-between rounded border px-2 text-xs">
          <span className={cn("truncate", !props.value && props.emptyOption && "text-muted")}>
            {displayValue}
          </span>
          <ChevronDown className="text-muted h-3 w-3 shrink-0" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[320px] p-0">
        {/* Search input */}
        <div className="border-border border-b px-2 py-1.5">
          <input
            ref={inputRef}
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search models..."
            className="text-foreground placeholder:text-muted w-full bg-transparent text-xs outline-none"
          />
        </div>

        <div className="max-h-[280px] overflow-y-auto p-1">
          {/* Empty option if provided */}
          {props.emptyOption && (
            <button
              onClick={() => {
                props.onChange(props.emptyOption!.value);
                setIsOpen(false);
              }}
              className="hover:bg-hover flex w-full items-center gap-1.5 rounded-sm px-2 py-1 text-xs"
            >
              <Check
                className={cn(
                  "h-3 w-3 shrink-0",
                  props.value === props.emptyOption.value ? "opacity-100" : "opacity-0"
                )}
              />
              <span className="text-muted">{props.emptyOption.label}</span>
            </button>
          )}

          {filteredModels.length === 0 ? (
            <div className="text-muted py-2 text-center text-[10px]">No matching models</div>
          ) : (
            filteredModels.map((model) => (
              <button
                key={model}
                onClick={() => {
                  props.onChange(model);
                  setIsOpen(false);
                }}
                className="hover:bg-hover flex w-full items-center gap-1.5 rounded-sm px-2 py-1 text-xs"
              >
                <Check
                  className={cn(
                    "h-3 w-3 shrink-0",
                    model === props.value ? "opacity-100" : "opacity-0"
                  )}
                />
                <span>{getModelName(model)}</span>
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

// Providers to exclude from the custom models UI (handled specially or internal)
const HIDDEN_PROVIDERS = new Set(["mux-gateway"]);

// Shared header cell styles
const headerCellBase = "py-1.5 pr-2 text-xs font-medium text-muted";

// Table header component to avoid duplication
function ModelsTableHeader() {
  return (
    <thead>
      <tr className="border-border-medium bg-background-secondary/50 border-b">
        <th className={`${headerCellBase} pl-2 text-left md:pl-3`}>Provider</th>
        <th className={`${headerCellBase} text-left`}>Model</th>
        <th className={`${headerCellBase} w-16 text-right md:w-20`}>Context</th>
        <th className={`${headerCellBase} w-28 text-right md:w-32 md:pr-3`}>Actions</th>
      </tr>
    </thead>
  );
}

interface EditingState {
  provider: string;
  originalModelId: string;
  newModelId: string;
}

export function ModelsSection() {
  const { api } = useAPI();
  const { config, loading, updateModelsOptimistically } = useProvidersConfig();
  const [lastProvider, setLastProvider] = usePersistedState(LAST_CUSTOM_MODEL_PROVIDER_KEY, "");
  const [newModelId, setNewModelId] = useState("");
  const [editing, setEditing] = useState<EditingState | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selectableProviders = SUPPORTED_PROVIDERS.filter(
    (provider) => !HIDDEN_PROVIDERS.has(provider)
  );
  const { defaultModel, setDefaultModel, hiddenModels, hideModel, unhideModel } =
    useModelsFromSettings();
  const gateway = useGateway();

  // Compaction model preference
  const [compactionModel, setCompactionModel] = usePersistedState<string>(
    PREFERRED_COMPACTION_MODEL_KEY,
    "",
    { listener: true }
  );

  // All models (including hidden) for the settings dropdowns
  const allModels = getSuggestedModels(config);

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
      {/* Model Defaults */}
      <div className="border-border-medium bg-background-secondary rounded-md border p-3">
        <div className="text-foreground mb-3 text-sm font-medium">Model Defaults</div>

        {/* Default Model */}
        <div className="mb-4 space-y-1">
          <div className="text-muted text-xs">Default Model</div>
          <SearchableModelSelect
            value={defaultModel}
            onChange={setDefaultModel}
            models={allModels}
            placeholder="Select model"
          />
          <div className="text-muted-light text-[10px]">Used for new workspaces</div>
        </div>

        {/* Compaction Model */}
        <div className="space-y-1">
          <div className="text-muted text-xs">Compaction Model</div>
          <SearchableModelSelect
            value={compactionModel}
            onChange={setCompactionModel}
            models={allModels}
            emptyOption={{ value: "", label: "Use workspace model" }}
          />
          <div className="text-muted-light text-[10px]">
            Model used for compacting history. Falls back to workspace model if not set.
          </div>
        </div>
      </div>

      {/* Custom Models - shown first */}
      <div className="space-y-3">
        <div className="text-muted text-xs font-medium tracking-wide uppercase">Custom Models</div>

        {/* Add new model form */}
        <div className="border-border-medium bg-background-secondary rounded-md border p-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <Select value={lastProvider} onValueChange={setLastProvider}>
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
              value={newModelId}
              onChange={(e) => setNewModelId(e.target.value)}
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
              disabled={!lastProvider || !newModelId.trim()}
              className="h-7 shrink-0 gap-1 px-2 text-xs"
            >
              <Plus className="h-3.5 w-3.5" />
              Add
            </Button>
          </div>
          {error && !editing && <div className="text-error mt-1.5 text-xs">{error}</div>}
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
                  isGatewayEnabled={gateway.modelUsesGateway(model.fullId)}
                  onSetDefault={() => setDefaultModel(model.fullId)}
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
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
