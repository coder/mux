import { useState, type ReactNode } from "react";
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

const OWNERSHIP_LABELS: Record<BrowserSession["ownership"], string> = {
  agent: "Agent",
  user: "User",
  shared: "Shared",
};

const ACTION_ICONS: Record<BrowserAction["type"], LucideIcon> = {
  navigate: Globe,
  click: MousePointerClick,
  fill: Keyboard,
  screenshot: Camera,
  custom: Sparkles,
};

export function BrowserTab(props: BrowserTabProps) {
  if (props.workspaceId.trim().length === 0) {
    throw new Error("Browser tab requires a workspaceId");
  }

  const { api } = useAPI();
  const { session, recentActions, error } = useBrowserSessionSubscription(props.workspaceId);
  const [startingSession, setStartingSession] = useState(false);
  const [stoppingSession, setStoppingSession] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  const isStarting = startingSession || session?.status === "starting";
  const screenshotSrc = session?.lastScreenshotBase64
    ? `data:image/jpeg;base64,${session.lastScreenshotBase64}`
    : null;
  const visibleError = startError ?? error ?? session?.lastError ?? null;
  const sessionIsActive =
    session?.status === "live" || session?.status === "starting" || session?.status === "paused";
  const showStopButton = stoppingSession || sessionIsActive;
  const showStartButton =
    !showStopButton &&
    (session == null || session.status === "ended" || session.status === "error");
  const headerTitle = session?.title ?? session?.currentUrl ?? "Browser session";
  const headerSubtitle = session
    ? [
        session.currentUrl ?? "No page loaded yet",
        `${OWNERSHIP_LABELS[session.ownership]} owned`,
      ].join(" · ")
    : isStarting
      ? "Starting browser session…"
      : "Start a browser session to see the live frame and recent actions.";
  const statusBadge = session
    ? STATUS_BADGES[session.status]
    : isStarting
      ? STATUS_BADGES.starting
      : null;

  const handleStartSession = () => {
    if (!api || startingSession) {
      return;
    }

    setStartingSession(true);
    setStartError(null);

    api.browserSession
      .start({
        workspaceId: props.workspaceId,
        ownership: "user",
      })
      .catch((sessionError: unknown) => {
        setStartError(
          sessionError instanceof Error ? sessionError.message : "Failed to start session"
        );
      })
      .finally(() => {
        setStartingSession(false);
      });
  };

  const handleStopSession = () => {
    if (!api || stoppingSession) {
      return;
    }

    setStoppingSession(true);
    setStartError(null);

    api.browserSession
      .stop({ workspaceId: props.workspaceId })
      .catch((sessionError: unknown) => {
        setStartError(
          sessionError instanceof Error ? sessionError.message : "Failed to stop session"
        );
      })
      .finally(() => {
        setStoppingSession(false);
      });
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-border-light flex items-start justify-between gap-3 border-b px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="text-foreground truncate text-xs font-semibold">{headerTitle}</h3>
            {statusBadge && (
              <span
                className={cn(
                  "inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[10px] font-medium",
                  statusBadge.className
                )}
              >
                {statusBadge.label}
              </span>
            )}
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
            disabled={!api || startingSession}
            className="bg-accent hover:bg-accent/80 text-accent-foreground inline-flex max-w-full items-center gap-1.5 self-start rounded-md px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50"
          >
            {startingSession ? (
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
        <div className="bg-background-secondary relative min-h-0 flex-1">
          {screenshotSrc ? (
            <img
              src={screenshotSrc}
              alt={session?.title ?? session?.currentUrl ?? "Browser session screenshot"}
              className="h-full w-full object-contain"
            />
          ) : (
            <BrowserViewerState session={session} isStarting={isStarting} error={visibleError} />
          )}

          {visibleError && screenshotSrc && (
            <div className="pointer-events-none absolute inset-x-3 top-3">
              <div className="bg-background-secondary border-destructive/20 text-destructive flex items-start gap-2 rounded-md border px-3 py-2 text-xs shadow-md">
                <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>{visibleError}</span>
              </div>
            </div>
          )}
        </div>

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

  return (
    <div className="border-border-light bg-background-secondary flex items-start gap-2 rounded border px-2 py-1.5">
      <Icon className="text-muted mt-0.5 h-3.5 w-3.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="text-foreground truncate text-xs">{props.action.description}</p>
        <div className="text-muted flex items-center gap-2 text-[10px]">
          <span className="capitalize">{props.action.type}</span>
          <span
            className="counter-nums"
            title={hasValidTimestamp ? formatTimestamp(actionTimestamp) : undefined}
          >
            {hasValidTimestamp ? formatRelativeTime(actionTimestamp) : "Unknown time"}
          </span>
        </div>
      </div>
    </div>
  );
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
