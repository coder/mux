import { useEffect } from "react";
import { Play, TriangleAlert } from "lucide-react";
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

const BROWSER_PREVIEW_RETRY_INTERVAL_MS = 2_000;

export function BrowserTab(props: BrowserTabProps) {
  if (props.workspaceId.trim().length === 0) {
    throw new Error("Browser tab requires a workspaceId");
  }

  const { api } = useAPI();
  const { session, connect, sendInput } = useBrowserBridgeConnection(props.workspaceId);

  const isStarting = session?.status === "starting";
  const visibleError = session?.lastError ?? session?.streamErrorMessage ?? null;
  const screenshotSrc =
    session?.frameBase64 != null ? `data:image/jpeg;base64,${session.frameBase64}` : null;
  const headerBadge = session == null ? null : STATUS_BADGES[session.status];
  const headerTitle = "Browser preview";

  useEffect(() => {
    if (api == null) {
      return;
    }

    if (session?.status === "starting" || session?.status === "live") {
      return;
    }

    connect();
    const retryTimer = setInterval(() => {
      connect();
    }, BROWSER_PREVIEW_RETRY_INTERVAL_MS);
    retryTimer.unref?.();

    return () => {
      clearInterval(retryTimer);
    };
  }, [api, connect, session?.status]);

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
        title: "Browser preview unavailable",
        description:
          "Mux will reconnect automatically when the workspace browser session is available again.",
      };
    }

    return {
      title: "Waiting for browser preview",
      description:
        "Mux connects to the workspace browser session automatically when one is available.",
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
