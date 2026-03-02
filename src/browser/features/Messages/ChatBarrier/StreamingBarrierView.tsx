import React from "react";
import { CircleStopIcon } from "lucide-react";

import { BaseBarrier } from "./BaseBarrier";

export interface StreamingBarrierViewProps {
  statusText: string;
  tokenCount?: number;
  tps?: number;
  cancelText: string;
  /** Optional click handler that turns cancelText into a tappable control. */
  onCancel?: () => void;
  /** Optional keyboard hint shown inline on larger screens (e.g., "Esc"). */
  cancelShortcutText?: string;
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
          <span className="text-assistant-border inline-flex min-w-[14ch] items-baseline justify-end font-mono text-[11px] whitespace-nowrap tabular-nums select-none">
            <span>~{props.tokenCount.toLocaleString()} tokens</span>
            <span className="text-dim ml-1 inline-block min-w-[7ch] text-right">
              @ {props.tps !== undefined && props.tps > 0 ? props.tps : "--"} t/s
            </span>
          </span>
        )}
      </div>
      <div className="ml-auto">
        {props.onCancel && props.cancelText.length > 0 ? (
          <button
            type="button"
            onClick={props.onCancel}
            title={props.cancelShortcutText}
            className="text-muted hover:text-foreground inline-flex h-6 cursor-pointer items-center rounded-sm px-1.5 py-0.5 text-[11px] leading-none font-medium transition-colors duration-200"
            aria-label="Stop streaming"
          >
            <CircleStopIcon className="h-3.5 w-3.5 shrink-0" strokeWidth={2.2} />
            <span className="ml-1 leading-none">Stop</span>
            {props.cancelShortcutText && (
              <span className="border-border-medium text-muted ml-2 hidden items-center rounded border px-1 py-[1px] text-[10px] leading-none sm:inline-flex">
                {props.cancelShortcutText}
              </span>
            )}
          </button>
        ) : (
          <span className="text-muted text-[11px] whitespace-nowrap select-none">
            {props.cancelText}
          </span>
        )}
      </div>
    </div>
  );
};
