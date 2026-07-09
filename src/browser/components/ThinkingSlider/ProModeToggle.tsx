import React from "react";
import { openaiSupportsProMode } from "@/common/types/thinking";
import { useReasoningMode } from "@/browser/hooks/useReasoningMode";
import { Tooltip, TooltipTrigger, TooltipContent } from "../Tooltip/Tooltip";

interface ProModeToggleProps {
  modelString: string;
}

/**
 * Small "PRO" toggle for OpenAI's pro reasoning mode (GPT-5.6 Sol/Terra only).
 * Renders nothing for models without pro-mode support; the persisted setting
 * stays inert for them (header gating guarantees wire-level inertness).
 */
export const ProModeToggle: React.FC<ProModeToggleProps> = (props) => {
  const [reasoningMode, setReasoningMode] = useReasoningMode();

  if (!openaiSupportsProMode(props.modelString)) {
    return null;
  }

  const isActive = reasoningMode === "pro";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          data-component="ProModeToggle"
          data-pro-mode-toggle
          aria-pressed={isActive}
          aria-label={`Pro reasoning mode: ${isActive ? "on" : "off"}. Click to toggle.`}
          onClick={() => setReasoningMode(isActive ? "standard" : "pro")}
          className="hover:bg-hover shrink-0 rounded-sm bg-transparent px-1 text-center text-[11px] transition-all duration-200 select-none"
          style={
            isActive
              ? { color: "var(--color-thinking-mode)", fontWeight: 700 }
              : { color: "var(--color-text-secondary)", fontWeight: 400 }
          }
        >
          PRO
        </button>
      </TooltipTrigger>
      <TooltipContent align="center">
        Pro reasoning mode: slower, more thorough responses. Saved per workspace.
      </TooltipContent>
    </Tooltip>
  );
};
