import React from "react";
import { StreamingBarrierView } from "./StreamingBarrierView";
import { getModelName } from "@/common/utils/ai/models";
import { formatKeybind, KEYBINDS } from "@/browser/utils/ui/keybinds";
import { AGENT_AI_DEFAULTS_KEY, VIM_ENABLED_KEY, getModelKey } from "@/common/constants/storage";
import { readPersistedState } from "@/browser/hooks/usePersistedState";
import type { AgentAiDefaults } from "@/common/types/agentAiDefaults";
import {
  useWorkspaceState,
  useWorkspaceAggregator,
  useWorkspaceStoreRaw,
} from "@/browser/stores/WorkspaceStore";
import { getDefaultModel } from "@/browser/hooks/useModelsFromSettings";
import { useSettings } from "@/browser/contexts/SettingsContext";
import { useAPI } from "@/browser/contexts/API";

type StreamingPhase =
  | "starting" // Message sent, waiting for stream-start
  | "interrupting" // User triggered interrupt, waiting for stream-abort
  | "streaming" // Normal streaming
  | "compacting" // Compaction in progress
  | "awaiting-input"; // ask_user_question waiting for response

interface StreamingBarrierProps {
  workspaceId: string;
  className?: string;
  /**
   * Optional vim state from parent subscription.
   * Falls back to persisted value when omitted.
   */
  vimEnabled?: boolean;
  /**
   * Optional compaction-specific cancel hook.
   * When provided, this path should preserve compaction edit state + follow-up content.
   */
  onCancelCompaction?: () => void;
}

// Don't show a new status until it has been the current value for this long.
// Transient phase labels that pass through quickly are suppressed entirely —
// the user only sees states that actually persist.
const STATUS_DISPLAY_DELAY_MS = 1000;

/**
 * Trailing-edge debounce for streaming status text.
 *
 * Each new text/phase change restarts a timer. Only values that survive for
 * STATUS_DISPLAY_DELAY_MS are promoted to the display. Rapid breadcrumb
 * cycling during startup or quick phase transitions are never shown — the
 * user sees only the settled state. Disappearance is always immediate so
 * the barrier hides promptly when the stream ends.
 */
function useStabilizedStreamingStatusText(
  workspaceId: string,
  phase: StreamingPhase | null,
  rawStatusText: string | null
): string | null {
  const [displayStatusText, setDisplayStatusText] = React.useState<string | null>(null);
  const pendingTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeWorkspaceRef = React.useRef(workspaceId);
  const latestRawRef = React.useRef(rawStatusText);
  latestRawRef.current = rawStatusText;

  // Single effect handles all transitions — workspace switches, phase/text
  // changes, and disappearance. Including workspaceId in the deps ensures the
  // timer restarts even when the new workspace has the same phase+text as the
  // old one (ChatPane stays mounted across workspace changes via WorkspaceShell).
  React.useEffect(() => {
    if (pendingTimerRef.current) {
      clearTimeout(pendingTimerRef.current);
      pendingTimerRef.current = null;
    }

    const isWorkspaceSwitch = activeWorkspaceRef.current !== workspaceId;
    activeWorkspaceRef.current = workspaceId;

    // Disappearance is always immediate so the barrier hides promptly.
    if (phase == null || rawStatusText == null) {
      setDisplayStatusText(null);
      return;
    }

    // First appearance (barrier not yet visible) is immediate so the barrier
    // mounts right away. Without this, the empty-transcript placeholder
    // ("No Messages Yet") would flash through during the debounce window.
    // On workspace switch, reset to the new workspace's text immediately so
    // stale labels from the previous workspace don't leak.
    if (isWorkspaceSwitch) {
      setDisplayStatusText(rawStatusText);
    } else {
      setDisplayStatusText((prev) => prev ?? rawStatusText);
    }

    // Each new value restarts the stability timer. Only text that survives
    // the full delay is promoted to the display, so rapid status label
    // cycling (breadcrumbs, quick phase transitions) is coalesced.
    pendingTimerRef.current = setTimeout(() => {
      pendingTimerRef.current = null;
      setDisplayStatusText(latestRawRef.current);
    }, STATUS_DISPLAY_DELAY_MS);

    return () => {
      if (pendingTimerRef.current) {
        clearTimeout(pendingTimerRef.current);
        pendingTimerRef.current = null;
      }
    };
  }, [workspaceId, phase, rawStatusText]);

  return displayStatusText;
}

/**
 * Self-contained streaming status barrier.
 * Computes streaming state internally from workspaceId.
 * Returns null when there's nothing to show.
 */
export const StreamingBarrier: React.FC<StreamingBarrierProps> = ({
  workspaceId,
  className,
  vimEnabled: vimEnabledFromParent,
  onCancelCompaction,
}) => {
  const workspaceState = useWorkspaceState(workspaceId);
  const aggregator = useWorkspaceAggregator(workspaceId);
  const storeRaw = useWorkspaceStoreRaw();
  const { api } = useAPI();
  const { open: openSettings } = useSettings();

  const {
    canInterrupt,
    isCompacting,
    isStreamStarting: isStarting,
    awaitingUserQuestion,
    currentModel,
    pendingStreamModel,
    runtimeStatus,
  } = workspaceState;

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

  // Model to display:
  // - "starting" phase: prefer pendingStreamModel (from muxMetadata), then localStorage
  // - Otherwise: use currentModel from active stream
  const model =
    phase === "starting"
      ? (pendingStreamModel ??
        readPersistedState<string | null>(getModelKey(workspaceId), null) ??
        getDefaultModel())
      : currentModel;
  const modelName = model ? getModelName(model) : null;

  // Prefer parent vim state (subscribed in ChatPane) so the hint updates immediately.
  const vimEnabled = vimEnabledFromParent ?? readPersistedState(VIM_ENABLED_KEY, false);
  const interruptKeybind = formatKeybind(
    vimEnabled ? KEYBINDS.INTERRUPT_STREAM_VIM : KEYBINDS.INTERRUPT_STREAM_NORMAL
  ).replace("Escape", "Esc");
  const interruptHint = `hit ${interruptKeybind} to cancel`;

  // Compute status text based on phase
  const rawStatusText = (() => {
    if (!phase) {
      return null;
    }

    switch (phase) {
      case "starting":
        // Prefer any backend-provided startup breadcrumb so users can see whether
        // we're still booting the runtime or doing later prep like loading tools.
        if (runtimeStatus?.phase === "starting" || runtimeStatus?.phase === "waiting") {
          return runtimeStatus.detail ?? "Starting workspace...";
        }
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
  const statusText = useStabilizedStreamingStatusText(workspaceId, phase, rawStatusText);

  if (!phase || statusText == null) {
    return null;
  }

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

  const canTapCancel = phase === "starting" || phase === "streaming" || phase === "compacting";
  const handleCancelClick = () => {
    if (!api) {
      return;
    }

    if (phase !== "starting" && phase !== "streaming" && phase !== "compacting") {
      return;
    }

    void api.workspace.setAutoRetryEnabled?.({ workspaceId, enabled: false });

    if (phase === "compacting") {
      // Reuse the established compaction-cancel flow from keyboard shortcuts so we keep
      // edit restoration + follow-up content behavior consistent across input methods.
      if (onCancelCompaction) {
        onCancelCompaction();
        return;
      }

      void api.workspace.interruptStream({
        workspaceId,
        options: { abandonPartial: true },
      });
      return;
    }

    if (phase === "streaming") {
      storeRaw.setInterrupting(workspaceId);
    }

    void api.workspace.interruptStream({ workspaceId });
  };

  // Show settings hint during compaction if no custom compaction model is configured
  const showCompactionHint =
    phase === "compacting" &&
    !readPersistedState<AgentAiDefaults>(AGENT_AI_DEFAULTS_KEY, {}).compact?.modelString;

  return (
    <StreamingBarrierView
      statusText={statusText}
      tokenCount={tokenCount}
      tps={tps}
      cancelText={cancelText}
      onCancel={canTapCancel ? handleCancelClick : undefined}
      cancelShortcutText={canTapCancel ? interruptKeybind : undefined}
      className={className}
      hintElement={
        showCompactionHint ? (
          <button
            onClick={() => openSettings("tasks")}
            className="text-muted hover:text-foreground text-[10px] underline decoration-dotted underline-offset-2"
          >
            configure
          </button>
        ) : undefined
      }
    />
  );
};
