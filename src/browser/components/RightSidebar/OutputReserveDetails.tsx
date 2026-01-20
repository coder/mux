import React from "react";
import { formatTokens } from "@/common/utils/tokens/tokenMeterUtils";
import type { OutputReserveInfo } from "./contextUsageUtils";

export interface OutputReserveDetailsProps {
  info: OutputReserveInfo;
  showDetails: boolean;
  showWarning: boolean;
  detailClassName: string;
  warningClassName: string;
}

export const OutputReserveDetails: React.FC<OutputReserveDetailsProps> = (props) => {
  const threshold = props.info.threshold;
  const tokens = props.info.tokens;

  return (
    <>
      {props.showDetails && threshold !== null && tokens !== null && (
        <div className={props.detailClassName}>
          Output reserve starts at {threshold.toFixed(1)}% ({formatTokens(tokens)} prompt max)
        </div>
      )}
      {props.showWarning && threshold !== null && (
        <div className={props.warningClassName}>
          Auto-compact threshold is above the output reserve ({threshold.toFixed(1)}%). Requests may
          hit context_exceeded before auto-compact runs.
        </div>
      )}
    </>
  );
};
