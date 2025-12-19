import React, {
  useState,
  useRef,
  useEffect,
  useCallback,
  useImperativeHandle,
  forwardRef,
} from "react";
import { cn } from "@/common/lib/utils";
import { Eye, Settings, Star } from "lucide-react";
import { GatewayIcon } from "./icons/GatewayIcon";
import { ProviderIcon } from "./ProviderIcon";
import { Tooltip, TooltipTrigger, TooltipContent } from "./ui/tooltip";
import { useSettings } from "@/browser/contexts/SettingsContext";
import { useGateway } from "@/browser/hooks/useGatewayModels";
import { formatModelDisplayName } from "@/common/utils/ai/modelDisplay";

interface ModelSelectorProps {
  value: string;
  onChange: (value: string) => void;
  models: string[];
  hiddenModels?: string[];
  emptyLabel?: string;
  inputPlaceholder?: string;
  onComplete?: () => void;
  defaultModel?: string | null;
  onSetDefaultModel?: (model: string) => void;
  onHideModel?: (model: string) => void;
  onUnhideModel?: (model: string) => void;
  onOpenSettings?: () => void;
}

export interface ModelSelectorRef {
  open: () => void;
}

export const ModelSelector = forwardRef<ModelSelectorRef, ModelSelectorProps>(
  (
    {
      value,
      onChange,
      models,
      hiddenModels = [],
      emptyLabel,
      inputPlaceholder,
      onComplete,
      defaultModel,
      onSetDefaultModel,
      onHideModel,
      onUnhideModel,
      onOpenSettings,
    },
    ref
  ) => {
    useSettings(); // Context must be available for nested components
    const gateway = useGateway();
    const [isEditing, setIsEditing] = useState(false);
    const [inputValue, setInputValue] = useState(value);
    const [error, setError] = useState<string | null>(null);
    const [showDropdown, setShowDropdown] = useState(false);
    const [showAllModels, setShowAllModels] = useState(false);
    const [highlightedIndex, setHighlightedIndex] = useState<number>(-1);
    const inputRef = useRef<HTMLInputElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const dropdownItemRefs = useRef<Array<HTMLDivElement | null>>([]);

    // Update input value when prop changes
    useEffect(() => {
      if (!isEditing) {
        setInputValue(value);
      }
    }, [value, isEditing]);

    // Focus input when editing starts
    useEffect(() => {
      if (isEditing && inputRef.current) {
        inputRef.current.focus();
        inputRef.current.select();
      }
    }, [isEditing]);

    const handleCancel = useCallback(() => {
      setIsEditing(false);
      setInputValue(value);
      setError(null);
      setShowDropdown(false);
      setShowAllModels(false);
      setHighlightedIndex(-1);
    }, [value]);

    // Handle click outside to close
    useEffect(() => {
      if (!isEditing) return;

      const handleClickOutside = (e: MouseEvent) => {
        if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
          handleCancel();
        }
      };

      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }, [isEditing, handleCancel]);

    // Build model list: visible models + (if showAllModels) hidden models
    const baseModels = showAllModels ? [...models, ...hiddenModels] : models;

    // Filter models based on input (show all if empty). Preserve order from Settings.
    const filteredModels =
      inputValue.trim() === ""
        ? baseModels
        : baseModels.filter((model) => model.toLowerCase().includes(inputValue.toLowerCase()));

    // Track which models are hidden (for rendering)
    const hiddenSet = new Set(hiddenModels);

    // If the list shrinks (e.g., a model is hidden), keep the highlight in-bounds.
    useEffect(() => {
      if (filteredModels.length === 0) {
        setHighlightedIndex(-1);
        return;
      }
      if (highlightedIndex >= filteredModels.length) {
        setHighlightedIndex(filteredModels.length - 1);
      }
    }, [filteredModels.length, highlightedIndex]);

    const handleSave = () => {
      // No matches - do nothing, let user keep typing or cancel
      if (filteredModels.length === 0) {
        return;
      }

      // Use highlighted item, or first item if none highlighted
      const selectedIndex = highlightedIndex >= 0 ? highlightedIndex : 0;
      const valueToSave = filteredModels[selectedIndex];

      onChange(valueToSave);
      setIsEditing(false);
      setError(null);
      setShowDropdown(false);
      setHighlightedIndex(-1);
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        handleCancel();
      } else if (e.key === "Enter") {
        e.preventDefault();
        // Only call onComplete if save succeeded (had matches)
        if (filteredModels.length > 0) {
          handleSave();
          onComplete?.();
        }
      } else if (e.key === "Tab") {
        e.preventDefault();
        // Tab auto-completes the highlighted item without closing
        if (highlightedIndex >= 0 && highlightedIndex < filteredModels.length) {
          setInputValue(filteredModels[highlightedIndex]);
          setHighlightedIndex(-1);
        }
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlightedIndex((prev) => Math.min(prev + 1, filteredModels.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlightedIndex((prev) => Math.max(prev - 1, -1));
      }
    };

    const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      const newValue = e.target.value;
      setInputValue(newValue);
      setError(null);

      // Auto-highlight first filtered result
      const filtered =
        newValue.trim() === ""
          ? models
          : models.filter((model) => model.toLowerCase().includes(newValue.toLowerCase()));

      // Highlight first result if any, otherwise no highlight
      setHighlightedIndex(filtered.length > 0 ? 0 : -1);

      // Keep dropdown visible if there are models (filtering happens automatically)
      setShowDropdown(models.length > 0);
    };

    const handleSelectModel = (model: string) => {
      setInputValue(model);
      onChange(model);
      setIsEditing(false);
      setError(null);
      setShowDropdown(false);
    };

    const handleClick = useCallback(() => {
      setIsEditing(true);
      setInputValue(""); // Clear input to show all models
      setShowDropdown(models.length > 0);

      // Start with current value highlighted
      const currentIndex = models.indexOf(value);
      setHighlightedIndex(currentIndex);
    }, [models, value]);

    const handleSetDefault = (e: React.MouseEvent, model: string) => {
      e.preventDefault();
      e.stopPropagation();
      if (defaultModel !== model && onSetDefaultModel) {
        onSetDefaultModel(model);
      }
    };

    // Expose open method to parent via ref
    useImperativeHandle(
      ref,
      () => ({
        open: handleClick,
      }),
      [handleClick]
    );

    // Scroll highlighted item into view
    useEffect(() => {
      if (highlightedIndex >= 0 && dropdownItemRefs.current[highlightedIndex]) {
        dropdownItemRefs.current[highlightedIndex]?.scrollIntoView({
          block: "nearest",
          behavior: "smooth",
        });
      }
    }, [highlightedIndex]);

    if (!isEditing) {
      if (value.trim().length === 0) {
        return (
          <div ref={containerRef} className="relative flex items-center gap-1">
            <div
              className="text-muted-light hover:bg-hover flex cursor-pointer items-center gap-1 rounded-sm px-1 py-0.5 text-[11px] transition-colors duration-200"
              onClick={handleClick}
            >
              <span>{emptyLabel ?? ""}</span>
            </div>
          </div>
        );
      }

      const gatewayActive = gateway.isModelRoutingThroughGateway(value);

      // Parse provider and model name from value (format: "provider:model-name")
      const [provider, modelName] = value.includes(":") ? value.split(":", 2) : ["", value];
      // For mux-gateway format, extract inner provider
      const innerProvider =
        provider === "mux-gateway" && modelName.includes("/") ? modelName.split("/")[0] : provider;

      return (
        <div ref={containerRef} className="relative flex items-center gap-1">
          {gatewayActive && (
            <Tooltip>
              <TooltipTrigger asChild>
                <GatewayIcon
                  className="text-accent h-3 w-3 shrink-0"
                  active
                  role="img"
                  aria-label="Using Mux Gateway"
                />
              </TooltipTrigger>
              <TooltipContent align="center">Using Mux Gateway</TooltipContent>
            </Tooltip>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <div
                className="text-muted-light hover:bg-hover flex cursor-pointer items-center gap-1 rounded-sm px-1 py-0.5 text-[11px] transition-colors duration-200"
                onClick={handleClick}
              >
                <ProviderIcon provider={innerProvider} className="h-3 w-3 shrink-0 opacity-70" />
                <span>{formatModelDisplayName(modelName)}</span>
              </div>
            </TooltipTrigger>
            <TooltipContent align="center">{value}</TooltipContent>
          </Tooltip>
        </div>
      );
    }

    return (
      <div ref={containerRef} className="relative flex items-center gap-1">
        <div>
          <input
            ref={inputRef}
            value={inputValue}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            placeholder={inputPlaceholder ?? "provider:model-name"}
            className="text-light bg-dark border-border-light font-monospace focus:border-exec-mode w-48 rounded-sm border px-1 py-0.5 text-[10px] leading-[11px] outline-none"
          />
          {error && (
            <div className="text-danger-soft font-monospace mt-0.5 text-[9px]">{error}</div>
          )}
        </div>
        {showDropdown && (
          <div className="bg-separator border-border-light absolute bottom-full left-0 z-[1020] mb-1 max-h-[200px] min-w-80 overflow-y-auto rounded border shadow-[0_4px_12px_rgba(0,0,0,0.3)]">
            {filteredModels.length === 0 ? (
              <div className="text-muted-light font-monospace px-2.5 py-1.5 text-[11px]">
                No matching models
              </div>
            ) : (
              filteredModels.map((model, index) => (
                <div
                  key={model}
                  ref={(el) => (dropdownItemRefs.current[index] = el)}
                  className={cn(
                    "text-[11px] font-monospace py-1.5 px-2.5 cursor-pointer transition-colors duration-100",
                    "first:rounded-t last:rounded-b",
                    hiddenSet.has(model) && "opacity-50",
                    index === highlightedIndex
                      ? "text-foreground bg-hover"
                      : "text-light bg-transparent hover:bg-hover hover:text-foreground"
                  )}
                  onClick={() => handleSelectModel(model)}
                >
                  {/* Grid: model name | gateway | visibility | default */}
                  <div className="grid w-full grid-cols-[1fr_20px_20px_20px] items-center gap-1">
                    <span className="min-w-0 truncate">{model}</span>
                    {/* Gateway toggle */}
                    {gateway.canToggleModel(model) ? (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              gateway.toggleModelGateway(model);
                            }}
                            className={cn(
                              "flex h-5 w-5 items-center justify-center rounded-sm border transition-colors duration-150",
                              gateway.modelUsesGateway(model)
                                ? "text-accent border-accent/40"
                                : "text-muted-light border-border-light/40 hover:border-foreground/60 hover:text-foreground"
                            )}
                            aria-label={
                              gateway.modelUsesGateway(model)
                                ? "Disable Mux Gateway"
                                : "Enable Mux Gateway"
                            }
                          >
                            <GatewayIcon
                              className="h-3 w-3"
                              active={gateway.modelUsesGateway(model)}
                            />
                          </button>
                        </TooltipTrigger>
                        <TooltipContent align="center">
                          {gateway.modelUsesGateway(model)
                            ? "Using Mux Gateway"
                            : "Use Mux Gateway"}
                        </TooltipContent>
                      </Tooltip>
                    ) : (
                      <span /> // Empty cell for alignment
                    )}
                    {/* Visibility toggle - Eye with line-through when hidden */}
                    {(onHideModel ?? onUnhideModel) ? (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              if (hiddenSet.has(model)) {
                                onUnhideModel?.(model);
                              } else {
                                onHideModel?.(model);
                              }
                            }}
                            className={cn(
                              "relative flex h-5 w-5 items-center justify-center rounded-sm border transition-colors duration-150",
                              hiddenSet.has(model)
                                ? "text-muted-light border-muted-light/40"
                                : "text-muted-light border-border-light/40 hover:border-foreground/60 hover:text-foreground"
                            )}
                            aria-label={
                              hiddenSet.has(model)
                                ? "Show model in selector"
                                : "Hide model from selector"
                            }
                          >
                            <Eye
                              className={cn(
                                "h-3 w-3",
                                hiddenSet.has(model) ? "opacity-30" : "opacity-70"
                              )}
                            />
                            {hiddenSet.has(model) && (
                              <span className="bg-muted-light absolute h-px w-3 rotate-45" />
                            )}
                          </button>
                        </TooltipTrigger>
                        <TooltipContent align="center">
                          {hiddenSet.has(model)
                            ? "Show model in selector"
                            : "Hide model from selector"}
                        </TooltipContent>
                      </Tooltip>
                    ) : (
                      <span /> // Empty cell for alignment
                    )}
                    {/* Default star */}
                    {onSetDefaultModel ? (
                      hiddenSet.has(model) ? (
                        <span /> // Empty cell - can't set hidden model as default
                      ) : (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              type="button"
                              onMouseDown={(e) => e.preventDefault()}
                              onClick={(e) => handleSetDefault(e, model)}
                              className={cn(
                                "flex h-5 w-5 items-center justify-center rounded-sm border transition-colors duration-150",
                                defaultModel === model
                                  ? "text-yellow-400 border-yellow-400/40 cursor-default"
                                  : "text-muted-light border-border-light/40 hover:border-foreground/60 hover:text-foreground"
                              )}
                              aria-label={
                                defaultModel === model
                                  ? "Current default model"
                                  : "Set as default model"
                              }
                              disabled={defaultModel === model}
                            >
                              <Star className="h-3 w-3" />
                            </button>
                          </TooltipTrigger>
                          <TooltipContent align="center">
                            {defaultModel === model
                              ? "Current default model"
                              : "Set as default model"}
                          </TooltipContent>
                        </Tooltip>
                      )
                    ) : (
                      <span /> // Empty cell for alignment
                    )}
                  </div>
                </div>
              ))
            )}

            {/* Footer actions */}
            {(hiddenModels.length > 0 || onOpenSettings) && (
              <div className="border-border-light flex items-center justify-between gap-2 border-t px-2.5 py-1.5">
                {hiddenModels.length > 0 && (
                  <button
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setShowAllModels((prev) => !prev);
                    }}
                    className="text-muted-light hover:text-foreground text-[10px] transition-colors"
                  >
                    {showAllModels ? "Show fewer models" : "Show all models…"}
                  </button>
                )}
                {onOpenSettings && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          onOpenSettings();
                        }}
                        className="text-muted-light hover:text-foreground ml-auto flex items-center text-[10px] transition-colors"
                        aria-label="Model Settings"
                      >
                        <Settings className="h-3 w-3" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent align="center">Model Settings</TooltipContent>
                  </Tooltip>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    );
  }
);

ModelSelector.displayName = "ModelSelector";
