import React from "react";
import AnthropicIcon from "@/assets/icons/anthropic.svg?react";
import OpenAIIcon from "@/assets/icons/openai.svg?react";
import { TooltipWrapper, Tooltip } from "@/browser/components/Tooltip";
import { formatModelDisplayName } from "@/utils/ai/modelDisplay";

interface ModelDisplayProps {
  modelString: string;
  /** Whether to show the tooltip on hover (default: true, set to false when used within another tooltip) */
  showTooltip?: boolean;
}

/**
 * Display a model name with its provider icon.
 * Supports format "provider:model-name" (e.g., "anthropic:claude-sonnet-4-5")
 *
 * Uses standard inline layout for natural text alignment.
 * Icon is 1em (matches font size) with vertical-align: middle.
 */
export const ModelDisplay: React.FC<ModelDisplayProps> = ({ modelString, showTooltip = true }) => {
  const [provider, modelName] = modelString.includes(":")
    ? modelString.split(":", 2)
    : ["", modelString];

  // Map provider names to their icons
  const getProviderIcon = () => {
    switch (provider) {
      case "anthropic":
        return <AnthropicIcon />;
      case "openai":
        return <OpenAIIcon />;
      default:
        return null;
    }
  };

  const providerIcon = getProviderIcon();
  const displayName = formatModelDisplayName(modelName);

  const content = (
    <span className="inline normal-case" data-model-display>
      {providerIcon && (
        <span
          className="mr-[0.3em] inline-block h-[1.1em] w-[1.1em] align-[-0.19em] [&_svg]:block [&_svg]:h-full [&_svg]:w-full [&_svg_.st0]:fill-current [&_svg_circle]:!fill-current [&_svg_path]:!fill-current [&_svg_rect]:!fill-current"
          data-model-icon
        >
          {providerIcon}
        </span>
      )}
      <span className="inline">{displayName}</span>
    </span>
  );

  if (!showTooltip) {
    return content;
  }

  return (
    <TooltipWrapper inline data-model-display-tooltip>
      {content}
      <Tooltip align="center" data-model-tooltip-text>
        {modelString}
      </Tooltip>
    </TooltipWrapper>
  );
};
