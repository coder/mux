/**
 * ModelSelector - Dropdown for selecting AI models
 *
 * Uses conditional rendering (not Radix Portal) to enable testing in happy-dom.
 * Pattern follows BaseSelectorPopover.
 */
import React, {
  useState,
  useRef,
  useEffect,
  useCallback,
  useImperativeHandle,
  forwardRef,
} from "react";
import { cn } from "@/common/lib/utils";
import { Check, ChevronDown, Eye, Settings, ShieldCheck, Star } from "lucide-react";
import { GatewayToggleButton } from "./GatewayToggleButton";

import { ProviderIcon } from "./ProviderIcon";
import { Tooltip, TooltipTrigger, TooltipContent } from "./ui/tooltip";
import { useSettings } from "@/browser/contexts/SettingsContext";
import { usePolicy } from "@/browser/contexts/PolicyContext";
import { useGateway } from "@/browser/hooks/useGatewayModels";

import { stopKeyboardPropagation } from "@/browser/utils/events";
import { formatModelDisplayName } from "@/common/utils/ai/modelDisplay";
import { getModelName, getModelProvider } from "@/common/utils/ai/models";
import { Button } from "./ui/button";
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
  variant?: "default" | "box";
  className?: string;
  tooltipExtraContent?: React.ReactNode;
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
      variant = "default",
      className,
      tooltipExtraContent,
    },
    ref
  ) => {
    useSettings(); // Context must be available for nested components
    const policyState = usePolicy();
    const policyEnforced = policyState.status.state === "enforced";
    const gateway = useGateway();
    const [isOpen, setIsOpen] = useState(false);
    const [inputValue, setInputValue] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [showAllModels, setShowAllModels] = useState(false);
    const [highlightedIndex, setHighlightedIndex] = useState<number>(0);
    const inputRef = useRef<HTMLInputElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const listRef = useRef<HTMLDivElement>(null);

    const handleCancel = useCallback(() => {
      setIsOpen(false);
      setInputValue("");
      setError(null);
      setShowAllModels(false);
      setHighlightedIndex(0);
    }, []);

    // Close dropdown on outside click
    useEffect(() => {
      if (!isOpen) return;

      const handleClickOutside = (e: MouseEvent) => {
        if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
          handleCancel();
        }
      };

      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }, [isOpen, handleCancel]);

    // Initialize search + focus whenever the dropdown opens.
    useEffect(() => {
      if (!isOpen) {
        return;
      }

      setError(null);
      setInputValue(""); // Clear input to show all models
      setShowAllModels(false);

      // Start with current value highlighted
      const currentIndex = models.indexOf(value);
      setHighlightedIndex(currentIndex >= 0 ? currentIndex : 0);

      // Focus input after dropdown renders.
      const timer = setTimeout(() => inputRef.current?.focus(), 0);
      return () => clearTimeout(timer);
    }, [isOpen, models, value]);

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
        setHighlightedIndex(0);
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
      const selectedIndex = highlightedIndex;
      const valueToSave = filteredModels[selectedIndex];

      onChange(valueToSave);
      handleCancel();
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        stopKeyboardPropagation(e);
        handleCancel();
        return;
      }

      if (e.key === "Enter") {
        e.preventDefault();
        // Only call onComplete if save succeeded (had matches)
        if (filteredModels.length > 0) {
          handleSave();
          onComplete?.();
        }
        return;
      }

      if (e.key === "Tab") {
        e.preventDefault();
        // Tab auto-completes the highlighted item without closing
        if (filteredModels[highlightedIndex]) {
          setInputValue(filteredModels[highlightedIndex]);
        }
        setHighlightedIndex(0);
        return;
      }

      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlightedIndex((prev) => Math.min(prev + 1, filteredModels.length - 1));
        return;
      }

      if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlightedIndex((prev) => Math.max(prev - 1, 0));
        return;
      }
    };

    const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      const newValue = e.target.value;
      setInputValue(newValue);
      setError(null);

      // Auto-highlight first filtered result
      setHighlightedIndex(0);
    };

    const handleSelectModel = (model: string) => {
      onChange(model);
      handleCancel();
    };

    const handleOpen = useCallback(() => {
      setIsOpen(true);
    }, []);

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
        open: handleOpen,
      }),
      [handleOpen]
    );

    // Scroll highlighted item into view
    useEffect(() => {
      if (!listRef.current) {
        return;
      }

      const highlighted = listRef.current.querySelector("[data-highlighted=true]");
      if (highlighted) {
        highlighted.scrollIntoView({ block: "nearest" });
      }
    }, [highlightedIndex]);

    const isBoxVariant = variant === "box";
    const containerClassName = cn("relative flex items-center gap-1", isBoxVariant && "w-full");
    const triggerClassName = isBoxVariant
      ? cn("border-border-medium h-9 flex-1 min-w-0 rounded border", className)
      : cn("bg-background rounded-sm text-[11px]", className ?? "w-32");

    const hasValue = value.trim().length > 0;
    const selectedProvider = hasValue ? getModelProvider(value) : "";
    const displayValue = hasValue
      ? formatModelDisplayName(getModelName(value))
      : (emptyLabel ?? "");

    return (
      <div ref={containerRef} className={containerClassName}>
        {/* Trigger button */}
        <Tooltip {...(isOpen || !hasValue ? { open: false } : {})}>
          <TooltipTrigger asChild>
            <Button
              type="button"
              className={cn(
                triggerClassName,
                "text-foreground hover:bg-hover flex cursor-pointer items-center justify-between gap-1 px-1.5 py-0.5 transition-colors duration-300"
              )}
              role="combobox"
              aria-expanded={isOpen}
              variant="ghost"
              size="xs"
              onClick={() => setIsOpen((prev) => !prev)}
            >
              <span className="flex min-w-0 items-center gap-1.5">
                {selectedProvider && (
                  <ProviderIcon
                    provider={selectedProvider}
                    className="h-3 w-3 shrink-0 opacity-70"
                  />
                )}
                <span className="min-w-0 truncate">{displayValue}</span>
              </span>
              <ChevronDown className="text-muted h-3 w-3 shrink-0" />
            </Button>
          </TooltipTrigger>
          <TooltipContent
            align={tooltipExtraContent ? "start" : "center"}
            className={cn(tooltipExtraContent && "max-w-80 whitespace-normal")}
          >
            {value}
            {tooltipExtraContent ? (
              <>
                <br />
                <br />
                {tooltipExtraContent}
              </>
            ) : null}
          </TooltipContent>
        </Tooltip>

        {/* Dropdown content - rendered inline for testability */}
        {isOpen && (
          <div className="bg-dark border-border absolute bottom-full left-0 z-[1020] mb-1 w-82 overflow-hidden rounded-md border shadow-md">
            {/* Search input */}
            <div className="border-border border-b px-2 py-1">
              <input
                ref={inputRef}
                type="text"
                value={inputValue}
                onChange={handleInputChange}
                onKeyDown={handleKeyDown}
                placeholder={inputPlaceholder ?? "Search [provider:model-name]"}
                className="text-foreground placeholder:text-muted w-full bg-transparent text-xs outline-none"
              />
              {error && <div className="text-danger-soft mt-1 text-[10px]">{error}</div>}
            </div>

            {/* Scrollable list */}
            <div ref={listRef} className="max-h-[280px] overflow-y-auto p-1">
              {filteredModels.length === 0 ? (
                <div className="text-muted py-2 text-center text-[10px]">No matching models</div>
              ) : (
                filteredModels.map((model, index) => (
                  <div
                    key={model}
                    data-highlighted={index === highlightedIndex}
                    onMouseEnter={() => setHighlightedIndex(index)}
                    className={cn(
                      "flex w-full items-center gap-1.5 rounded-sm px-2 py-0.5 text-xs cursor-pointer",
                      index === highlightedIndex ? "bg-hover" : "hover:bg-hover",
                      hiddenSet.has(model) && "opacity-50"
                    )}
                    onClick={() => handleSelectModel(model)}
                    role="option"
                    aria-selected={value === model}
                  >
                    <Check
                      className={cn(
                        "h-3 w-3 shrink-0",
                        value === model ? "opacity-100" : "opacity-0"
                      )}
                    />
                    <ProviderIcon
                      provider={getModelProvider(model)}
                      className="text-muted h-3 w-3 shrink-0"
                    />
                    <span className="min-w-0 flex-1 truncate">{model}</span>

                    {/* Gateway toggle */}
                    {gateway.canToggleModel(model) ? (
                      <GatewayToggleButton
                        active={gateway.modelUsesGateway(model)}
                        onToggle={() => gateway.toggleModelGateway(model)}
                        variant="bordered"
                        size="sm"
                        showTooltip
                      />
                    ) : (
                      <span className="h-5 w-5" />
                    )}
                    {/* Visibility toggle - Eye with line-through when hidden */}
                    {(onHideModel ?? onUnhideModel) && (
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
                                "h-4 w-4 md:h-3 md:w-3",
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
                    )}

                    {/* Default star */}
                    {onSetDefaultModel ? (
                      hiddenSet.has(model) ? (
                        <span className="h-5 w-5" />
                      ) : (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              type="button"
                              onMouseDown={(e) => e.preventDefault()}
                              onClick={(e) => handleSetDefault(e, model)}
                              className={cn(
                                "flex h-5 w-5 items-center justify-center rounded-sm transition-colors duration-150 cursor-pointer",
                                defaultModel === model
                                  ? "text-yellow-400 cursor-default"
                                  : "text-muted-light hover:text-foreground"
                              )}
                              aria-label={
                                defaultModel === model
                                  ? "Current default model"
                                  : "Set as default model"
                              }
                              disabled={defaultModel === model}
                            >
                              <Star
                                className="h-4 w-4 md:h-3 md:w-3"
                                fill={defaultModel === model ? "currentColor" : "none"}
                              />
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
                      <span className="h-5 w-5" />
                    )}
                  </div>
                ))
              )}
            </div>

            {/* Footer actions (last row in dropdown) */}
            {(hiddenModels.length > 0 || onOpenSettings) && (
              <div className="border-border flex flex-col gap-1 border-t px-2 py-1">
                {hiddenModels.length > 0 && (
                  <button
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setShowAllModels((prev) => !prev);
                      setInputValue("");
                      setHighlightedIndex(0);
                    }}
                    className="text-muted hover:text-foreground text-[10px] transition-colors"
                  >
                    {showAllModels ? "Show fewer models" : "Show all models…"}
                  </button>
                )}

                {policyEnforced && (
                  <div className="text-muted flex items-center gap-1 text-[10px]">
                    <ShieldCheck className="h-3 w-3" aria-hidden />
                    <span>Your settings are controlled by a policy.</span>
                  </div>
                )}

                {onOpenSettings && (
                  <button
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      onOpenSettings();
                      handleCancel();
                    }}
                    className="text-muted hover:bg-hover hover:text-foreground flex w-full items-center justify-start gap-1.5 rounded-sm px-2 py-1 text-[11px] transition-colors"
                  >
                    <Settings className="h-3 w-3 shrink-0" />
                    Model settings
                  </button>
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
