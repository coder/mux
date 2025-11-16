import React, {
  useState,
  useRef,
  useEffect,
  useCallback,
  useImperativeHandle,
  forwardRef,
} from "react";
import { cn } from "@/common/lib/utils";

interface ModelSelectorProps {
  value: string;
  onChange: (value: string) => void;
  recentModels: string[];
  onRemoveModel?: (model: string) => void;
  onComplete?: () => void;
}

export interface ModelSelectorRef {
  open: () => void;
}

export const ModelSelector = forwardRef<ModelSelectorRef, ModelSelectorProps>(
  ({ value, onChange, recentModels, onRemoveModel, onComplete }, ref) => {
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
      // If an item is highlighted, use that instead of inputValue
      const valueToSave =
        highlightedIndex >= 0 && highlightedIndex < filteredModels.length
          ? filteredModels[highlightedIndex]
          : inputValue.trim();

      if (!valueToSave) {
        setError("Model cannot be empty");
        return;
      }

      // Basic validation: should have format "provider:model" or be an abbreviation
      if (!valueToSave.includes(":") && valueToSave.length < 3) {
        setError("Invalid model format");
        return;
      }

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
        handleSave();
        // Focus the main ChatInput after selecting a model
        onComplete?.();
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

    const handleRemoveModel = useCallback(
      (model: string, event: React.MouseEvent<HTMLButtonElement>) => {
        event.preventDefault();
        event.stopPropagation();
        if (!onRemoveModel) {
          return;
        }
        onRemoveModel(model);
        setHighlightedIndex(-1);
        if (inputValue === model) {
          setInputValue("");
        }
      },
      [inputValue, onRemoveModel]
    );

    const handleClick = useCallback(() => {
      setIsEditing(true);
      setInputValue(""); // Clear input to show all models
      setShowDropdown(recentModels.length > 0);

      // Start with current value highlighted
      const sortedModels = [...recentModels].sort();
      const currentIndex = sortedModels.indexOf(value);
      setHighlightedIndex(currentIndex);
    }, [recentModels, value]);

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
      return (
        <div ref={containerRef} className="relative flex items-center gap-1">
          <div
            className="text-muted-light font-monospace dir-rtl hover:bg-hover max-w-36 cursor-pointer truncate rounded-sm px-1 py-0.5 text-left font-mono text-[10px] leading-[11px] transition-colors duration-200"
            onClick={handleClick}
          >
            {value}
          </div>
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
        {showDropdown && filteredModels.length > 0 && (
          <div className="bg-separator border-border-light absolute bottom-full left-0 z-[1000] mb-1 max-h-[200px] min-w-80 overflow-y-auto rounded border shadow-[0_4px_12px_rgba(0,0,0,0.3)]">
            {filteredModels.map((model, index) => (
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
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate">{model}</span>
                  {onRemoveModel && (
                    <button
                      type="button"
                      onClick={(event) => handleRemoveModel(model, event)}
                      className="text-muted-light border-border-light/40 hover:border-danger-soft/60 hover:text-danger-soft rounded-sm border px-1 py-0.5 text-[9px] font-semibold tracking-wide uppercase transition-colors duration-150"
                      aria-label={`Remove ${model} from recent models`}
                    >
                      ×
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }
);

ModelSelector.displayName = "ModelSelector";
