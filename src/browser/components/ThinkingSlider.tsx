import React, { useEffect, useId } from "react";
import type { ThinkingLevel, ThinkingLevelOn } from "@/common/types/thinking";
import { useThinkingLevel } from "@/browser/hooks/useThinkingLevel";
import { TooltipWrapper, Tooltip } from "./Tooltip";
import { formatKeybind, KEYBINDS } from "@/browser/utils/ui/keybinds";
import { getThinkingPolicyForModel } from "@/browser/utils/thinking/policy";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import { getLastThinkingByModelKey } from "@/common/constants/storage";

// Subtle consistent glow for active levels
const GLOW = {
  track: "0 0 6px 1px hsl(271 76% 53% / 0.3)",
  thumb: "0 0 4px 1px hsl(271 76% 53% / 0.3)",
};

const GLOW_INTENSITIES: Record<number, { track: string; thumb: string }> = {
  0: { track: "none", thumb: "none" },
  1: GLOW,
  2: GLOW,
  3: GLOW,
};

// Continuous function for text styling based on level (n: 0-3)
const getTextStyle = (n: number) => {
  if (n === 0) {
    return {
      color: "#606060",
      fontWeight: 400,
      textShadow: "none",
      fontSize: "10px",
    };
  }

  // Continuous interpolation for n = 1-3
  const hue = 271 + (n - 1) * 7; // 271 → 278 → 285
  const lightness = 65 - (n - 1) * 5; // 65 → 60 → 55
  const fontWeight = 400 + n * 100; // 500 → 600 → 700
  const shadowBlur = n * 4; // 4 → 8 → 12
  const shadowOpacity = 0.3 + n * 0.15; // 0.45 → 0.6 → 0.75

  return {
    color: `hsl(${hue} 76% ${lightness}%)`,
    fontWeight,
    textShadow: `0 0 ${shadowBlur}px hsl(${hue} 76% ${lightness}% / ${shadowOpacity})`,
    fontSize: "10px",
  };
};

const getSliderStyles = (value: number, isHover = false) => {
  const effectiveValue = isHover ? Math.min(value + 1, 3) : value;
  const thumbBg = value === 0 ? "#606060" : `hsl(271 76% ${53 + value * 5}%)`;

  return {
    trackShadow: GLOW_INTENSITIES[effectiveValue].track,
    thumbShadow: GLOW_INTENSITIES[effectiveValue].thumb,
    thumbBg,
  };
};

// Helper functions to map between slider value and ThinkingLevel
const THINKING_LEVELS: ThinkingLevel[] = ["off", "low", "medium", "high"];

const thinkingLevelToValue = (level: ThinkingLevel): number => {
  return THINKING_LEVELS.indexOf(level);
};

const valueToThinkingLevel = (value: number): ThinkingLevel => {
  return THINKING_LEVELS[value] || "off";
};

interface ThinkingControlProps {
  modelString: string;
}

export const ThinkingSliderComponent: React.FC<ThinkingControlProps> = ({ modelString }) => {
  const [thinkingLevel, setThinkingLevel] = useThinkingLevel();
  const [isHovering, setIsHovering] = React.useState(false);
  const sliderId = useId();
  const allowed = getThinkingPolicyForModel(modelString);

  // If policy has single level (e.g., gpt-5-pro), force to that level
  useEffect(() => {
    if (allowed.length === 1 && thinkingLevel !== allowed[0]) {
      setThinkingLevel(allowed[0]);
    }
  }, [allowed, thinkingLevel, setThinkingLevel]);

  if (allowed.length === 1) {
    // Render non-interactive badge for single-option policies with explanatory tooltip
    const fixedLevel = allowed[0];
    const value = thinkingLevelToValue(fixedLevel);
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

  const value = thinkingLevelToValue(thinkingLevel);
  const sliderStyles = getSliderStyles(value, isHovering);
  const textStyle = getTextStyle(value);

  const handleThinkingLevelChange = (newLevel: ThinkingLevel) => {
    setThinkingLevel(newLevel);
    // Also save to lastThinkingByModel for Ctrl+Shift+T toggle memory
    // Only save active levels (not "off") - matches useAIViewKeybinds logic
    if (newLevel !== "off") {
      const lastThinkingKey = getLastThinkingByModelKey(modelString);
      updatePersistedState(lastThinkingKey, newLevel as ThinkingLevelOn);
    }
  };

  // Cycle through allowed thinking levels: off → low → medium → high → off
  const cycleThinkingLevel = () => {
    const currentIndex = THINKING_LEVELS.indexOf(thinkingLevel);
    const nextIndex = (currentIndex + 1) % THINKING_LEVELS.length;
    handleThinkingLevelChange(THINKING_LEVELS[nextIndex]);
  };

  return (
    <TooltipWrapper>
      <div className="flex items-center gap-2">
        <input
          type="range"
          min="0"
          max="3"
          step="1"
          value={value}
          onChange={(e) =>
            handleThinkingLevelChange(valueToThinkingLevel(parseInt(e.target.value)))
          }
          onMouseEnter={() => setIsHovering(true)}
          onMouseLeave={() => setIsHovering(false)}
          id={sliderId}
          role="slider"
          aria-valuemin={0}
          aria-valuemax={3}
          aria-valuenow={value}
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
