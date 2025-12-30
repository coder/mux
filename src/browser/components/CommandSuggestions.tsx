import React, { useState, useEffect, useRef, useLayoutEffect } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/common/lib/utils";
import type { SlashSuggestion } from "@/browser/utils/slashCommands/types";

// Export the keys that CommandSuggestions handles
export const COMMAND_SUGGESTION_KEYS = ["Tab", "ArrowUp", "ArrowDown", "Escape"];

// Props interface
interface CommandSuggestionsProps {
  suggestions: SlashSuggestion[];
  onSelectSuggestion: (suggestion: SlashSuggestion) => void;
  onDismiss: () => void;
  isVisible: boolean;
  ariaLabel?: string;
  listId?: string;
  /** Reference to the input element for portal positioning */
  anchorRef?: React.RefObject<HTMLElement | null>;
}

// Main component
export const CommandSuggestions: React.FC<CommandSuggestionsProps> = ({
  suggestions,
  onSelectSuggestion,
  onDismiss,
  isVisible,
  ariaLabel = "Command suggestions",
  listId,
  anchorRef,
}) => {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [position, setPosition] = useState<{ top: number; left: number; width: number } | null>(
    null
  );
  const menuRef = useRef<HTMLDivElement>(null);
  const selectedRef = useRef<HTMLDivElement>(null);
  const previousSuggestionsRef = useRef<SlashSuggestion[]>(suggestions);
  const wasVisibleRef = useRef(isVisible);

  // Keep selection stable while suggestions update (e.g. user keeps typing).
  // We reset selection only when the menu becomes visible.
  useLayoutEffect(() => {
    const wasVisible = wasVisibleRef.current;
    wasVisibleRef.current = isVisible;

    const prevSuggestions = previousSuggestionsRef.current;
    previousSuggestionsRef.current = suggestions;

    if (!isVisible || suggestions.length === 0) {
      setSelectedIndex(0);
      return;
    }

    // Menu just opened: default to the first suggestion.
    if (!wasVisible) {
      setSelectedIndex(0);
      return;
    }

    // Preserve the previously-selected suggestion if it still exists; otherwise clamp.
    setSelectedIndex((prevIndex) => {
      const prevSelected = prevSuggestions[prevIndex];
      if (prevSelected) {
        const nextIndex = suggestions.findIndex((s) => s.id === prevSelected.id);
        if (nextIndex !== -1) {
          return nextIndex;
        }
      }
      return Math.min(prevIndex, suggestions.length - 1);
    });
  }, [isVisible, suggestions]);

  // Scroll selected item into view
  useLayoutEffect(() => {
    selectedRef.current?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  // Calculate position when using portal mode
  useLayoutEffect(() => {
    if (!anchorRef?.current || !isVisible) {
      setPosition(null);
      return;
    }

    const updatePosition = () => {
      const anchor = anchorRef.current;
      if (!anchor) return;

      const rect = anchor.getBoundingClientRect();
      const menuHeight = menuRef.current?.offsetHeight ?? 200;

      setPosition({
        top: rect.top - menuHeight - 8, // 8px gap above anchor
        left: rect.left,
        width: rect.width,
      });
    };

    updatePosition();

    // Update on resize/scroll
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [anchorRef, isVisible, suggestions]);

  // Handle keyboard navigation
  useEffect(() => {
    if (!isVisible || suggestions.length === 0) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setSelectedIndex((i) => (i + 1) % suggestions.length);
          break;
        case "ArrowUp":
          e.preventDefault();
          setSelectedIndex((i) => (i - 1 + suggestions.length) % suggestions.length);
          break;
        case "Tab":
          if (!e.shiftKey && suggestions.length > 0) {
            e.preventDefault();
            onSelectSuggestion(suggestions[selectedIndex]);
          }
          break;
        case "Escape":
          e.preventDefault();
          onDismiss();
          break;
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isVisible, suggestions, selectedIndex, onSelectSuggestion, onDismiss]);

  // Click outside handler
  useEffect(() => {
    if (!isVisible) return;

    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest("[data-command-suggestions]")) {
        onDismiss();
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isVisible, onDismiss]);

  if (!isVisible || suggestions.length === 0) {
    return null;
  }

  const activeSuggestion = suggestions[selectedIndex] ?? suggestions[0];
  const resolvedListId = listId ?? `command-suggestions-list`;

  const content = (
    <div
      ref={menuRef}
      id={resolvedListId}
      role="listbox"
      aria-label={ariaLabel}
      aria-activedescendant={
        activeSuggestion ? `${resolvedListId}-option-${activeSuggestion.id}` : undefined
      }
      data-command-suggestions
      className={cn(
        "bg-separator border-border-light z-[1010] flex max-h-[200px] flex-col overflow-y-auto rounded border shadow-[0_-4px_12px_rgba(0,0,0,0.4)]",
        // Use absolute positioning relative to parent when not in portal mode
        !anchorRef && "absolute right-0 bottom-full left-0 mb-2"
      )}
      style={
        anchorRef && position
          ? {
              position: "fixed",
              top: position.top,
              left: position.left,
              width: position.width,
            }
          : undefined
      }
    >
      {suggestions.map((suggestion, index) => (
        <div
          key={suggestion.id}
          ref={index === selectedIndex ? selectedRef : undefined}
          onMouseEnter={() => setSelectedIndex(index)}
          onClick={() => onSelectSuggestion(suggestion)}
          id={`${resolvedListId}-option-${suggestion.id}`}
          role="option"
          aria-selected={index === selectedIndex}
          className={cn(
            "px-2.5 py-1.5 cursor-pointer flex items-center justify-between gap-3 hover:bg-accent/20",
            index === selectedIndex ? "bg-accent-darker" : "bg-transparent"
          )}
        >
          <div className="text-accent font-monospace shrink-0 text-xs">{suggestion.display}</div>
          <div className="text-medium truncate text-right text-[11px]">
            {suggestion.description}
          </div>
        </div>
      ))}
      <div className="border-border-light bg-dark text-placeholder [&_span]:text-medium shrink-0 border-t px-2.5 py-1 text-center text-[10px] [&_span]:font-medium">
        <span>Tab</span> to complete • <span>↑↓</span> to navigate • <span>Esc</span> to dismiss
      </div>
    </div>
  );

  // Use portal when anchorRef is provided (to escape overflow:hidden containers)
  if (anchorRef) {
    return createPortal(content, document.body);
  }

  return content;
};
