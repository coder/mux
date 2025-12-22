import React from "react";
import { BaseBarrier } from "./BaseBarrier";
import { getModelName } from "@/common/utils/ai/models";
import { formatKeybind, KEYBINDS } from "@/browser/utils/ui/keybinds";
import { VIM_ENABLED_KEY, getModelKey } from "@/common/constants/storage";
import { readPersistedState } from "@/browser/hooks/usePersistedState";
import { useWorkspaceState, useWorkspaceAggregator } from "@/browser/stores/WorkspaceStore";
import { getDefaultModel } from "@/browser/hooks/useModelsFromSettings";

type StreamingPhase =
  | "starting" // Message sent, waiting for stream-start
  | "interrupting" // User triggered interrupt, waiting for stream-abort
  | "streaming" // Normal streaming
  | "compacting" // Compaction in progress
  | "awaiting-input"; // ask_user_question waiting for response

interface StreamingBarrierProps {
  workspaceId: string;
  className?: string;
}

/**
 * Self-contained streaming status barrier.
 * Computes all state internally from workspaceId - no props drilling needed.
 * Returns null when there's nothing to show.
 */
export const StreamingBarrier: React.FC<StreamingBarrierProps> = ({ workspaceId, className }) => {
  const workspaceState = useWorkspaceState(workspaceId);
  const aggregator = useWorkspaceAggregator(workspaceId);

  const { canInterrupt, isCompacting, awaitingUserQuestion, currentModel, pendingStreamStartTime } =
    workspaceState;

  // Determine if we're in "starting" phase (message sent, waiting for stream-start)
  const isStarting = pendingStreamStartTime !== null && !canInterrupt;

  // Compute streaming phase
  const phase: StreamingPhase | null = (() => {
    if (isStarting) return "starting";
    if (!canInterrupt) return null;
    if (aggregator?.hasInterruptingStream()) return "interrupting";
    if (awaitingUserQuestion) return "awaiting-input";
    if (isCompacting) return "compacting";
    return "streaming";
  })();

  // Only show token count during active streaming/compacting
  const showTokenCount = phase === "streaming" || phase === "compacting";

  // Get live streaming stats from workspace state (updated on each stream-delta)
  const tokenCount = showTokenCount ? workspaceState.streamingTokenCount : undefined;
  const tps = showTokenCount ? workspaceState.streamingTPS : undefined;

  // Nothing to show
  if (!phase) return null;

  // Model to display: for "starting" read from localStorage (cheap), otherwise use currentModel
  const model =
    phase === "starting"
      ? (readPersistedState<string | null>(getModelKey(workspaceId), null) ?? getDefaultModel())
      : currentModel;
  const modelName = model ? getModelName(model) : null;

  // Vim mode affects cancel keybind hint (read once per render, no subscription needed)
  const vimEnabled = readPersistedState(VIM_ENABLED_KEY, false);

  // Compute status text based on phase
  const statusText = (() => {
    switch (phase) {
      case "starting":
        return modelName ? `${modelName} starting...` : "starting...";
      case "interrupting":
        return "interrupting...";
      case "awaiting-input":
        return "Awaiting your input...";
      case "compacting":
        return modelName ? `${modelName} compacting...` : "compacting...";
      case "streaming":
        return modelName ? `${modelName} streaming...` : "streaming...";
    }
  })();

  // Compute cancel hint based on phase
  const cancelText = (() => {
    switch (phase) {
      case "starting":
      case "interrupting":
        return "";
      case "awaiting-input":
        return "type a message to respond";
      case "compacting":
      case "streaming":
        return `hit ${formatKeybind(vimEnabled ? KEYBINDS.INTERRUPT_STREAM_VIM : KEYBINDS.INTERRUPT_STREAM_NORMAL)} to cancel`;
    }
  })();

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
