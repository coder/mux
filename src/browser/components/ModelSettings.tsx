import React from "react";
import { useProviderOptions } from "@/browser/hooks/useProviderOptions";
import { supports1MContext } from "@/common/utils/ai/models";
import { TooltipWrapper, Tooltip } from "./Tooltip";

interface ModelSettingsProps {
  model: string;
}

export const ModelSettings: React.FC<ModelSettingsProps> = (props) => {
  const { options, setAnthropicOptions, setOpenAIOptions } = useProviderOptions();

  const renderOption = (
    id: string,
    label: string,
    checked: boolean,
    onChange: (checked: boolean) => void,
    tooltipText: string
  ) => (
    <div className="flex items-center gap-1.5" key={id}>
      <label className="text-foreground flex cursor-pointer items-center gap-1 truncate text-[10px] select-none hover:text-white">
        <input
          type="checkbox"
          className="cursor-pointer"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
        />
        {label}
      </label>
      <TooltipWrapper inline>
        <span className="text-muted flex cursor-help items-center text-[10px] leading-none">?</span>
        <Tooltip className="tooltip" align="center" width="auto">
          {tooltipText}
        </Tooltip>
      </TooltipWrapper>
    </div>
  );

  // 1M context is only available for specific Anthropic models (Sonnet 4/4.5)
  if (supports1MContext(props.model)) {
    return renderOption(
      "anthropic-1m",
      "1M",
      options.anthropic?.use1MContext ?? false,
      (checked) => setAnthropicOptions({ ...options.anthropic, use1MContext: checked }),
      "Enable 1M token context window (beta feature for Claude Sonnet 4/4.5)"
    );
  }

  const provider = props.model.split(":")[0];
  if (provider === "openai") {
    if (import.meta.env.DEV) {
      return renderOption(
        "openai-trunc",
        "No Trunc",
        options.openai?.disableAutoTruncation ?? false,
        (checked) => setOpenAIOptions({ ...options.openai, disableAutoTruncation: checked }),
        "Disable Auto-Truncation (Only visible in Dev mode)"
      );
    }
  }

  return null;
};
