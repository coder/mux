import React from "react";
import { normalizeToCanonical, openaiProModeAvailable } from "@/common/utils/ai/models";
import { useProvidersConfig } from "@/browser/hooks/useProvidersConfig";
import { useReasoningMode } from "@/browser/hooks/useReasoningMode";
import { useRouting } from "@/browser/hooks/useRouting";
import { Tooltip, TooltipTrigger, TooltipContent } from "../Tooltip/Tooltip";

interface ProModeToggleProps {
  modelString: string;
}

/**
 * Small "PRO" toggle for OpenAI's pro reasoning mode (GPT-5.6 Sol/Terra only).
 * Renders nothing for models without pro-mode support and for explicit
 * non-passthrough gateway routes (OpenRouter, github-copilot) where the
 * pro-mode header is never emitted — otherwise the toggle would persist a
 * setting that can never affect the request.
 */
export const ProModeToggle: React.FC<ProModeToggleProps> = (props) => {
  const [reasoningMode, setReasoningMode] = useReasoningMode();
  // Pro mode is Responses-only: hide when the OpenAI provider is configured
  // for chatCompletions, where the wire never carries reasoning.mode.
  const { config: providersConfig } = useProvidersConfig();
  // Also hide when routing settings resolve this model to a non-passthrough
  // gateway (OpenRouter, github-copilot) — those routes never emit the header.
  const routing = useRouting();
  const resolvedRoute = routing.resolveRoute(normalizeToCanonical(props.modelString)).route;

  if (
    !openaiProModeAvailable(props.modelString, providersConfig?.openai?.wireFormat, resolvedRoute)
  ) {
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
