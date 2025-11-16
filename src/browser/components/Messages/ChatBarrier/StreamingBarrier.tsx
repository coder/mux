import React from "react";
import { BaseBarrier } from "./BaseBarrier";

interface StreamingBarrierProps {
  className?: string;
  statusText: string; // e.g., "claude-sonnet-4-5 streaming..."
  cancelText: string; // e.g., "hit Esc to cancel"
  tokenCount?: number;
  tps?: number;
}

export const StreamingBarrier: React.FC<StreamingBarrierProps> = ({
  className,
  statusText,
  cancelText,
  tokenCount,
  tps,
}) => {
  return (
    <div className={`flex items-center justify-between gap-4 ${className ?? ""}`}>
      <div className="flex flex-1 items-center gap-2">
        <BaseBarrier text={statusText} color="var(--color-assistant-border)" animate />
        {tokenCount !== undefined && (
          <span className="text-assistant-border font-mono text-[11px] whitespace-nowrap select-none">
            ~{tokenCount.toLocaleString()} tokens
            {tps !== undefined && tps > 0 && <span className="text-dim ml-1">@ {tps} t/s</span>}
          </span>
        )}
      </div>
      <div className="text-muted ml-auto text-[11px] whitespace-nowrap select-none">
        {cancelText}
      </div>
    </div>
  );
};
