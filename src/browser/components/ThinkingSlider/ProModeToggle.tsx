import React from "react";
import { normalizeToCanonical } from "@/common/utils/ai/models";
import { openaiProModeAvailable } from "@/common/utils/ai/proMode";
import { useProvidersConfig } from "@/browser/hooks/useProvidersConfig";
import { useReasoningMode } from "@/browser/hooks/useReasoningMode";
import { useRouting } from "@/browser/hooks/useRouting";
import { Tooltip, TooltipTrigger, TooltipContent } from "../Tooltip/Tooltip";

interface ProModeToggleProps {
  modelString: string;
}

/**
 * Small "PRO" toggle for OpenAI's pro reasoning mode (GPT-5.6 family).
 * Renders nothing for models without pro-mode support and for gateway routes
 * where the native provider option is not delivered — otherwise the toggle would
 * persist a setting that can never affect the request. An explicit gateway
 * prefix (openrouter:openai/...) only hides the toggle while that gateway can
 * win the route; when it is disabled/unconfigured the backend falls back to
 * the resolved route, which openaiProModeAvailable re-checks.
 */
export const ProModeToggle: React.FC<ProModeToggleProps> = (props) => {
  const [reasoningMode, setReasoningMode] = useReasoningMode();
  // Availability mirrors the send path (see openaiProModeAvailable): hides for
  // chatCompletions wire format, gateway routes, and Codex OAuth auth.
  const { config: providersConfig } = useProvidersConfig();
  const routing = useRouting();
  const resolvedRoute = routing.resolveRoute(normalizeToCanonical(props.modelString)).route;

  if (
    !openaiProModeAvailable(props.modelString, {
      providersConfig,
      resolvedRouteProvider: resolvedRoute,
    })
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
