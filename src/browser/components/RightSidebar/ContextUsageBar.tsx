import React from "react";
import { TokenMeter } from "./TokenMeter";
import {
  HorizontalThresholdSlider,
  HorizontalThresholdIndicator,
  type AutoCompactionConfig,
} from "./ThresholdSlider";
import { formatTokens, type TokenMeterData } from "@/common/utils/tokens/tokenMeterUtils";

interface ContextUsageBarProps {
  data: TokenMeterData;
  /** Auto-compaction settings for threshold slider */
  autoCompaction?: AutoCompactionConfig;
  /** Show text-only indicator for auto-compaction threshold (for tooltips) */
  autoCompactionThreshold?: number;
  showTitle?: boolean;
  testId?: string;
}

const ContextUsageBarComponent: React.FC<ContextUsageBarProps> = ({
  data,
  autoCompaction,
  autoCompactionThreshold,
  showTitle = true,
  testId,
}) => {
  if (data.totalTokens === 0) return null;

  const totalDisplay = formatTokens(data.totalTokens);
  const maxDisplay = data.maxTokens ? ` / ${formatTokens(data.maxTokens)}` : "";
  const percentageDisplay = data.maxTokens ? ` (${data.totalPercentage.toFixed(1)}%)` : "";

  const showWarning = !data.maxTokens;

  // Show read-only indicator when threshold provided but no interactive config
  const showReadOnlyIndicator =
    autoCompactionThreshold !== undefined && !autoCompaction && data.maxTokens;

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

      <div className="relative w-full py-2">
        <TokenMeter segments={data.segments} orientation="horizontal" />
        {autoCompaction && data.maxTokens && <HorizontalThresholdSlider config={autoCompaction} />}
        {showReadOnlyIndicator && (
          <HorizontalThresholdIndicator threshold={autoCompactionThreshold} />
        )}
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
