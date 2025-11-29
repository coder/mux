import React from "react";
import AnthropicIcon from "@/browser/assets/icons/anthropic.svg?react";
import OpenAIIcon from "@/browser/assets/icons/openai.svg?react";
import AWSIcon from "@/browser/assets/icons/aws.svg?react";
import MuxIcon from "@/browser/assets/icons/mux.svg?react";
import { TooltipWrapper, Tooltip } from "@/browser/components/Tooltip";
import { formatModelDisplayName } from "@/common/utils/ai/modelDisplay";

interface ModelDisplayProps {
  modelString: string;
  /** Whether to show the tooltip on hover (default: true, set to false when used within another tooltip) */
  showTooltip?: boolean;
}

/**
 * Parse a model string into provider and model name.
 * Handles mux-gateway format: "mux-gateway:inner-provider/model-name"
 * Returns: { provider, modelName, isMuxGateway, innerProvider }
 */
function parseModelString(modelString: string): {
  provider: string;
  modelName: string;
  isMuxGateway: boolean;
  innerProvider: string;
} {
  const [provider, rest] = modelString.includes(":")
    ? modelString.split(":", 2)
    : ["", modelString];

  // Handle mux-gateway format: mux-gateway:anthropic/claude-sonnet-4-5
  if (provider === "mux-gateway" && rest.includes("/")) {
    const [innerProvider, modelName] = rest.split("/", 2);
    return { provider, modelName, isMuxGateway: true, innerProvider };
  }

  return { provider, modelName: rest, isMuxGateway: false, innerProvider: "" };
}

/** Get icon component for a provider name */
function getProviderIcon(provider: string): React.ReactNode {
  switch (provider) {
    case "anthropic":
      return <AnthropicIcon />;
    case "openai":
      return <OpenAIIcon />;
    case "bedrock":
      return <AWSIcon />;
    case "mux-gateway":
      return <MuxIcon />;
    default:
      return null;
  }
}

/**
 * Display a model name with its provider icon.
 * Supports format "provider:model-name" (e.g., "anthropic:claude-sonnet-4-5")
 * Also supports mux-gateway: "mux-gateway:anthropic/claude-sonnet-4-5"
 *   -> Shows mux icon + inner provider icon + model name + "(mux gateway)"
 *
 * Uses standard inline layout for natural text alignment.
 * Icon is 1em (matches font size) with vertical-align: middle.
 */
export const ModelDisplay: React.FC<ModelDisplayProps> = ({ modelString, showTooltip = true }) => {
  const { provider, modelName, isMuxGateway, innerProvider } = parseModelString(modelString);

  // For mux-gateway, show the inner provider's icon (the model's actual provider)
  const providerIcon = isMuxGateway ? getProviderIcon(innerProvider) : getProviderIcon(provider);
  const muxIcon = isMuxGateway ? getProviderIcon("mux-gateway") : null;
  const displayName = formatModelDisplayName(modelName);
  const suffix = isMuxGateway ? " (mux gateway)" : "";

  const iconClass =
    "mr-[0.3em] inline-block h-[1.1em] w-[1.1em] align-[-0.19em] [&_svg]:block [&_svg]:h-full [&_svg]:w-full [&_svg_.st0]:fill-current [&_svg_circle]:!fill-current [&_svg_path]:!fill-current [&_svg_rect]:!fill-current";

  const content = (
    <span className="inline normal-case" data-model-display>
      {muxIcon && (
        <span className={iconClass} data-model-icon="mux">
          {muxIcon}
        </span>
      )}
      {providerIcon && (
        <span className={iconClass} data-model-icon>
          {providerIcon}
        </span>
      )}
      <span className="inline">
        {displayName}
        {suffix}
      </span>
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
