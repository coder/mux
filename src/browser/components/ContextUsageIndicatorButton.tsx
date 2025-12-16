import React from "react";
import { Popover, PopoverTrigger, PopoverContent } from "./ui/popover";
import { Tooltip, TooltipTrigger, TooltipContent } from "./ui/tooltip";
import { ContextUsageBar } from "./RightSidebar/ContextUsageBar";
import { TokenMeter } from "./RightSidebar/TokenMeter";
import type { AutoCompactionConfig } from "./RightSidebar/ThresholdSlider";
import { formatTokens, type TokenMeterData } from "@/common/utils/tokens/tokenMeterUtils";

interface ContextUsageIndicatorButtonProps {
  data: TokenMeterData;
  autoCompaction?: AutoCompactionConfig;
}

export const ContextUsageIndicatorButton: React.FC<ContextUsageIndicatorButtonProps> = ({
  data,
  autoCompaction,
}) => {
  const [popoverOpen, setPopoverOpen] = React.useState(false);

  if (data.totalTokens === 0) return null;

  const ariaLabel = data.maxTokens
    ? `Context usage: ${formatTokens(data.totalTokens)} / ${formatTokens(data.maxTokens)} (${data.totalPercentage.toFixed(
        1
      )}%)`
    : `Context usage: ${formatTokens(data.totalTokens)} (unknown limit)`;

  return (
    <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
      <Tooltip {...(popoverOpen ? { open: false } : {})}>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              aria-label={ariaLabel}
              className="hover:bg-sidebar-hover flex h-6 w-20 cursor-pointer items-center rounded px-1"
              type="button"
            >
              <TokenMeter
                segments={data.segments}
                orientation="horizontal"
                className="h-2"
                trackClassName="bg-dark"
              />
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom" align="end" className="w-80">
          <ContextUsageBar data={data} />
        </TooltipContent>
      </Tooltip>

      <PopoverContent side="bottom" align="end" className="w-80 overflow-visible p-3">
        <ContextUsageBar data={data} autoCompaction={autoCompaction} />
      </PopoverContent>
    </Popover>
  );
};
