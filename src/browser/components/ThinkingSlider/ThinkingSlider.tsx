import React from "react";
import { getThinkingDisplayLabel } from "@/common/types/thinking";
import { useThinkingLevel } from "@/browser/hooks/useThinkingLevel";
import { useMinThinkingLevels } from "@/browser/hooks/useMinThinkingLevels";
import { useProvidersConfig } from "@/browser/hooks/useProvidersConfig";
import { Tooltip, TooltipTrigger, TooltipContent } from "../Tooltip/Tooltip";
import { formatKeybind, KEYBINDS } from "@/browser/utils/ui/keybinds";
import { enforceThinkingPolicy, getAvailableThinkingLevels } from "@/common/utils/thinking/policy";
import { cn } from "@/common/lib/utils";

// Fixed width prevents the pill from resizing as the thinking level changes.
const THINKING_LABEL_CLASSES =
  "text-foreground w-[5ch] shrink-0 text-center text-[11px] font-medium select-none";

interface ThinkingControlProps {
  modelString: string;
}

export const ThinkingSliderComponent: React.FC<ThinkingControlProps> = ({ modelString }) => {
  const [thinkingLevel, setThinkingLevel] = useThinkingLevel();
  // Apply the per-model minimum floor so off/low are hidden unless the user lowers it
  // in Models settings. The floor must match the backend send-path enforcement.
  const { getMinimum } = useMinThinkingLevels();
  // Resolve mapped aliases so the slider offers the target model's ladder
  // (e.g. an alias mapped to GPT-5.6 exposes native max).
  const { config: providersConfig } = useProvidersConfig();
  const minimum = getMinimum(modelString);
  const allowed = getAvailableThinkingLevels(modelString, minimum, providersConfig);
  const effectiveThinkingLevel = enforceThinkingPolicy(
    modelString,
    thinkingLevel,
    minimum,
    providersConfig
  );

  // Map current level to index within the *allowed* subset
  const currentIndex = allowed.indexOf(effectiveThinkingLevel);

  const displayLabel = getThinkingDisplayLabel(effectiveThinkingLevel, modelString);

  if (allowed.length <= 1) {
    const fixedLevel = allowed[0] || "off";
    const tooltipMessage = `Model ${modelString} locks thinking at ${getThinkingDisplayLabel(fixedLevel, modelString)} to match its capabilities.`;

    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={THINKING_LABEL_CLASSES}
            aria-label={`Thinking level fixed to ${fixedLevel}`}
          >
            {getThinkingDisplayLabel(fixedLevel, modelString)}
          </span>
        </TooltipTrigger>
        <TooltipContent align="center">{tooltipMessage}</TooltipContent>
      </Tooltip>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => {
            const nextIndex = (currentIndex + 1) % allowed.length;
            setThinkingLevel(allowed[nextIndex]);
          }}
          data-thinking-label
          className={cn(
            THINKING_LABEL_CLASSES,
            "hover:bg-hover focus-visible:ring-accent cursor-pointer rounded-sm bg-transparent p-0 transition-colors focus-visible:ring-1"
          )}
          aria-live="polite"
          aria-label={`Thinking level: ${effectiveThinkingLevel}. Click to cycle.`}
        >
          {displayLabel}
        </button>
      </TooltipTrigger>
      <TooltipContent align="center">
        Thinking: click to cycle.{" "}
        <span className="mobile-hide-shortcut-hints">
          {formatKeybind(KEYBINDS.DECREASE_THINKING)} / {formatKeybind(KEYBINDS.INCREASE_THINKING)}{" "}
          to step.{" "}
        </span>
        Saved per workspace.
      </TooltipContent>
    </Tooltip>
  );
};
