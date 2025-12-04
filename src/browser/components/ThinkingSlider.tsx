import React, { useEffect, useId } from "react";
import type { ThinkingLevel, ThinkingLevelOn } from "@/common/types/thinking";
import { useThinkingLevel } from "@/browser/hooks/useThinkingLevel";
import { TooltipWrapper, Tooltip } from "./Tooltip";
import { formatKeybind, KEYBINDS } from "@/browser/utils/ui/keybinds";
import { getThinkingPolicyForModel } from "@/browser/utils/thinking/policy";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import { getLastThinkingByModelKey } from "@/common/constants/storage";

// Uses CSS variable --color-thinking-mode for theme compatibility
// Glow is applied via CSS using color-mix with the theme color
const GLOW_INTENSITIES: Record<number, { track: string; thumb: string }> = {
  0: { track: "none", thumb: "none" },
  1: {
    track: "0 0 6px 1px color-mix(in srgb, var(--color-thinking-mode) 30%, transparent)",
    thumb: "0 0 4px 1px color-mix(in srgb, var(--color-thinking-mode) 30%, transparent)",
  },
  2: {
    track: "0 0 6px 1px color-mix(in srgb, var(--color-thinking-mode) 30%, transparent)",
    thumb: "0 0 4px 1px color-mix(in srgb, var(--color-thinking-mode) 30%, transparent)",
  },
  3: {
    track: "0 0 6px 1px color-mix(in srgb, var(--color-thinking-mode) 30%, transparent)",
    thumb: "0 0 4px 1px color-mix(in srgb, var(--color-thinking-mode) 30%, transparent)",
  },
};

// Text styling based on level (n: 0-3)
// Uses CSS variables for theme compatibility
const getTextStyle = (n: number): React.CSSProperties => {
  if (n === 0) {
    return {
      color: "var(--color-muted)",
      fontWeight: 400,
      textShadow: "none",
      fontSize: "10px",
    };
  }

  // Active levels use the thinking mode color
  // Low uses lighter variant, medium/high use main color
  const fontWeight = 400 + n * 100; // 500 → 600 → 700

  return {
    color: n === 1 ? "var(--color-thinking-mode-light)" : "var(--color-thinking-mode)",
    fontWeight,
    textShadow: "none",
    fontSize: "10px",
  };
};

const getSliderStyles = (value: number, isHover = false) => {
  const effectiveValue = isHover ? Math.min(value + 1, 3) : value;
  // Use CSS variable for thumb color when active
  const thumbBg = value === 0 ? "var(--color-muted)" : "var(--color-thinking-mode)";

  return {
    trackShadow: GLOW_INTENSITIES[effectiveValue].track,
    thumbShadow: GLOW_INTENSITIES[effectiveValue].thumb,
    thumbBg,
  };
};

interface ThinkingControlProps {
  modelString: string;
}

export const ThinkingSliderComponent: React.FC<ThinkingControlProps> = ({ modelString }) => {
  const [thinkingLevel, setThinkingLevel] = useThinkingLevel();
  const [isHovering, setIsHovering] = React.useState(false);
  const sliderId = useId();
  const allowed = getThinkingPolicyForModel(modelString);

  // Force value to nearest allowed level if current level is invalid for this model
  // This prevents "stuck" invalid states when switching models
  useEffect(() => {
    // If current level is valid, do nothing
    if (allowed.includes(thinkingLevel)) return;

    // If current level is invalid, switch to a valid one
    // Prefer medium if available, otherwise first allowed
    const fallback = allowed.includes("medium") ? "medium" : allowed[0];

    // Only update if we actually need to change it (prevent infinite loops)
    // We use a timeout to avoid updating state during render
    const timer = setTimeout(() => {
      setThinkingLevel(fallback);
    }, 0);
    return () => clearTimeout(timer);
  }, [allowed, thinkingLevel, setThinkingLevel]);

  if (allowed.length <= 1) {
    // Render non-interactive badge for single-option policies with explanatory tooltip
    // or if no options are available (shouldn't happen given policy types)
    const fixedLevel = allowed[0] || "off";
    // Calculate style based on "standard" levels for consistency
    const standardIndex = ["off", "low", "medium", "high"].indexOf(fixedLevel);
    const value = standardIndex === -1 ? 0 : standardIndex;

    const formattedLevel = fixedLevel === "off" ? "Off" : fixedLevel;
    const tooltipMessage = `Model ${modelString} locks thinking at ${formattedLevel.toUpperCase()} to match its capabilities.`;
    const textStyle = getTextStyle(value);

    return (
      <TooltipWrapper>
        <div className="flex items-center gap-2">
          <span
            className="min-w-11 uppercase transition-all duration-200 select-none"
            style={textStyle}
            aria-live="polite"
            aria-label={`Thinking level fixed to ${fixedLevel}`}
          >
            {fixedLevel}
          </span>
        </div>
        <Tooltip align="center">{tooltipMessage}</Tooltip>
      </TooltipWrapper>
    );
  }

  // Map current level to index within the *allowed* subset
  const currentIndex = allowed.indexOf(thinkingLevel);
  const sliderValue = currentIndex === -1 ? 0 : currentIndex;
  const maxSteps = allowed.length - 1;

  // For styling, we still want to map to the "global" intensity 0-3
  // to keep colors consistent (e.g. "high" is always purple, even if it's step 1 of 2)
  const globalLevelIndex = ["off", "low", "medium", "high"].indexOf(thinkingLevel);
  const visualValue = globalLevelIndex === -1 ? 0 : globalLevelIndex;

  const sliderStyles = getSliderStyles(visualValue, isHovering);
  const textStyle = getTextStyle(visualValue);

  const handleSliderChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const index = parseInt(e.target.value, 10);
    const newLevel = allowed[index];
    if (newLevel) {
      handleThinkingLevelChange(newLevel);
    }
  };

  const handleThinkingLevelChange = (newLevel: ThinkingLevel) => {
    setThinkingLevel(newLevel);
    // Also save to lastThinkingByModel for Ctrl+Shift+T toggle memory
    // Only save active levels (not "off") - matches useAIViewKeybinds logic
    if (newLevel !== "off") {
      const lastThinkingKey = getLastThinkingByModelKey(modelString);
      updatePersistedState(lastThinkingKey, newLevel as ThinkingLevelOn);
    }
  };

  // Cycle through allowed thinking levels
  const cycleThinkingLevel = () => {
    const nextIndex = (currentIndex + 1) % allowed.length;
    handleThinkingLevelChange(allowed[nextIndex]);
  };

  return (
    <TooltipWrapper>
      <div className="flex items-center gap-2">
        <input
          type="range"
          min="0"
          max={maxSteps}
          step="1"
          value={sliderValue}
          onChange={handleSliderChange}
          onMouseEnter={() => setIsHovering(true)}
          onMouseLeave={() => setIsHovering(false)}
          id={sliderId}
          role="slider"
          aria-valuemin={0}
          aria-valuemax={maxSteps}
          aria-valuenow={sliderValue}
          aria-valuetext={thinkingLevel}
          aria-label="Thinking level"
          className="thinking-slider"
          style={
            {
              "--track-shadow": sliderStyles.trackShadow,
              "--thumb-shadow": sliderStyles.thumbShadow,
              "--thumb-bg": sliderStyles.thumbBg,
            } as React.CSSProperties
          }
        />
        <button
          type="button"
          onClick={cycleThinkingLevel}
          className="cursor-pointer border-none bg-transparent p-0"
          aria-label={`Thinking level: ${thinkingLevel}. Click to cycle.`}
        >
          <span
            className="min-w-11 uppercase transition-all duration-200 select-none"
            style={textStyle}
            aria-live="polite"
          >
            {thinkingLevel}
          </span>
        </button>
      </div>
      <Tooltip align="center">
        Thinking: {formatKeybind(KEYBINDS.TOGGLE_THINKING)} to toggle. Click level to cycle.
      </Tooltip>
    </TooltipWrapper>
  );
};
