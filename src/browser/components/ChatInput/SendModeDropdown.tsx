import React, { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { Button } from "../Button/Button";
import { formatKeybind } from "@/browser/utils/ui/keybinds";
import { cn } from "@/common/lib/utils";
import type { QueueDispatchMode } from "./types";
import { SEND_DISPATCH_MODES } from "./sendDispatchModes";

interface SendModeDropdownProps {
  onSelect: (mode: QueueDispatchMode) => void;
  triggerClassName?: string;
  disabled?: boolean;
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

  useEffect(() => {
    if (!props.disabled) {
      return;
    }

    setIsOpen(false);
  }, [props.disabled]);

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
        disabled={props.disabled}
        onClick={() => setIsOpen((prev) => !prev)}
        className={cn(
          // Button applies a default `[&_svg]:size-4`; override locally so this caret
          // stays slightly smaller than the send icon while remaining clearly legible.
          "text-muted hover:text-foreground hover:bg-hover inline-flex items-center justify-center rounded-sm px-0.5 py-0.5 font-medium transition-colors duration-200 [&_svg]:!size-3.5 [&_svg]:translate-y-px",
          props.triggerClassName
        )}
      >
        <ChevronDown strokeWidth={2.5} />
      </Button>

      {isOpen && (
        <div className="bg-separator border-border-light absolute right-0 bottom-full mb-1 min-w-[12.5rem] rounded-md border p-1.5 shadow-md">
          {SEND_DISPATCH_MODES.map((entry) => (
            <button
              key={entry.mode}
              type="button"
              className="hover:bg-hover focus-visible:bg-hover text-foreground flex w-full items-center justify-between gap-2 rounded-sm px-2.5 py-1 text-left text-xs"
              onClick={() => handleSelect(entry.mode)}
            >
              <span className="whitespace-nowrap">{entry.label}</span>
              <kbd className="bg-background-secondary text-foreground border-border-medium rounded border px-1.5 py-px font-mono text-[10px] whitespace-nowrap">
                {formatKeybind(entry.keybind)}
              </kbd>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
