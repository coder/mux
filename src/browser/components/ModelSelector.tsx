import React, {
  useState,
  useRef,
  useEffect,
  useCallback,
  useImperativeHandle,
  forwardRef,
} from "react";
import { cn } from "@/common/lib/utils";
import { Settings, Star } from "lucide-react";
import { GatewayIcon } from "./icons/GatewayIcon";
import { TooltipWrapper, Tooltip } from "./Tooltip";
import { useSettings } from "@/browser/contexts/SettingsContext";
import { useGateway } from "@/browser/hooks/useGatewayModels";

interface ModelSelectorProps {
  value: string;
  onChange: (value: string) => void;
  recentModels: string[];
  onComplete?: () => void;
  defaultModel?: string | null;
  onSetDefaultModel?: (model: string) => void;
}

export interface ModelSelectorRef {
  open: () => void;
}

export const ModelSelector = forwardRef<ModelSelectorRef, ModelSelectorProps>(
  ({ value, onChange, recentModels, onComplete, defaultModel, onSetDefaultModel }, ref) => {
    const { open: openSettings } = useSettings();
    const gateway = useGateway();
    const [isEditing, setIsEditing] = useState(false);
    const [inputValue, setInputValue] = useState(value);
    const [error, setError] = useState<string | null>(null);
    const [showDropdown, setShowDropdown] = useState(false);
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

    // Filter recent models based on input (show all if empty) and sort lexicographically
    const filteredModels = (
      inputValue.trim() === ""
        ? recentModels
        : recentModels.filter((model) => model.toLowerCase().includes(inputValue.toLowerCase()))
    ).sort();

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
          ? recentModels
          : recentModels.filter((model) => model.toLowerCase().includes(newValue.toLowerCase()));
      const sortedFiltered = filtered.sort();

      // Highlight first result if any, otherwise no highlight
      setHighlightedIndex(sortedFiltered.length > 0 ? 0 : -1);

      // Keep dropdown visible if there are recent models (filtering happens automatically)
      setShowDropdown(recentModels.length > 0);
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
      setShowDropdown(recentModels.length > 0);

      // Start with current value highlighted
      const sortedModels = [...recentModels].sort();
      const currentIndex = sortedModels.indexOf(value);
      setHighlightedIndex(currentIndex);
    }, [recentModels, value]);

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
      const gatewayActive = gateway.isModelRoutingThroughGateway(value);
      return (
        <div ref={containerRef} className="relative flex items-center gap-1">
          {gatewayActive && (
            <TooltipWrapper inline>
              <GatewayIcon className="text-accent h-3 w-3 shrink-0" active />
              <Tooltip className="tooltip" align="center">
                Using Mux Gateway
              </Tooltip>
            </TooltipWrapper>
          )}
          <div
            className="text-muted-light font-monospace dir-rtl hover:bg-hover max-w-36 cursor-pointer truncate rounded-sm px-1 py-0.5 text-left font-mono text-[10px] leading-[11px] transition-colors duration-200"
            onClick={handleClick}
          >
            {value}
          </div>
          <TooltipWrapper inline>
            <button
              type="button"
              onClick={() => openSettings("models")}
              className="text-muted-light hover:text-foreground flex items-center justify-center rounded-sm p-0.5 transition-colors duration-150"
              aria-label="Manage models"
            >
              <Settings className="h-3 w-3" />
            </button>
            <Tooltip className="tooltip" align="center">
              Manage models
            </Tooltip>
          </TooltipWrapper>
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
            placeholder="provider:model-name"
            className="text-light bg-dark border-border-light font-monospace focus:border-exec-mode w-48 rounded-sm border px-1 py-0.5 text-[10px] leading-[11px] outline-none"
          />
          {error && (
            <div className="text-danger-soft font-monospace mt-0.5 text-[9px]">{error}</div>
          )}
        </div>
        {showDropdown && (
          <div className="bg-separator border-border-light absolute bottom-full left-0 z-[1000] mb-1 max-h-[200px] min-w-80 overflow-y-auto rounded border shadow-[0_4px_12px_rgba(0,0,0,0.3)]">
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
                    index === highlightedIndex
                      ? "text-foreground bg-hover"
                      : "text-light bg-transparent hover:bg-hover hover:text-foreground"
                  )}
                  onClick={() => handleSelectModel(model)}
                >
                  <div className="grid w-full grid-cols-[1fr_auto] items-center gap-2">
                    <span className="min-w-0 truncate">{model}</span>
                    <div className="flex items-center gap-0.5">
                      {/* Gateway toggle */}
                      {gateway.canToggleModel(model) && (
                        <TooltipWrapper inline>
                          <button
                            type="button"
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              gateway.toggleModelGateway(model);
                            }}
                            className={cn(
                              "flex items-center justify-center rounded-sm border px-1 py-0.5 transition-colors duration-150",
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
                          <Tooltip className="tooltip" align="center">
                            {gateway.modelUsesGateway(model)
                              ? "Using Mux Gateway"
                              : "Use Mux Gateway"}
                          </Tooltip>
                        </TooltipWrapper>
                      )}
                      {/* Default model toggle */}
                      {onSetDefaultModel && (
                        <TooltipWrapper inline>
                          <button
                            type="button"
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={(e) => handleSetDefault(e, model)}
                            className={cn(
                              "flex items-center justify-center rounded-sm border px-1 py-0.5 transition-colors duration-150",
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
                          <Tooltip className="tooltip" align="center">
                            {defaultModel === model
                              ? "Current default model"
                              : "Set as default model"}
                          </Tooltip>
                        </TooltipWrapper>
                      )}
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    );
  }
);

ModelSelector.displayName = "ModelSelector";
