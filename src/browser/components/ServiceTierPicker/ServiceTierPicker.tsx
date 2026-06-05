import React, { useCallback, useEffect, useRef, useState } from "react";
import { Check, Zap } from "lucide-react";

import { cn } from "@/common/lib/utils";
import { type ServiceTier } from "@/common/config/schemas/providersConfig";
import {
  getServiceTierSpeed,
  SERVICE_TIER_FAST,
  SERVICE_TIER_SLOW,
  supportsServiceTier,
  type ServiceTierSpeed,
} from "@/common/utils/ai/serviceTier";
import { useServiceTier } from "@/browser/hooks/useServiceTier";
import { Tooltip, TooltipContent, TooltipTrigger } from "../Tooltip/Tooltip";
import { stopKeyboardPropagation } from "@/browser/utils/events";

interface ServiceTierPickerProps {
  /** Canonical model string used to gate visibility (only shown for supporting models). */
  modelString: string;
  /** Workspace id (workspace view) or project scope id (creation view). */
  scopeId: string;
  className?: string;
}

interface ServiceTierOption {
  speed: ServiceTierSpeed;
  /** null clears the override (falls back to the provider/global default). */
  tier: ServiceTier | null;
  label: string;
  description: string;
}

// "Fast"/"Slow"/"Auto" wording keeps the control provider-agnostic even though
// only OpenAI honors service_tier today.
const OPTIONS: readonly ServiceTierOption[] = [
  { speed: "default", tier: null, label: "Auto", description: "Provider default speed" },
  {
    speed: "fast",
    tier: SERVICE_TIER_FAST,
    label: "Fast",
    description: "Prioritize low latency (higher cost)",
  },
  {
    speed: "slow",
    tier: SERVICE_TIER_SLOW,
    label: "Slow",
    description: "Prioritize lower cost (higher latency)",
  },
];

/** CSS variable for the active speed, or undefined for the neutral (grey) state. */
function getSpeedColorVar(speed: ServiceTierSpeed): string | undefined {
  if (speed === "fast") return "var(--color-service-tier-fast)";
  if (speed === "slow") return "var(--color-service-tier-slow)";
  return undefined;
}

/**
 * Lightning-bolt control for the chat-specific service-tier (speed) override.
 *
 * - Fast → bolt glows orange, Slow → bolt turns blue, Auto/default → neutral grey.
 * - Clicking opens a small keyboard-navigable menu that sets the per-chat override.
 *
 * Rendered only for models that support service tiers (OpenAI/GPT today). Uses
 * conditional rendering (not a Radix portal) so it stays testable under happy-dom.
 */
export const ServiceTierPicker: React.FC<ServiceTierPickerProps> = (props) => {
  const [serviceTier, setServiceTier] = useServiceTier(props.scopeId);
  const [isOpen, setIsOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);

  const containerRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const currentSpeed = getServiceTierSpeed(serviceTier);

  const closePicker = useCallback(() => {
    setIsOpen(false);
    setHighlightedIndex(-1);
  }, []);

  const openPicker = useCallback(() => {
    setIsOpen(true);
    const currentIndex = OPTIONS.findIndex((opt) => opt.speed === currentSpeed);
    setHighlightedIndex(currentIndex >= 0 ? currentIndex : 0);
    requestAnimationFrame(() => dropdownRef.current?.focus());
  }, [currentSpeed]);

  const handleSelect = useCallback(
    (option: ServiceTierOption) => {
      setServiceTier(option.tier);
      closePicker();
    },
    [closePicker, setServiceTier]
  );

  // Close when clicking outside the control.
  useEffect(() => {
    if (!isOpen) {
      return;
    }
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current?.contains(e.target as Node)) {
        return;
      }
      closePicker();
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [closePicker, isOpen]);

  const handleDropdownKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      stopKeyboardPropagation(e);
      closePicker();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const option = OPTIONS[highlightedIndex >= 0 ? highlightedIndex : 0];
      if (option) {
        handleSelect(option);
      }
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlightedIndex((prev) => Math.min(prev + 1, OPTIONS.length - 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightedIndex((prev) => Math.max(prev - 1, 0));
      return;
    }
  };

  // Only models that honor service tiers expose this affordance.
  if (!supportsServiceTier(props.modelString)) {
    return null;
  }

  const activeColor = getSpeedColorVar(currentSpeed);
  const activeLabel = OPTIONS.find((opt) => opt.speed === currentSpeed)?.label ?? "Auto";

  return (
    <div ref={containerRef} className={cn("relative flex items-center", props.className)}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={() => (isOpen ? closePicker() : openPicker())}
            data-testid="service-tier-trigger"
            data-service-tier={currentSpeed}
            aria-haspopup="menu"
            aria-expanded={isOpen}
            aria-label={`Service tier: ${activeLabel}. Click to change.`}
            className={cn(
              "flex h-4 w-4 items-center justify-center rounded-sm transition-colors",
              activeColor ? "" : "text-muted hover:text-foreground hover:bg-hover"
            )}
            style={
              activeColor
                ? {
                    color: activeColor,
                    // Orange "glow" for Fast; a softer halo for Slow.
                    filter: `drop-shadow(0 0 ${currentSpeed === "fast" ? "5px" : "3px"} ${activeColor})`,
                  }
                : undefined
            }
          >
            <Zap className="h-3 w-3" />
          </button>
        </TooltipTrigger>
        <TooltipContent align="center">
          Service tier: <span className="font-medium">{activeLabel}</span>. Sets request speed for
          this chat. Saved per workspace.
        </TooltipContent>
      </Tooltip>

      {isOpen && (
        <div
          ref={dropdownRef}
          tabIndex={-1}
          role="menu"
          onKeyDown={handleDropdownKeyDown}
          className="bg-separator border-border-light absolute bottom-full left-0 z-[1020] mb-1 min-w-48 overflow-hidden rounded border shadow-[0_4px_12px_rgba(0,0,0,0.3)] outline-none"
        >
          <div className="py-1">
            {OPTIONS.map((option, index) => {
              const isHighlighted = index === highlightedIndex;
              const isSelected = option.speed === currentSpeed;
              const color = getSpeedColorVar(option.speed);
              return (
                <div
                  key={option.speed}
                  role="menuitemradio"
                  aria-checked={isSelected}
                  tabIndex={-1}
                  data-testid="service-tier-option"
                  data-speed={option.speed}
                  className={cn(
                    "flex cursor-pointer items-center gap-2.5 px-2.5 py-1.5 transition-colors duration-100",
                    isHighlighted ? "bg-hover text-foreground" : "bg-transparent hover:bg-hover",
                    isSelected ? "text-foreground" : "text-light hover:text-foreground"
                  )}
                  onMouseEnter={() => setHighlightedIndex(index)}
                  onClick={() => handleSelect(option)}
                >
                  <Zap className="h-3.5 w-3.5 shrink-0" style={color ? { color } : undefined} />
                  <div className="min-w-0 flex-1">
                    <div className="text-[11px] font-medium">{option.label}</div>
                    <div className="text-muted-light text-[10px]">{option.description}</div>
                  </div>
                  {isSelected && <Check className="text-accent h-3.5 w-3.5 shrink-0" />}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};
