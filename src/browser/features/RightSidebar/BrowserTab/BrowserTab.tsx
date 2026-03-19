import { useEffect, useState } from "react";
import { Loader2, Play, RefreshCw, Square, TriangleAlert } from "lucide-react";
import { useAPI } from "@/browser/contexts/API";
import { cn } from "@/common/lib/utils";
import type { BrowserSessionStatus } from "./browserBridgeTypes";
import { BrowserViewport } from "./BrowserViewport";
import { useBrowserBridgeConnection } from "./useBrowserBridgeConnection";

interface BrowserTabProps {
  workspaceId: string;
}

const STATUS_BADGES: Record<BrowserSessionStatus, { label: string; className: string }> = {
  starting: {
    label: "Connecting",
    className: "border-accent/30 bg-accent/10 text-accent",
  },
  live: {
    label: "Live",
    className: "bg-success/20 text-success",
  },
  error: {
    label: "Error",
    className: "border-destructive/20 bg-destructive/10 text-destructive",
  },
  ended: {
    label: "Stopped",
    className: "border-border-light bg-background-secondary text-muted",
  },
};

interface AutoStartGateState {
  attempted: boolean;
  autoStartPending: boolean;
  manuallyStopped: boolean;
}

const autoStartStateByWorkspace = new Map<string, AutoStartGateState>();

function getAutoStartState(workspaceId: string): AutoStartGateState {
  const existingState = autoStartStateByWorkspace.get(workspaceId);
  if (existingState != null) {
    return existingState;
  }

  const initialState: AutoStartGateState = {
    attempted: false,
    autoStartPending: false,
    manuallyStopped: false,
  };
  autoStartStateByWorkspace.set(workspaceId, initialState);
  return initialState;
}

function getErrorMessage(error: unknown, fallbackMessage: string): string {
  return error instanceof Error ? error.message : fallbackMessage;
}

export function BrowserTab(props: BrowserTabProps) {
  if (props.workspaceId.trim().length === 0) {
    throw new Error("Browser tab requires a workspaceId");
  }

  const { api } = useAPI();
  const { session, connect, disconnect, sendInput } = useBrowserBridgeConnection(props.workspaceId);
  const [commandError, setCommandError] = useState<string | null>(null);
  const [stoppingSession, setStoppingSession] = useState(false);
  const autoStartState = getAutoStartState(props.workspaceId);

  const isStarting = autoStartState.autoStartPending || session?.status === "starting";
  const sessionIsActive = session?.status === "live" || session?.status === "starting";
  const visibleError = commandError ?? session?.lastError ?? session?.streamErrorMessage ?? null;
  const screenshotSrc =
    session?.frameBase64 != null ? `data:image/jpeg;base64,${session.frameBase64}` : null;
  const headerBadge = session == null ? null : STATUS_BADGES[session.status];
  const showStopButton = stoppingSession || sessionIsActive;
  const showStartButton = !showStopButton;
  const headerTitle = "Browser preview";

  useEffect(() => {
    if (
      api == null ||
      session != null ||
      autoStartState.attempted ||
      autoStartState.autoStartPending ||
      autoStartState.manuallyStopped
    ) {
      return;
    }

    autoStartState.attempted = true;
    autoStartState.autoStartPending = true;
    setCommandError(null);
    connect();
    queueMicrotask(() => {
      autoStartState.autoStartPending = false;
    });
  }, [api, autoStartState, connect, session]);

  const handleStart = () => {
    if (api == null || stoppingSession || autoStartState.autoStartPending) {
      return;
    }

    autoStartState.manuallyStopped = false;
    setCommandError(null);
    connect();
  };

  const handleStop = () => {
    if (api == null || stoppingSession) {
      return;
    }

    autoStartState.manuallyStopped = true;
    setStoppingSession(true);
    setCommandError(null);
    disconnect();

    api.browser
      .stop({ workspaceId: props.workspaceId })
      .catch((error: unknown) => {
        setCommandError(getErrorMessage(error, "Failed to stop browser preview"));
      })
      .finally(() => {
        setStoppingSession(false);
      });
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-border-light flex items-start justify-between gap-3 border-b px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <h3 className="text-foreground min-w-0 flex-1 truncate text-xs font-semibold">
              {headerTitle}
            </h3>
            {headerBadge && <BrowserHeaderBadge badge={headerBadge} />}
          </div>
        </div>
        {showStartButton && (
          <button
            type="button"
            onClick={handleStart}
            disabled={!api || isStarting}
            className="bg-accent hover:bg-accent/80 text-accent-foreground inline-flex max-w-full items-center gap-1.5 self-start rounded-md px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isStarting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : session?.status === "error" || session?.status === "ended" ? (
              <RefreshCw className="h-3.5 w-3.5" />
            ) : (
              <Play className="h-3.5 w-3.5" />
            )}
            {session?.status === "error" || session?.status === "ended" ? "Restart" : "Start"}
          </button>
        )}
        {showStopButton && (
          <button
            type="button"
            onClick={handleStop}
            disabled={!api || stoppingSession}
            className="bg-destructive/10 hover:bg-destructive/20 text-destructive border-destructive/20 inline-flex max-w-full items-center gap-1.5 self-start rounded-md border px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50"
          >
            {stoppingSession ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Square className="h-3.5 w-3.5" />
            )}
            {stoppingSession ? "Stopping..." : "Stop"}
          </button>
        )}
      </div>

      {visibleError && !screenshotSrc && (
        <div className="border-border-light border-b px-3 py-2">
          <div
            role="alert"
            className="border-destructive/20 bg-destructive/10 text-destructive flex items-start gap-2 rounded-md border px-3 py-2 text-xs"
          >
            <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{visibleError}</span>
          </div>
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col">
        <BrowserViewport
          workspaceId={props.workspaceId}
          session={session}
          screenshotSrc={screenshotSrc}
          visibleError={visibleError}
          onRestart={handleStart}
          sendInput={sendInput}
          placeholder={
            <BrowserViewerState sessionStatus={session?.status ?? null} isStarting={isStarting} />
          }
        />
      </div>
    </div>
  );
}

function BrowserHeaderBadge(props: { badge: { label: string; className: string } }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[10px] font-medium",
        props.badge.className
      )}
    >
      {props.badge.label}
    </span>
  );
}

function BrowserViewerState(props: {
  sessionStatus: BrowserSessionStatus | null;
  isStarting: boolean;
}) {
  const content = (() => {
    if (props.isStarting || props.sessionStatus === "starting") {
      return {
        title: "Starting browser preview",
        description: "Mux is waiting for the browser bridge to publish its first live frame.",
      };
    }

    if (props.sessionStatus === "error") {
      return {
        title: "Browser preview stopped",
        description: "Restart the preview to reconnect to the workspace browser session.",
      };
    }

    return {
      title: "No browser preview running",
      description:
        "Start the browser preview to open the mux-managed browser session for this workspace.",
    };
  })();

  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="flex max-w-sm flex-col items-center gap-3 text-center">
        <div className="bg-accent/10 flex h-12 w-12 items-center justify-center rounded-full">
          <Play className="text-accent h-6 w-6" />
        </div>
        <div className="space-y-1">
          <h4 className="text-foreground text-sm font-medium">{content.title}</h4>
          <div className="text-muted text-xs leading-relaxed">{content.description}</div>
        </div>
      </div>
    </div>
  );
}
