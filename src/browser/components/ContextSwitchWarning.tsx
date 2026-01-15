import React from "react";
import { X } from "lucide-react";
import { getModelName } from "@/common/utils/ai/models";
import type { ContextSwitchWarning as WarningData } from "@/browser/utils/compaction/contextSwitchCheck";

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(".0", "")}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}

interface Props {
  warning: WarningData;
  onCompact: () => void;
  onDismiss: () => void;
}

/**
 * Warning banner shown when user switches to a model that can't fit the current context.
 */
export const ContextSwitchWarning: React.FC<Props> = ({ warning, onCompact, onDismiss }) => {
  const targetName = getModelName(warning.targetModel);
  const compactName = warning.compactionModel ? getModelName(warning.compactionModel) : null;

  return (
    <div className="bg-plan-mode/10 border-plan-mode/30 mx-4 my-2 rounded-md border px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1">
          <div className="text-plan-mode mb-1 flex items-center gap-2 text-[13px] font-medium">
            <span>⚠️</span>
            <span>Context May Exceed Model Limit</span>
          </div>
          <p className="text-foreground/80 text-[12px] leading-relaxed">
            Current context ({formatTokens(warning.currentTokens)} tokens) is near the{" "}
            <span className="font-medium">{targetName}</span> limit (
            {formatTokens(warning.targetLimit)}). Consider compacting before sending.
          </p>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="text-muted hover:text-foreground -mt-1 -mr-1 cursor-pointer p-1"
          title="Dismiss"
        >
          <X size={14} />
        </button>
      </div>
      <div className="mt-2.5 flex items-center gap-3">
        {warning.errorMessage ? (
          <span className="text-error text-[12px]">{warning.errorMessage}</span>
        ) : (
          <button
            type="button"
            onClick={onCompact}
            className="bg-plan-mode/20 hover:bg-plan-mode/30 text-plan-mode cursor-pointer rounded px-3 py-1.5 text-[12px] font-medium transition-colors"
          >
            Compact with {compactName}
          </button>
        )}
      </div>
    </div>
  );
};
