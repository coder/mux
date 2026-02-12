import React from "react";
import { cn } from "@/common/lib/utils";

interface BaseBarrierProps {
  text: React.ReactNode;
  color: string;
  animate?: boolean;
  className?: string;
  leadingElement?: React.ReactNode;
}

export const BaseBarrier: React.FC<BaseBarrierProps> = ({
  text,
  color,
  animate = false,
  className,
  leadingElement,
}) => {
  return (
    <div
      className={cn(
        "flex items-center gap-3 py-2 my-1",
        animate ? "animate-pulse opacity-100" : "opacity-60",
        className
      )}
    >
      <div
        className="h-px flex-1 opacity-30"
        style={{
          background: `linear-gradient(to right, transparent, ${color} 20%, ${color} 80%, transparent)`,
        }}
      />
      <div
        className="flex items-center gap-1 font-mono text-[10px] tracking-wide whitespace-nowrap uppercase"
        style={{ color }}
      >
        {leadingElement}
        {text}
      </div>
      <div
        className="h-px flex-1 opacity-30"
        style={{
          background: `linear-gradient(to right, transparent, ${color} 20%, ${color} 80%, transparent)`,
        }}
      />
    </div>
  );
};
