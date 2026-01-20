import React from "react";

export interface OutputReserveIndicatorProps {
  threshold: number;
}

export const OutputReserveIndicator: React.FC<OutputReserveIndicatorProps> = (props) => {
  const threshold = props.threshold;
  if (threshold <= 0 || threshold >= 100) return null;

  return (
    <div
      className="border-dashed-warning pointer-events-none absolute top-0 z-40 h-full w-0 border-l"
      style={{ left: `${threshold}%` }}
    />
  );
};
