import React from "react";
import { useAutoCompactionSettings } from "@/browser/hooks/useAutoCompactionSettings";
import { useClampedNumberInput } from "@/browser/hooks/useClampedNumberInput";
import {
  AUTO_COMPACTION_THRESHOLD_MIN,
  AUTO_COMPACTION_THRESHOLD_MAX,
} from "@/common/constants/ui";
import { TooltipWrapper, Tooltip, HelpIndicator } from "../Tooltip";

interface AutoCompactionSettingsProps {
  workspaceId: string;
}

export const AutoCompactionSettings: React.FC<AutoCompactionSettingsProps> = ({ workspaceId }) => {
  const { enabled, setEnabled, threshold, setThreshold } = useAutoCompactionSettings(workspaceId);
  const { localValue, handleChange, handleBlur } = useClampedNumberInput(
    threshold,
    setThreshold,
    AUTO_COMPACTION_THRESHOLD_MIN,
    AUTO_COMPACTION_THRESHOLD_MAX
  );

  return (
    <div data-testid="auto-compaction-settings" className="mb-6">
      <div className="flex items-baseline justify-between">
        {/* Left side: checkbox + label + tooltip */}
        <div className="flex items-baseline gap-1">
          <label className="text-foreground flex cursor-pointer items-baseline gap-1.5 font-medium select-none hover:text-white">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              className="cursor-pointer"
            />
            Auto-Compaction
          </label>
          <TooltipWrapper inline>
            <HelpIndicator>?</HelpIndicator>
            <Tooltip className="tooltip" align="center" width="auto">
              Automatically compact conversation history when context usage reaches the threshold
            </Tooltip>
          </TooltipWrapper>
        </div>

        {/* Right side: input + % symbol */}
        <div className="flex items-baseline gap-0.5">
          <input
            type="number"
            min={AUTO_COMPACTION_THRESHOLD_MIN}
            max={AUTO_COMPACTION_THRESHOLD_MAX}
            step={5}
            maxLength={2}
            value={localValue}
            onChange={handleChange}
            onBlur={handleBlur}
            disabled={!enabled}
            className="text-muted w-9 [appearance:textfield] border-none bg-transparent text-right text-xs outline-none disabled:cursor-not-allowed disabled:opacity-40 [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
            aria-label="Auto-compaction threshold percentage"
          />
          <span className="text-muted text-xs">%</span>
        </div>
      </div>
    </div>
  );
};
