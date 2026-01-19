import React from "react";
import { TokenMeter } from "./TokenMeter";
import { HorizontalThresholdSlider, type AutoCompactionConfig } from "./ThresholdSlider";
import { formatTokens, type TokenMeterData } from "@/common/utils/tokens/tokenMeterUtils";

const OutputReserveIndicator: React.FC<{ threshold: number }> = (props) => {
  const threshold = props.threshold;
  if (threshold <= 0 || threshold >= 100) return null;

  return (
    <div
      className="border-dashed-warning pointer-events-none absolute top-0 z-40 h-full w-0 border-l"
      style={{ left: `${threshold}%` }}
    />
  );
};

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

  const outputReserveThreshold = (() => {
    if (!data.maxTokens || !data.maxOutputTokens) return null;
    if (data.maxOutputTokens <= 0 || data.maxOutputTokens >= data.maxTokens) return null;
    const raw = ((data.maxTokens - data.maxOutputTokens) / data.maxTokens) * 100;
    return Math.max(0, Math.min(100, raw));
  })();

  const outputReserveTokens =
    data.maxTokens && data.maxOutputTokens ? data.maxTokens - data.maxOutputTokens : null;

  const showOutputReserveIndicator = Boolean(
    showThresholdSlider && outputReserveThreshold !== null
  );
  const showOutputReserveWarning = Boolean(
    showThresholdSlider &&
    autoCompaction &&
    autoCompaction.threshold < 100 &&
    outputReserveThreshold !== null &&
    autoCompaction.threshold > outputReserveThreshold
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
        {showOutputReserveIndicator && outputReserveThreshold !== null && (
          <OutputReserveIndicator threshold={outputReserveThreshold} />
        )}
        {showThresholdSlider && <HorizontalThresholdSlider config={autoCompaction} />}
      </div>

      {showOutputReserveIndicator &&
        outputReserveThreshold !== null &&
        outputReserveTokens !== null && (
          <div className="text-muted mt-1 text-[11px]">
            Output reserve starts at {outputReserveThreshold.toFixed(1)}% (
            {formatTokens(outputReserveTokens)} prompt max)
          </div>
        )}

      {showOutputReserveWarning && outputReserveThreshold !== null && (
        <div className="text-warning mt-1 text-[11px]">
          Auto-compact threshold is above the output reserve ({outputReserveThreshold.toFixed(1)}%).
          Requests may hit context_exceeded before auto-compact runs.
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
