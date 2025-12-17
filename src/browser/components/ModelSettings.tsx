import React from "react";
import { Settings } from "lucide-react";
import { useProviderOptions } from "@/browser/hooks/useProviderOptions";
import { supports1MContext } from "@/common/utils/ai/models";
import { Popover, PopoverTrigger, PopoverContent } from "./ui/popover";
import { Tooltip, TooltipTrigger, TooltipContent } from "./ui/tooltip";

interface ModelSettingsProps {
  model: string;
}

interface OptionConfig {
  id: string;
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  tooltipText: string;
}

export const ModelSettings: React.FC<ModelSettingsProps> = (props) => {
  const { options, setAnthropicOptions, setOpenAIOptions } = useProviderOptions();
  const [popoverOpen, setPopoverOpen] = React.useState(false);

  // Collect all applicable options for this model
  const applicableOptions: OptionConfig[] = [];

  // 1M context is only available for specific Anthropic models (Sonnet 4/4.5)
  if (supports1MContext(props.model)) {
    applicableOptions.push({
      id: "anthropic-1m",
      label: "1M",
      checked: options.anthropic?.use1MContext ?? false,
      onChange: (checked) => setAnthropicOptions({ ...options.anthropic, use1MContext: checked }),
      tooltipText: "Enable 1M token context window (beta feature for Claude Sonnet 4/4.5)",
    });
  }

  const provider = props.model.split(":")[0];
  if (provider === "openai" && import.meta.env.DEV) {
    applicableOptions.push({
      id: "openai-trunc",
      label: "No Trunc",
      checked: options.openai?.disableAutoTruncation ?? false,
      onChange: (checked) =>
        setOpenAIOptions({ ...options.openai, disableAutoTruncation: checked }),
      tooltipText: "Disable Auto-Truncation (Only visible in Dev mode)",
    });
  }

  // Don't render anything if no options are applicable
  if (applicableOptions.length === 0) {
    return null;
  }

  return (
    <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
      <Tooltip {...(popoverOpen ? { open: false } : {})}>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label="Model options"
              className="text-muted hover:text-foreground flex h-5 w-5 cursor-pointer items-center justify-center rounded transition-colors"
            >
              <Settings className="h-3.5 w-3.5" />
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>Model options</TooltipContent>
      </Tooltip>

      <PopoverContent side="top" align="start" className="w-auto min-w-[140px] p-2">
        <div className="flex flex-col gap-2">
          {applicableOptions.map((opt) => (
            <div className="flex items-center gap-1.5" key={opt.id}>
              <label className="text-foreground flex cursor-pointer items-center gap-1.5 text-xs select-none hover:text-white">
                <input
                  type="checkbox"
                  className="cursor-pointer"
                  checked={opt.checked}
                  onChange={(e) => opt.onChange(e.target.checked)}
                />
                {opt.label}
              </label>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="text-muted flex cursor-help items-center text-[10px] leading-none">
                    ?
                  </span>
                </TooltipTrigger>
                <TooltipContent align="center">{opt.tooltipText}</TooltipContent>
              </Tooltip>
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
};
