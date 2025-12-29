import React from "react";
import { TokenMeter } from "./TokenMeter";
import { HorizontalThresholdSlider, type AutoCompactionConfig } from "./ThresholdSlider";
import { formatTokens, type TokenMeterData } from "@/common/utils/tokens/tokenMeterUtils";

interface ContextUsageBarProps {
  data: TokenMeterData;
  /** Auto-compaction settings for threshold slider */
  autoCompaction?: AutoCompactionConfig;
  showTitle?: boolean;
  testId?: string;
}

const ContextUsageBarComponent: React.FC<ContextUsageBarProps> = ({
  data,
  autoCompaction,
  showTitle = true,
  testId,
}) => {
  if (data.totalTokens === 0) return null;

  const totalDisplay = formatTokens(data.totalTokens);
  const maxDisplay = data.maxTokens ? ` / ${formatTokens(data.maxTokens)}` : "";
  const percentageDisplay = data.maxTokens ? ` (${data.totalPercentage.toFixed(1)}%)` : "";

  const showWarning = !data.maxTokens;

  return (
    <div data-testid={testId} className="relative flex flex-col gap-1">
      <div className="flex items-baseline justify-between">
        {showTitle && (
          <span className="text-foreground inline-flex items-baseline gap-1 font-medium">
            Context Usage
          </span>
        )}
        <span className="text-muted text-xs">
          {totalDisplay}
          {maxDisplay}
          {percentageDisplay}
        </span>
      </div>

      <div className="relative w-full overflow-hidden py-2">
        <TokenMeter segments={data.segments} orientation="horizontal" />
        {autoCompaction && data.maxTokens && <HorizontalThresholdSlider config={autoCompaction} />}
      </div>

      {showWarning && (
        <div className="text-subtle mt-2 text-[11px] italic">
          Unknown model limits - showing relative usage only
        </div>
      )}
    </div>
  );
};

export const ContextUsageBar = React.memo(ContextUsageBarComponent);
