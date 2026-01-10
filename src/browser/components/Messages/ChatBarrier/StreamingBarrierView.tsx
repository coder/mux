import React from "react";

import { BaseBarrier } from "./BaseBarrier";

export interface StreamingBarrierViewProps {
  statusText: string;
  tokenCount?: number;
  tps?: number;
  cancelText: string;
  className?: string;
  /** Optional hint element shown after status (e.g., settings link) */
  hintElement?: React.ReactNode;
}

/**
 * Presentation-only StreamingBarrier.
 *
 * Keep this file free of WorkspaceStore imports so it can be reused by alternate
 * frontends (e.g. the VS Code webview) without pulling in the desktop state layer.
 */
export const StreamingBarrierView: React.FC<StreamingBarrierViewProps> = (props) => {
  return (
    <div className={`flex items-center justify-between gap-4 ${props.className ?? ""}`}>
      <div className="flex flex-1 items-center gap-2">
        <BaseBarrier text={props.statusText} color="var(--color-assistant-border)" animate />
        {props.hintElement}
        {props.tokenCount !== undefined && (
          <span className="text-assistant-border font-mono text-[11px] whitespace-nowrap select-none">
            ~{props.tokenCount.toLocaleString()} tokens
            {props.tps !== undefined && props.tps > 0 && (
              <span className="text-dim ml-1">@ {props.tps} t/s</span>
            )}
          </span>
        )}
      </div>
      <div className="text-muted ml-auto text-[11px] whitespace-nowrap select-none">
        {props.cancelText}
      </div>
    </div>
  );
};
