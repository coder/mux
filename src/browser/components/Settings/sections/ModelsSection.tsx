import React, { useState, useCallback, useRef, useEffect } from "react";
import { Plus, Loader2, Check, ChevronDown } from "lucide-react";
import { SUPPORTED_PROVIDERS, PROVIDER_DISPLAY_NAMES } from "@/common/constants/providers";
import { KNOWN_MODELS } from "@/common/constants/knownModels";
import {
  LAST_CUSTOM_MODEL_PROVIDER_KEY,
  PREFERRED_COMPACTION_MODEL_KEY,
} from "@/common/constants/storage";
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
import { getModelName, getModelProvider } from "@/common/utils/ai/models";
import { ProviderIcon } from "@/browser/components/ProviderIcon";
import { cn } from "@/common/lib/utils";

/** Searchable model dropdown with keyboard navigation */
function SearchableModelSelect(props: {
  value: string;
  onChange: (value: string) => void;
  models: string[];
  placeholder?: string;
  emptyOption?: { value: string; label: string };
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const displayValue =
    props.emptyOption && !props.value
      ? props.emptyOption.label
      : (getModelName(props.value) ?? props.placeholder ?? "Select model");
  const selectedProvider = props.value ? getModelProvider(props.value) : "";

  // Filter models based on search
  const searchLower = search.toLowerCase();
  const filteredModels = props.models.filter(
    (m) =>
      m.toLowerCase().includes(searchLower) ||
      (getModelName(m)?.toLowerCase().includes(searchLower) ?? false)
  );

  // Build list of all selectable items (empty option + filtered models)
  const items: Array<{ value: string; label: string; provider?: string; isMuted?: boolean }> = [];
  if (props.emptyOption) {
    items.push({
      value: props.emptyOption.value,
      label: props.emptyOption.label,
      isMuted: true,
    });
  }
  for (const model of filteredModels) {
    items.push({
      value: model,
      label: getModelName(model) ?? model,
      provider: getModelProvider(model),
    });
  }

  // Reset highlight when search changes or popover opens
  useEffect(() => {
    setHighlightedIndex(0);
  }, [search]);

  useEffect(() => {
    if (isOpen) {
      setSearch("");
      setHighlightedIndex(0);
      // Focus input after popover renders
      const timer = setTimeout(() => inputRef.current?.focus(), 10);
      return () => clearTimeout(timer);
    }
  }, [isOpen]);

  // Scroll highlighted item into view
  useEffect(() => {
    if (!listRef.current) return;
    const highlighted = listRef.current.querySelector("[data-highlighted=true]");
    if (highlighted) {
      highlighted.scrollIntoView({ block: "nearest" });
    }
  }, [highlightedIndex]);

  const handleSelect = (value: string) => {
    props.onChange(value);
    setIsOpen(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setHighlightedIndex((i) => Math.min(i + 1, items.length - 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setHighlightedIndex((i) => Math.max(i - 1, 0));
        break;
      case "Enter":
        e.preventDefault();
        if (items[highlightedIndex]) {
          handleSelect(items[highlightedIndex].value);
        }
        break;
      case "Escape":
        e.preventDefault();
        setIsOpen(false);
        break;
    }
  };

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen} modal>
      <PopoverTrigger asChild>
        <button className="bg-background-secondary border-border-medium focus:border-accent flex h-8 w-full items-center justify-between rounded border px-2 text-xs">
          <span
            className={cn(
              "flex items-center gap-1.5 truncate",
              !props.value && props.emptyOption && "text-muted"
            )}
          >
            {selectedProvider && (
              <ProviderIcon provider={selectedProvider} className="text-muted shrink-0" />
            )}
            {displayValue}
          </span>
          <ChevronDown className="text-muted h-3 w-3 shrink-0" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="max-h-[350px] w-[320px] p-0">
        {/* Search input */}
        <div className="border-border border-b px-2 py-1.5">
          <input
            ref={inputRef}
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search models..."
            className="text-foreground placeholder:text-muted w-full bg-transparent text-xs outline-none"
          />
        </div>

        {/* Scrollable list */}
        <div ref={listRef} className="max-h-[280px] overflow-y-auto p-1">
          {items.length === 0 ? (
            <div className="text-muted py-2 text-center text-[10px]">No matching models</div>
          ) : (
            items.map((item, index) => (
              <button
                key={item.value || "__empty__"}
                data-highlighted={index === highlightedIndex}
                onClick={() => handleSelect(item.value)}
                onMouseEnter={() => setHighlightedIndex(index)}
                className={cn(
                  "flex w-full items-center gap-1.5 rounded-sm px-2 py-1 text-xs",
                  index === highlightedIndex ? "bg-hover" : "hover:bg-hover"
                )}
              >
                <Check
                  className={cn(
                    "h-3 w-3 shrink-0",
                    props.value === item.value || (!props.value && !item.value)
                      ? "opacity-100"
                      : "opacity-0"
                  )}
                />
                {item.provider && (
                  <ProviderIcon provider={item.provider} className="text-muted shrink-0" />
                )}
                <span className={cn("truncate", item.isMuted && "text-muted")}>{item.label}</span>
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
      {/* Model Defaults - styled to match table aesthetic */}
      <div className="border-border-medium overflow-hidden rounded-md border">
        {/* Header row - matches table header */}
        <div className="border-border-medium bg-background-secondary/50 border-b px-2 py-1.5 md:px-3">
          <span className="text-muted text-xs font-medium">Model Defaults</span>
        </div>
        {/* Content rows - match table row styling */}
        <div className="divide-border-medium divide-y">
          {/* Default Model row */}
          <div className="flex items-center gap-4 px-2 py-2 md:px-3">
            <div className="w-28 shrink-0 md:w-32">
              <div className="text-muted text-xs">Default Model</div>
              <div className="text-muted-light text-[10px]">New workspaces</div>
            </div>
            <div className="min-w-0 flex-1">
              <SearchableModelSelect
                value={defaultModel}
                onChange={setDefaultModel}
                models={allModels}
                placeholder="Select model"
              />
            </div>
          </div>
          {/* Compaction Model row */}
          <div className="flex items-center gap-4 px-2 py-2 md:px-3">
            <div className="w-28 shrink-0 md:w-32">
              <div className="text-muted text-xs">Compaction Model</div>
              <div className="text-muted-light text-[10px]">History summary</div>
            </div>
            <div className="min-w-0 flex-1">
              <SearchableModelSelect
                value={compactionModel}
                onChange={setCompactionModel}
                models={allModels}
                emptyOption={{ value: "", label: "Use workspace model" }}
              />
            </div>
          </div>
        </div>
      </div>

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
