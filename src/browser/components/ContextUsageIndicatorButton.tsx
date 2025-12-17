import React from "react";
import { Popover, PopoverTrigger, PopoverContent } from "./ui/popover";
import { Tooltip, TooltipTrigger, TooltipContent } from "./ui/tooltip";
import { ContextUsageBar } from "./RightSidebar/ContextUsageBar";
import { TokenMeter } from "./RightSidebar/TokenMeter";
import type { AutoCompactionConfig } from "./RightSidebar/ThresholdSlider";
import { formatTokens, type TokenMeterData } from "@/common/utils/tokens/tokenMeterUtils";

/** Compact threshold tick mark for the button view */
const CompactThresholdIndicator: React.FC<{ threshold: number }> = ({ threshold }) => {
  if (threshold >= 100) return null;

  return (
    <div
      className="bg-plan-mode pointer-events-none absolute top-0 z-50 h-full w-px"
      style={{ left: `${threshold}%` }}
    />
  );
};

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

  const isAutoCompactionEnabled = autoCompaction && autoCompaction.threshold < 100;

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
              className="hover:bg-sidebar-hover flex h-6 cursor-pointer items-center rounded px-1"
              type="button"
            >
              <div className="relative h-2 w-20">
                <TokenMeter
                  segments={data.segments}
                  orientation="horizontal"
                  className="h-2"
                  trackClassName="bg-dark"
                />
                {isAutoCompactionEnabled && (
                  <CompactThresholdIndicator threshold={autoCompaction.threshold} />
                )}
              </div>
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom" align="end" className="w-80">
          <ContextUsageBar data={data} autoCompactionThreshold={autoCompaction?.threshold} />
        </TooltipContent>
      </Tooltip>

      <PopoverContent side="bottom" align="end" className="w-80 overflow-visible p-3">
        <ContextUsageBar data={data} autoCompaction={autoCompaction} />
      </PopoverContent>
    </Popover>
  );
};
