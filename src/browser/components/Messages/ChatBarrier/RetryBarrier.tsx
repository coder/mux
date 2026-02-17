import React, { useEffect, useState } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { usePersistedState } from "@/browser/hooks/usePersistedState";
import { useAPI } from "@/browser/contexts/API";
import { useWorkspaceState } from "@/browser/stores/WorkspaceStore";
import { getLastNonDecorativeMessage } from "@/common/utils/messages/retryEligibility";
import { KEYBINDS, formatKeybind } from "@/browser/utils/ui/keybinds";
import { VIM_ENABLED_KEY } from "@/common/constants/storage";
import { cn } from "@/common/lib/utils";
import { getSendOptionsFromStorage } from "@/browser/utils/messages/sendOptions";
import { applyCompactionOverrides } from "@/browser/utils/messages/compactionOptions";

interface RetryBarrierProps {
  workspaceId: string;
  className?: string;
}

export const RetryBarrier: React.FC<RetryBarrierProps> = (props) => {
  const { api } = useAPI();
  const workspaceState = useWorkspaceState(props.workspaceId);
  const [countdown, setCountdown] = useState(0);

  const [vimEnabled] = usePersistedState<boolean>(VIM_ENABLED_KEY, false, { listener: true });
  const stopKeybind = formatKeybind(
    vimEnabled ? KEYBINDS.INTERRUPT_STREAM_VIM : KEYBINDS.INTERRUPT_STREAM_NORMAL
  );

  const autoRetryStatus = workspaceState.autoRetryStatus;
  const isAutoRetryScheduled = autoRetryStatus?.type === "auto-retry-scheduled";
  const isAutoRetryActive =
    autoRetryStatus?.type === "auto-retry-scheduled" ||
    autoRetryStatus?.type === "auto-retry-starting";

  useEffect(() => {
    if (!isAutoRetryScheduled) {
      setCountdown(0);
      return;
    }

    const updateCountdown = () => {
      const retryAt = autoRetryStatus.scheduledAt + autoRetryStatus.delayMs;
      const timeUntilRetry = Math.max(0, retryAt - Date.now());
      setCountdown(Math.ceil(timeUntilRetry / 1000));
    };

    updateCountdown();
    const interval = setInterval(updateCountdown, 100);
    return () => clearInterval(interval);
  }, [autoRetryStatus, isAutoRetryScheduled]);

  const handleManualRetry = () => {
    if (!api) {
      return;
    }

    let options = getSendOptionsFromStorage(props.workspaceId);
    const lastUserMessage = [...workspaceState.messages]
      .reverse()
      .find(
        (message): message is Extract<typeof message, { type: "user" }> => message.type === "user"
      );

    if (lastUserMessage?.compactionRequest) {
      options = applyCompactionOverrides(options, lastUserMessage.compactionRequest.parsed);
    }

    void api.workspace.setAutoRetryEnabled?.({ workspaceId: props.workspaceId, enabled: true });
    void api.workspace.resumeStream({ workspaceId: props.workspaceId, options });
  };

  const handleStopAutoRetry = () => {
    setCountdown(0);
    void api?.workspace.setAutoRetryEnabled?.({ workspaceId: props.workspaceId, enabled: false });
  };

  const barrierClassName = cn(
    "my-5 px-5 py-4 bg-gradient-to-br from-[rgba(255,165,0,0.1)] to-[rgba(255,140,0,0.1)] border-l-4 border-warning rounded flex flex-col gap-3",
    props.className
  );

  const lastMessage = getLastNonDecorativeMessage(workspaceState.messages);
  const lastStreamError = lastMessage?.type === "stream-error" ? lastMessage : null;
  const interruptionReason = lastStreamError?.errorType === "rate_limit" ? "Rate limited" : null;

  let statusIcon: React.ReactNode = (
    <AlertTriangle aria-hidden="true" className="text-warning h-4 w-4 shrink-0" />
  );
  let statusText: React.ReactNode = <>{interruptionReason ?? "Stream interrupted"}</>;
  let actionButton: React.ReactNode = (
    <button
      className="bg-warning font-primary text-background cursor-pointer rounded border-none px-4 py-2 text-xs font-semibold whitespace-nowrap transition-all duration-200 hover:-translate-y-px hover:brightness-120 active:translate-y-0 disabled:cursor-not-allowed disabled:opacity-50"
      onClick={handleManualRetry}
    >
      Retry
    </button>
  );

  if (isAutoRetryActive) {
    statusIcon = (
      <RefreshCw aria-hidden="true" className="text-warning h-4 w-4 shrink-0 animate-spin" />
    );

    const reasonPrefix = interruptionReason ? <>{interruptionReason} — </> : null;
    const retryAttempt = autoRetryStatus.attempt;

    if (autoRetryStatus.type === "auto-retry-starting" || countdown === 0) {
      statusText = (
        <>
          {reasonPrefix}
          Retrying... (attempt {retryAttempt})
        </>
      );
    } else {
      statusText = (
        <>
          {reasonPrefix}
          Retrying in <span className="text-warning font-mono font-semibold">
            {countdown}s
          </span>{" "}
          (attempt {retryAttempt})
        </>
      );
    }

    actionButton = (
      <button
        className="border-warning font-primary text-warning hover:bg-warning-overlay cursor-pointer rounded border bg-transparent px-4 py-2 text-xs font-semibold whitespace-nowrap transition-all duration-200 hover:-translate-y-px active:translate-y-0 disabled:cursor-not-allowed disabled:opacity-50"
        onClick={handleStopAutoRetry}
      >
        Stop <span className="mobile-hide-shortcut-hints">({stopKeybind})</span>
      </button>
    );
  }

  const details =
    autoRetryStatus?.type === "auto-retry-abandoned" ? (
      <div className="font-primary text-foreground/80 pl-8 text-[12px]">
        <span className="text-warning font-semibold">Auto-retry stopped:</span>{" "}
        {autoRetryStatus.reason}
      </div>
    ) : null;

  return (
    <div className={barrierClassName}>
      <div className="flex items-center justify-between gap-4">
        <div className="flex flex-1 items-center gap-3">
          <span className="shrink-0">{statusIcon}</span>
          <div className="font-primary text-foreground text-[13px] font-medium">{statusText}</div>
        </div>
        {actionButton}
      </div>
      {details}
    </div>
  );
};
