import React, { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { Button } from "../ui/button";
import { formatKeybind } from "@/browser/utils/ui/keybinds";
import type { QueueDispatchMode } from "./types";
import { SEND_DISPATCH_MODES } from "./sendDispatchModes";

interface SendModeDropdownProps {
  onSelect: (mode: QueueDispatchMode) => void;
}

export const SendModeDropdown: React.FC<SendModeDropdownProps> = (props) => {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current?.contains(event.target as Node)) {
        return;
      }
      setIsOpen(false);
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }

      event.preventDefault();
      setIsOpen(false);
    };

    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [isOpen]);

  const handleSelect = (mode: QueueDispatchMode) => {
    props.onSelect(mode);
    setIsOpen(false);
  };

  return (
    <div ref={containerRef} className="relative">
      <Button
        type="button"
        size="xs"
        variant="ghost"
        aria-label="Send mode options"
        aria-expanded={isOpen}
        onClick={() => setIsOpen((prev) => !prev)}
        className="text-muted hover:text-foreground hover:bg-hover inline-flex items-center justify-center rounded-sm px-1.5 py-0.5 font-medium transition-colors duration-200"
      >
        <ChevronDown className="h-3.5 w-3.5" strokeWidth={2.5} />
      </Button>

      {isOpen && (
        <div className="bg-separator border-border-light absolute right-0 bottom-full mb-1 rounded-md border p-1 shadow-md">
          {SEND_DISPATCH_MODES.map((entry) => (
            <button
              key={entry.mode}
              type="button"
              className="hover:bg-hover focus-visible:bg-hover text-foreground flex w-full items-center justify-between gap-3 rounded-sm px-2 py-1 text-left text-xs"
              onClick={() => handleSelect(entry.mode)}
            >
              <span>{entry.label}</span>
              <kbd className="bg-background-secondary text-foreground border-border-medium rounded border px-2 py-0.5 font-mono text-xs">
                {formatKeybind(entry.keybind)}
              </kbd>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
