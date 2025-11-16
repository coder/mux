import React from "react";
import { BaseBarrier } from "./BaseBarrier";

interface InterruptedBarrierProps {
  className?: string;
}

export const InterruptedBarrier: React.FC<InterruptedBarrierProps> = ({ className }) => {
  return <BaseBarrier text="interrupted" color="var(--color-interrupted)" className={className} />;
};
