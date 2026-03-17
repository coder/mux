import { useEffect, useState, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import {
  Camera,
  Globe,
  Keyboard,
  Loader2,
  MousePointerClick,
  Play,
  RefreshCw,
  Sparkles,
  Square,
  TriangleAlert,
} from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/browser/components/Tooltip/Tooltip";
import { useAPI } from "@/browser/contexts/API";
import { formatRelativeTime, formatTimestamp } from "@/browser/utils/ui/dateTime";
import { cn } from "@/common/lib/utils";
import type {
  BrowserAction,
  BrowserSession,
  BrowserSessionStatus,
} from "@/common/types/browserSession";
import { BrowserViewport } from "./BrowserViewport";
import { useBrowserSessionSubscription } from "./useBrowserSessionSubscription";

interface BrowserTabProps {
  workspaceId: string;
}

const STATUS_BADGES: Record<BrowserSessionStatus, { label: string; className: string }> = {
  starting: {
    label: "Starting",
    className: "border-accent/30 bg-accent/10 text-accent",
  },
  live: {
    label: "Live",
    className: "bg-success/20 text-success",
  },
  paused: {
    label: "Paused",
    className: "border-warning/30 bg-warning/10 text-warning",
  },
  error: {
    label: "Error",
    className: "border-destructive/20 bg-destructive/10 text-destructive",
  },
  ended: {
    label: "Ended",
    className: "border-border-light bg-background-secondary text-muted",
  },
};

const ACTION_ICONS: Record<BrowserAction["type"], LucideIcon> = {
  navigate: Globe,
  click: MousePointerClick,
  fill: Keyboard,
  screenshot: Camera,
  custom: Sparkles,
};

interface AutoStartGateState {
  attempted: boolean;
  autoStartPending: boolean;
  manuallyStopped: boolean;
}

// BrowserTab unmounts when users switch sidebar tabs, so the auto-start and manual-stop
// gates must outlive a single component instance to avoid surprise restarts on remount.
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

type BrowserSessionClient = NonNullable<ReturnType<typeof useAPI>["api"]>["browserSession"];

function getSessionErrorMessage(sessionError: unknown, fallbackMessage: string): string {
  return sessionError instanceof Error ? sessionError.message : fallbackMessage;
}

function startBrowserSession(args: {
  browserSessionApi: BrowserSessionClient | null;
  workspaceId: string;
  startingSession: boolean;
  stoppingSession: boolean;
  setStartingSession: (value: boolean) => void;
  setStartError: (value: string | null) => void;
}) {
  if (args.browserSessionApi == null || args.startingSession || args.stoppingSession) {
    return;
  }

  args.setStartingSession(true);
  args.setStartError(null);

  args.browserSessionApi
    .start({
      workspaceId: args.workspaceId,
    })
    .catch((sessionError: unknown) => {
      args.setStartError(getSessionErrorMessage(sessionError, "Failed to start session"));
    })
    .finally(() => {
      args.setStartingSession(false);
    });
}

export function BrowserTab(props: BrowserTabProps) {
  if (props.workspaceId.trim().length === 0) {
    throw new Error("Browser tab requires a workspaceId");
  }

  const { api } = useAPI();
  const { session, recentActions, error } = useBrowserSessionSubscription(props.workspaceId);
  const [startingSession, setStartingSession] = useState(false);
  const [stoppingSession, setStoppingSession] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const autoStartState = getAutoStartState(props.workspaceId);
  const browserSessionApi = api?.browserSession ?? null;

  const isStarting =
    startingSession || autoStartState.autoStartPending || session?.status === "starting";
  const screenshotSrc = session?.lastScreenshotBase64
    ? `data:image/jpeg;base64,${session.lastScreenshotBase64}`
    : null;
  const visibleError =
    startError ?? error ?? session?.lastError ?? session?.streamErrorMessage ?? null;
  const sessionIsActive =
    session?.status === "live" || session?.status === "starting" || session?.status === "paused";
  const headerBadge = (() => {
    if (!session && isStarting) {
      return STATUS_BADGES.starting;
    }
    if (!session) {
      return null;
    }

    if (session.status === "live") {
      switch (session.streamState) {
        case "live":
          return STATUS_BADGES.live;
        case "connecting":
          return { label: "Connecting", className: "border-accent/30 bg-accent/10 text-accent" };
        case "fallback":
          return { label: "Fallback", className: "border-warning/30 bg-warning/10 text-warning" };
        case "restart_required":
          return {
            label: "Restart required",
            className: "border-destructive/20 bg-destructive/10 text-destructive",
          };
        case "error":
          return {
            label: "Stream error",
            className: "border-destructive/20 bg-destructive/10 text-destructive",
          };
        default:
          return STATUS_BADGES.live;
      }
    }

    return STATUS_BADGES[session.status];
  })();
  const showStopButton = stoppingSession || sessionIsActive;
  const showStartButton =
    !showStopButton &&
    (session == null || session.status === "ended" || session.status === "error");
  const headerTitle = session?.title ?? session?.currentUrl ?? "Browser session";
  const headerSubtitle = session
    ? (session.currentUrl ?? "No page loaded yet")
    : isStarting
      ? "Starting browser session…"
      : "Start a browser session to see the live frame and recent actions.";

  // This effect syncs the Browser tab with the external browser-session service by
  // issuing a single attach/start request when no session exists yet.
  useEffect(() => {
    if (
      browserSessionApi == null ||
      session != null ||
      error != null ||
      startError != null ||
      stoppingSession ||
      autoStartState.attempted ||
      autoStartState.autoStartPending ||
      autoStartState.manuallyStopped
    ) {
      return;
    }

    autoStartState.attempted = true;
    autoStartState.autoStartPending = true;
    setStartError(null);

    browserSessionApi
      .start({
        workspaceId: props.workspaceId,
      })
      .catch((sessionError: unknown) => {
        setStartError(getSessionErrorMessage(sessionError, "Failed to start session"));
      })
      .finally(() => {
        autoStartState.autoStartPending = false;
      });
  }, [
    autoStartState,
    browserSessionApi,
    error,
    props.workspaceId,
    session,
    startError,
    stoppingSession,
  ]);

  const handleStartSession = () => {
    const currentAutoStartState = autoStartStateByWorkspace.get(props.workspaceId);
    if (
      browserSessionApi == null ||
      startingSession ||
      stoppingSession ||
      currentAutoStartState?.autoStartPending
    ) {
      return;
    }

    autoStartState.manuallyStopped = false;
    startBrowserSession({
      browserSessionApi,
      workspaceId: props.workspaceId,
      startingSession,
      stoppingSession,
      setStartingSession,
      setStartError,
    });
  };

  const handleStopSession = () => {
    if (browserSessionApi == null || stoppingSession) {
      return;
    }

    autoStartState.manuallyStopped = true;
    setStoppingSession(true);
    setStartError(null);

    browserSessionApi
      .stop({ workspaceId: props.workspaceId })
      .catch((sessionError: unknown) => {
        setStartError(getSessionErrorMessage(sessionError, "Failed to stop session"));
      })
      .finally(() => {
        setStoppingSession(false);
      });
  };

  const handleRestartSession = () => {
    const currentAutoStartState = autoStartStateByWorkspace.get(props.workspaceId);
    if (
      browserSessionApi == null ||
      startingSession ||
      stoppingSession ||
      currentAutoStartState?.autoStartPending
    ) {
      return;
    }

    // restart_required means the daemon session is still alive but the live stream transport is not,
    // so the recovery path must tear down the existing browser process before starting a fresh one.
    autoStartState.manuallyStopped = false;
    setStartingSession(true);
    setStoppingSession(true);
    setStartError(null);

    browserSessionApi
      .stop({ workspaceId: props.workspaceId })
      .then(() =>
        browserSessionApi.start({
          workspaceId: props.workspaceId,
        })
      )
      .catch((sessionError: unknown) => {
        setStartError(getSessionErrorMessage(sessionError, "Failed to restart session"));
      })
      .finally(() => {
        setStoppingSession(false);
        setStartingSession(false);
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
          {/* Use a portal-backed tooltip to avoid clipping inside overflow-hidden sidebar panels. */}
          <Tooltip>
            <TooltipTrigger asChild>
              <p className="text-muted text-[10px] leading-relaxed break-words">{headerSubtitle}</p>
            </TooltipTrigger>
            <TooltipContent
              side="top"
              align="start"
              className="max-w-sm break-words whitespace-normal"
            >
              {headerSubtitle}
            </TooltipContent>
          </Tooltip>
        </div>
        {showStartButton && (
          <button
            type="button"
            onClick={handleStartSession}
            disabled={!api || isStarting}
            className="bg-accent hover:bg-accent/80 text-accent-foreground inline-flex max-w-full items-center gap-1.5 self-start rounded-md px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isStarting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : session?.status === "ended" || session?.status === "error" ? (
              <RefreshCw className="h-3.5 w-3.5" />
            ) : (
              <Play className="h-3.5 w-3.5" />
            )}
            {session?.status === "ended" || session?.status === "error" ? "Restart" : "Start"}
          </button>
        )}
        {showStopButton && (
          <button
            type="button"
            onClick={handleStopSession}
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

      <div className="flex min-h-0 flex-1 flex-col">
        <BrowserViewport
          workspaceId={props.workspaceId}
          session={session}
          screenshotSrc={screenshotSrc}
          visibleError={visibleError}
          onRestart={handleRestartSession}
          placeholder={
            <BrowserViewerState session={session} isStarting={isStarting} error={visibleError} />
          }
        />

        <div className="border-border-light flex max-h-56 min-h-[12rem] flex-col border-t">
          <div className="border-border-light bg-background-secondary flex items-center justify-between border-b px-3 py-2">
            <h4 className="text-foreground text-[11px] font-semibold tracking-wide uppercase">
              Recent actions
            </h4>
            <span className="text-muted counter-nums text-[10px]">{recentActions.length}</span>
          </div>
          <div className="flex-1 overflow-y-auto p-2">
            {recentActions.length === 0 ? (
              <div className="flex h-full items-center justify-center">
                <p className="text-muted text-center text-xs">
                  No browser actions recorded yet.
                  <br />
                  Actions will appear here as the session navigates and interacts with the page.
                </p>
              </div>
            ) : (
              <div className="flex flex-col gap-1.5">
                {recentActions.map((action) => (
                  <BrowserActionRow key={action.id} action={action} />
                ))}
              </div>
            )}
          </div>
        </div>
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
  session: BrowserSession | null;
  isStarting: boolean;
  error: string | null;
}) {
  const content = getViewerContent(props.session, props.isStarting, props.error);

  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="flex max-w-sm flex-col items-center gap-3 text-center">
        <div className="bg-accent/10 flex h-12 w-12 items-center justify-center rounded-full">
          <content.Icon className={cn("h-6 w-6", content.iconClassName)} />
        </div>
        <div className="space-y-1">
          <h4 className="text-foreground text-sm font-medium">{content.title}</h4>
          <div className="text-muted text-xs leading-relaxed">{content.description}</div>
        </div>
      </div>
    </div>
  );
}

function BrowserActionRow(props: { action: BrowserAction }) {
  const Icon = ACTION_ICONS[props.action.type];
  const actionTimestamp = Date.parse(props.action.timestamp);
  const hasValidTimestamp = Number.isFinite(actionTimestamp);
  const relativeTimestampLabel = hasValidTimestamp
    ? formatRelativeTime(actionTimestamp)
    : "Unknown time";
  const absoluteTimestampLabel = hasValidTimestamp ? formatTimestamp(actionTimestamp) : null;

  return (
    <div className="border-border-light bg-background-secondary flex items-start gap-2 rounded border px-2 py-1.5">
      <Icon className="text-muted mt-0.5 h-3.5 w-3.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="text-foreground truncate text-xs">{props.action.description}</p>
        <div className="text-muted flex items-center gap-2 text-[10px]">
          <span className="capitalize">{getBrowserActionTypeLabel(props.action)}</span>
          {absoluteTimestampLabel == null ? (
            <span className="counter-nums">{relativeTimestampLabel}</span>
          ) : (
            <Tooltip>
              {/* Use the shared portal-backed tooltip so the embedded browser surface does not
                  stack a native title tooltip on top of the app tooltip. */}
              <TooltipTrigger asChild>
                <span className="counter-nums cursor-default">{relativeTimestampLabel}</span>
              </TooltipTrigger>
              <TooltipContent align="center" side="top">
                {absoluteTimestampLabel}
              </TooltipContent>
            </Tooltip>
          )}
        </div>
      </div>
    </div>
  );
}

function getBrowserActionTypeLabel(action: BrowserAction): BrowserAction["type"] | "scroll" {
  if (action.type !== "custom" || action.metadata?.inputKind !== "scroll") {
    return action.type;
  }

  return "scroll";
}
function getViewerContent(
  session: BrowserSession | null,
  isStarting: boolean,
  error: string | null
): {
  Icon: LucideIcon;
  iconClassName: string;
  title: string;
  description: ReactNode;
} {
  if (!session && !isStarting) {
    return {
      Icon: Globe,
      iconClassName: "text-muted",
      title: "No browser session",
      description: "Start a browser session to view a live frame, URL updates, and recent actions.",
    };
  }

  if (isStarting) {
    return {
      Icon: Loader2,
      iconClassName: "text-accent animate-spin",
      title: "Starting browser session…",
      description: "Waiting for the browser backend to establish the session.",
    };
  }

  if (session?.status === "error") {
    return {
      Icon: TriangleAlert,
      iconClassName: "text-destructive",
      title: "Browser session error",
      description: error ?? "The browser session reported an error before a frame was captured.",
    };
  }

  if (session?.status === "ended") {
    return {
      Icon: RefreshCw,
      iconClassName: "text-muted",
      title: "Session ended",
      description: "Restart the browser session to resume viewing live browser updates.",
    };
  }

  return {
    Icon: Loader2,
    iconClassName: "text-accent animate-spin",
    title: "Waiting for first frame…",
    description: "The browser session is active, but it has not published a screenshot yet.",
  };
}
