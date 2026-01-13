import React from "react";
import { StreamingBarrierView } from "./StreamingBarrierView";
import { getModelName } from "@/common/utils/ai/models";
import { formatKeybind, KEYBINDS } from "@/browser/utils/ui/keybinds";
import {
  VIM_ENABLED_KEY,
  getModelKey,
  PREFERRED_COMPACTION_MODEL_KEY,
} from "@/common/constants/storage";
import { readPersistedState, readPersistedString } from "@/browser/hooks/usePersistedState";
import { useWorkspaceState, useWorkspaceAggregator } from "@/browser/stores/WorkspaceStore";
import { getDefaultModel } from "@/browser/hooks/useModelsFromSettings";
import { useSettings } from "@/browser/contexts/SettingsContext";

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
  const { open: openSettings } = useSettings();

  const {
    canInterrupt,
    isCompacting,
    awaitingUserQuestion,
    currentModel,
    pendingStreamStartTime,
    pendingCompactionModel,
  } = workspaceState;

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

  // Model to display:
  // - "starting" phase with pending compaction: use the compaction model from the request
  // - "starting" phase without compaction: read chat model from localStorage
  // - Otherwise: use currentModel from active stream
  const model =
    phase === "starting"
      ? (pendingCompactionModel ??
        readPersistedState<string | null>(getModelKey(workspaceId), null) ??
        getDefaultModel())
      : currentModel;
  const modelName = model ? getModelName(model) : null;

  // Vim mode affects cancel keybind hint (read once per render, no subscription needed)
  const vimEnabled = readPersistedState(VIM_ENABLED_KEY, false);
  const interruptKeybind = formatKeybind(
    vimEnabled ? KEYBINDS.INTERRUPT_STREAM_VIM : KEYBINDS.INTERRUPT_STREAM_NORMAL
  );
  const interruptHint = `hit ${interruptKeybind} to cancel`;

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
      case "interrupting":
        return "";
      case "awaiting-input":
        return "type a message to respond";
      case "starting":
      case "compacting":
      case "streaming":
        return interruptHint;
    }
  })();

  // Show settings hint during compaction if no custom compaction model is configured
  const showCompactionHint =
    phase === "compacting" && !readPersistedString(PREFERRED_COMPACTION_MODEL_KEY);

  return (
    <StreamingBarrierView
      statusText={statusText}
      tokenCount={tokenCount}
      tps={tps}
      cancelText={cancelText}
      className={className}
      hintElement={
        showCompactionHint ? (
          <button
            onClick={() => openSettings("models")}
            className="text-muted hover:text-foreground text-[10px] underline decoration-dotted underline-offset-2"
          >
            configure
          </button>
        ) : undefined
      }
    />
  );
};
