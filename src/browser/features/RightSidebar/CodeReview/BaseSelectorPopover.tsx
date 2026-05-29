/**
 * BaseSelectorPopover - Dropdown for selecting diff base (similar to BranchSelector)
 *
 * Uses conditional rendering (not Radix Portal) to enable testing in happy-dom.
 * Pattern follows AgentModePicker.
 */

import React, { useState, useRef, useEffect } from "react";
import { Check } from "lucide-react";
import { cn } from "@/common/lib/utils";

const BASE_SUGGESTIONS = [
  "HEAD",
  "--staged",
  "main",
  "origin/main",
  "HEAD~1",
  "HEAD~2",
  "develop",
  "origin/develop",
] as const;

interface BaseSelectorPopoverProps {
  value: string;
  onChange: (value: string) => void;
  onOpenChange?: (open: boolean) => void;
  className?: string;
  "data-testid"?: string;
}

export function BaseSelectorPopover({
  value,
  onChange,
  onOpenChange,
  className,
  "data-testid": testId,
}: BaseSelectorPopoverProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [inputValue, setInputValue] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const handleOpenChange = (open: boolean) => {
    setIsOpen(open);
    onOpenChange?.(open);
  };

  // Sync input with external value changes
  useEffect(() => {
    setInputValue(value);
  }, [value]);

  // Clear search and focus input when dropdown opens
  useEffect(() => {
    if (isOpen) {
      setInputValue(""); // Clear to show all suggestions
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [isOpen]);

  // Close dropdown on outside click
  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
        onOpenChange?.(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen, onOpenChange]);

  const handleSelect = (selected: string) => {
    onChange(selected);
    setInputValue(selected);
    handleOpenChange(false);
  };

  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      const trimmed = inputValue.trim();
      if (trimmed) {
        onChange(trimmed);
        handleOpenChange(false);
      }
    } else if (e.key === "Escape") {
      setInputValue(value);
      handleOpenChange(false);
    }
  };

  // Filter suggestions based on input
  const searchLower = inputValue.toLowerCase();
  const filteredSuggestions = BASE_SUGGESTIONS.filter((s) => s.toLowerCase().includes(searchLower));

  return (
    <div ref={containerRef} className="relative">
      <button
        className={cn(
          "text-muted-light hover:bg-hover hover:text-foreground flex items-center gap-1 rounded-sm px-1 py-0.5 font-mono text-[11px] transition-colors",
          className
        )}
        data-testid={testId}
        onClick={() => handleOpenChange(!isOpen)}
        aria-expanded={isOpen}
      >
        <span className="truncate">{value}</span>
      </button>

      {isOpen && (
        <div className="bg-dark border-border absolute top-full left-0 z-[10001] mt-1 w-[160px] overflow-hidden rounded-md border shadow-md">
          {/* Search/edit input */}
          <div className="border-border border-b px-2 py-1.5">
            <input
              ref={inputRef}
              type="text"
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={handleInputKeyDown}
              placeholder="Enter base..."
              className="text-foreground placeholder:text-muted w-full bg-transparent font-mono text-[11px] outline-none"
            />
          </div>

          <div className="max-h-[200px] overflow-y-auto p-1">
            {filteredSuggestions.length === 0 ? (
              <div className="text-muted py-2 text-center text-[10px]">
                Press Enter to use &ldquo;{inputValue}&rdquo;
              </div>
            ) : (
              filteredSuggestions.map((suggestion) => (
                <button
                  key={suggestion}
                  data-testid={`base-suggestion-${suggestion}`}
                  onMouseDown={(e) => e.preventDefault()} // Prevent input blur before click
                  onClick={() => handleSelect(suggestion)}
                  className="hover:bg-hover flex w-full items-center gap-1.5 rounded-sm px-2 py-1 font-mono text-[11px]"
                >
                  <Check
                    className={cn(
                      "h-3 w-3 shrink-0",
                      suggestion === value ? "opacity-100" : "opacity-0"
                    )}
                  />
                  <span className="truncate">{suggestion}</span>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
