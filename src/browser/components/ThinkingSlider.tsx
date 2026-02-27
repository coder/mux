import React from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import {
  THINKING_LEVELS,
  getThinkingDisplayLabel,
  type ThinkingLevel,
} from "@/common/types/thinking";
import { useThinkingLevel } from "@/browser/hooks/useThinkingLevel";
import { Tooltip, TooltipTrigger, TooltipContent } from "./Tooltip/Tooltip";
import { formatKeybind, KEYBINDS } from "@/browser/utils/ui/keybinds";
import { enforceThinkingPolicy, getThinkingPolicyForModel } from "@/common/utils/thinking/policy";
import { cn } from "@/common/lib/utils";

// Uses CSS variable --color-thinking-mode for theme compatibility
// All levels are shown; policy determines which are available per model
const BASE_THINKING_LEVELS: ThinkingLevel[] = [...THINKING_LEVELS];

// Text styling based on level (n: 0-5, mapping off/low/medium/high/xhigh/max)
// Uses CSS variables for theme compatibility
const getTextStyle = (n: number): React.CSSProperties => {
  if (n === 0) {
    return {
      color: "var(--color-text-secondary)",
      fontWeight: 400,
    };
  }

  // Active levels use the thinking mode color
  // Low uses lighter variant, medium/high use main color
  const fontWeight = 400 + n * 100; // 500 → 600 → 700

  return {
    color: n === 1 ? "var(--color-thinking-mode-light)" : "var(--color-thinking-mode)",
    fontWeight,
  };
};

interface ThinkingControlProps {
  modelString: string;
}

export const ThinkingSliderComponent: React.FC<ThinkingControlProps> = ({ modelString }) => {
  const [thinkingLevel, setThinkingLevel] = useThinkingLevel();
  const allowed = getThinkingPolicyForModel(modelString);
  const effectiveThinkingLevel = enforceThinkingPolicy(modelString, thinkingLevel);

  // Map current level to index within the *allowed* subset
  const currentIndex = allowed.indexOf(effectiveThinkingLevel);

  // Map levels to visual intensity indices (0-3) so colors stay consistent
  const visualValue = (() => {
    const idx = BASE_THINKING_LEVELS.indexOf(effectiveThinkingLevel);
    if (idx >= 0) return idx;
    return BASE_THINKING_LEVELS.length - 1; // clamp extras (e.g., xhigh) to strongest
  })();

  const textStyle = getTextStyle(visualValue);

  const canGoLeft = currentIndex > 0;
  const canGoRight = currentIndex < allowed.length - 1;

  const goLeft = () => {
    if (canGoLeft) {
      setThinkingLevel(allowed[currentIndex - 1]);
    }
  };

  const goRight = () => {
    if (canGoRight) {
      setThinkingLevel(allowed[currentIndex + 1]);
    }
  };

  const displayLabel = getThinkingDisplayLabel(effectiveThinkingLevel, modelString);

  // Single-option policy: render non-interactive badge
  if (allowed.length <= 1) {
    const fixedLevel = allowed[0] || "off";
    const standardIndex = BASE_THINKING_LEVELS.indexOf(fixedLevel);
    const value = standardIndex === -1 ? 0 : standardIndex;
    const tooltipMessage = `Model ${modelString} locks thinking at ${getThinkingDisplayLabel(fixedLevel, modelString)} to match its capabilities.`;

    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="flex items-center">
            <span
              className="w-[5ch] text-center text-[11px] select-none"
              style={getTextStyle(value)}
              aria-label={`Thinking level fixed to ${fixedLevel}`}
            >
              {getThinkingDisplayLabel(fixedLevel, modelString)}
            </span>
          </div>
        </TooltipTrigger>
        <TooltipContent align="center">{tooltipMessage}</TooltipContent>
      </Tooltip>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="flex items-center">
          <button
            type="button"
            onClick={goLeft}
            disabled={!canGoLeft}
            data-thinking-paddle="left"
            className={cn(
              "flex h-4 w-4 items-center justify-center rounded-sm transition-colors",
              canGoLeft
                ? "text-muted hover:bg-hover hover:text-foreground cursor-pointer"
                : "text-muted/30 cursor-default"
            )}
            aria-label="Decrease thinking level"
          >
            <ChevronLeft className="h-3 w-3" />
          </button>
          <button
            type="button"
            onClick={() => {
              // On narrow layouts the paddles may be hidden, so the label remains a usable control.
              const nextIndex = (currentIndex + 1) % allowed.length;
              setThinkingLevel(allowed[nextIndex]);
            }}
            data-thinking-label
            className="hover:bg-hover w-[5ch] min-w-[5ch] shrink-0 rounded-sm bg-transparent p-0 text-center text-[11px] transition-all duration-200 select-none"
            style={textStyle}
            aria-live="polite"
            aria-label={`Thinking level: ${effectiveThinkingLevel}. Click to cycle.`}
          >
            {displayLabel}
          </button>
          <button
            type="button"
            onClick={goRight}
            disabled={!canGoRight}
            data-thinking-paddle="right"
            className={cn(
              "flex h-4 w-4 items-center justify-center rounded-sm transition-colors",
              canGoRight
                ? "text-muted hover:bg-hover hover:text-foreground cursor-pointer"
                : "text-muted/30 cursor-default"
            )}
            aria-label="Increase thinking level"
          >
            <ChevronRight className="h-3 w-3" />
          </button>
        </div>
      </TooltipTrigger>
      <TooltipContent align="center">
        Thinking:{" "}
        <span className="mobile-hide-shortcut-hints">
          {formatKeybind(KEYBINDS.TOGGLE_THINKING)} to cycle.{" "}
        </span>
        Saved per workspace.
      </TooltipContent>
    </Tooltip>
  );
};
