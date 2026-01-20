import React from "react";
import { TokenMeter } from "./TokenMeter";
import { HorizontalThresholdSlider, type AutoCompactionConfig } from "./ThresholdSlider";
import { formatTokens, type TokenMeterData } from "@/common/utils/tokens/tokenMeterUtils";
import { OutputReserveIndicator } from "./OutputReserveIndicator";
import { getOutputReserveInfo } from "./contextUsageUtils";

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
  const totalDisplay = formatTokens(data.totalTokens);
  const maxDisplay = data.maxTokens ? ` / ${formatTokens(data.maxTokens)}` : "";
  const percentageDisplay = data.maxTokens ? ` (${data.totalPercentage.toFixed(1)}%)` : "";

  const showWarning = !data.maxTokens;
  const showThresholdSlider = autoCompaction && data.maxTokens;

  const outputReserveInfo = getOutputReserveInfo(data);

  const showOutputReserveIndicator = Boolean(
    showThresholdSlider && outputReserveInfo.threshold !== null
  );
  const showOutputReserveWarning = Boolean(
    showThresholdSlider &&
    autoCompaction &&
    autoCompaction.threshold < 100 &&
    outputReserveInfo.threshold !== null &&
    autoCompaction.threshold > outputReserveInfo.threshold
  );

  if (data.totalTokens === 0) return null;

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
        {showOutputReserveIndicator && outputReserveInfo.threshold !== null && (
          <OutputReserveIndicator threshold={outputReserveInfo.threshold} />
        )}
        {showThresholdSlider && <HorizontalThresholdSlider config={autoCompaction} />}
      </div>

      {showOutputReserveIndicator &&
        outputReserveInfo.threshold !== null &&
        outputReserveInfo.tokens !== null && (
          <div className="text-muted mt-1 text-[11px]">
            Output reserve starts at {outputReserveInfo.threshold.toFixed(1)}% (
            {formatTokens(outputReserveInfo.tokens)} prompt max)
          </div>
        )}

      {showOutputReserveWarning && outputReserveInfo.threshold !== null && (
        <div className="text-warning mt-1 text-[11px]">
          Auto-compact threshold is above the output reserve (
          {outputReserveInfo.threshold.toFixed(1)}%). Requests may hit context_exceeded before
          auto-compact runs.
        </div>
      )}

      {showWarning && (
        <div className="text-subtle mt-2 text-[11px] italic">
          Unknown model limits - showing relative usage only
        </div>
      )}
    </div>
  );
};

export const ContextUsageBar = React.memo(ContextUsageBarComponent);
