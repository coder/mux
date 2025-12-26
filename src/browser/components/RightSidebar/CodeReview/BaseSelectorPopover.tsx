/**
 * BaseSelectorPopover - Dropdown for selecting diff base (similar to BranchSelector)
 */

import React, { useState, useRef, useEffect } from "react";
import { Check } from "lucide-react";
import { cn } from "@/common/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/browser/components/ui/popover";

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
  className?: string;
}

export function BaseSelectorPopover({ value, onChange, className }: BaseSelectorPopoverProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [inputValue, setInputValue] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);

  // Sync input with external value changes
  useEffect(() => {
    setInputValue(value);
  }, [value]);

  // Focus input when popover opens
  useEffect(() => {
    if (isOpen) {
      // Small delay to let popover render
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [isOpen]);

  const handleSelect = (selected: string) => {
    onChange(selected);
    setInputValue(selected);
    setIsOpen(false);
  };

  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      const trimmed = inputValue.trim();
      if (trimmed) {
        onChange(trimmed);
        setIsOpen(false);
      }
    } else if (e.key === "Escape") {
      setInputValue(value);
      setIsOpen(false);
    }
  };

  const handleInputBlur = () => {
    const trimmed = inputValue.trim();
    if (trimmed && trimmed !== value) {
      onChange(trimmed);
    } else {
      setInputValue(value);
    }
  };

  // Filter suggestions based on input
  const searchLower = inputValue.toLowerCase();
  const filteredSuggestions = BASE_SUGGESTIONS.filter((s) => s.toLowerCase().includes(searchLower));

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        <button
          className={cn(
            "text-muted-light hover:bg-hover hover:text-foreground flex items-center gap-1 rounded-sm px-1 py-0.5 font-mono text-[11px] transition-colors",
            className
          )}
        >
          <span className="truncate">{value}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[160px] p-0">
        {/* Search/edit input */}
        <div className="border-border border-b px-2 py-1.5">
          <input
            ref={inputRef}
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={handleInputKeyDown}
            onBlur={handleInputBlur}
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
      </PopoverContent>
    </Popover>
  );
}
