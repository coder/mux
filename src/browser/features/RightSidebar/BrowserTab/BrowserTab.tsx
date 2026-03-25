import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Play, TriangleAlert } from "lucide-react";
import { useAPI } from "@/browser/contexts/API";
import { usePersistedState } from "@/browser/hooks/usePersistedState";
import { getBrowserSelectedSessionKey } from "@/common/constants/storage";
import { cn } from "@/common/lib/utils";
import type {
  BrowserDiscoveredSession,
  BrowserDiscoveredSessionStatus,
  BrowserSession,
  BrowserSessionStatus,
} from "./browserBridgeTypes";
import { BrowserViewport } from "./BrowserViewport";
import { useBrowserBridgeConnection } from "./useBrowserBridgeConnection";

interface BrowserTabProps {
  workspaceId: string;
  projectPath: string;
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
    label: "Unavailable",
    className: "border-destructive/20 bg-destructive/10 text-destructive",
  },
  ended: {
    label: "Stopped",
    className: "border-border-light bg-background-secondary text-muted",
  },
};

const DISCOVERY_BADGES: Record<
  BrowserDiscoveredSessionStatus,
  { label: string; className: string }
> = {
  attachable: {
    label: "Ready",
    className: "border-accent/30 bg-accent/10 text-accent",
  },
  missing_stream: {
    label: "Activating",
    className: "border-accent/30 bg-accent/10 text-accent",
  },
};

export const BROWSER_PREVIEW_RETRY_INTERVAL_MS = 2_000;

function isRetryableBrowserError(error: string | null): boolean {
  if (error == null) {
    return false;
  }

  return /disconnected|session unavailable|is unavailable|stream connect failed|invalid token|failed to enable streaming|failed to verify streaming/i.test(
    error
  );
}

export function shouldBackOffBrowserReconnect(params: {
  selectedSessionName: string;
  session: BrowserSession | null;
  visibleError: string | null;
  lastConnectAttempt: { sessionName: string; attemptedAtMs: number } | null;
  nowMs: number;
}): boolean {
  const isSameSessionRetry =
    params.session?.sessionName === params.selectedSessionName &&
    (params.session.status === "ended" ||
      (params.session.status === "error" && isRetryableBrowserError(params.visibleError)));
  if (!isSameSessionRetry) {
    return false;
  }

  return (
    params.lastConnectAttempt?.sessionName === params.selectedSessionName &&
    params.nowMs - params.lastConnectAttempt.attemptedAtMs < BROWSER_PREVIEW_RETRY_INTERVAL_MS
  );
}

function chooseSelectedSession(
  currentSessionName: string | null,
  sessions: BrowserDiscoveredSession[]
): string | null {
  if (
    currentSessionName != null &&
    sessions.some((session) => session.sessionName === currentSessionName)
  ) {
    return currentSessionName;
  }

  if (currentSessionName != null && sessions.length === 0) {
    return currentSessionName;
  }

  return sessions[0]?.sessionName ?? null;
}

export function BrowserTab(props: BrowserTabProps) {
  if (props.workspaceId.trim().length === 0) {
    throw new Error("Browser tab requires a workspaceId");
  }

  const lastConnectAttemptRef = useRef<{ sessionName: string; attemptedAtMs: number } | null>(null);
  const discoveryRefreshInFlightRef = useRef(false);
  const { api } = useAPI();
  const [discoveredSessions, setDiscoveredSessions] = useState<BrowserDiscoveredSession[]>([]);
  const [selectedSessionName, setSelectedSessionName] = usePersistedState<string | null>(
    getBrowserSelectedSessionKey(props.projectPath),
    null,
    { listener: true }
  );
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);
  const { session, connect, disconnect, sendInput } = useBrowserBridgeConnection(props.workspaceId);

  const selectedDiscoveredSession =
    discoveredSessions.find((candidate) => candidate.sessionName === selectedSessionName) ?? null;

  const isStarting = session?.status === "starting";
  const screenshotSrc =
    session?.frameBase64 != null ? `data:image/jpeg;base64,${session.frameBase64}` : null;
  const visibleError = session?.lastError ?? session?.streamErrorMessage ?? discoveryError ?? null;
  const headerBadge =
    session != null
      ? STATUS_BADGES[session.status]
      : selectedDiscoveredSession != null
        ? DISCOVERY_BADGES[selectedDiscoveredSession.status]
        : null;
  const headerTitle = "Browser preview";

  useEffect(() => {
    if (api == null) {
      setDiscoveryError("Browser API client is unavailable.");
      setDiscoveredSessions([]);
      return;
    }

    let cancelled = false;

    const refreshSessions = async (): Promise<void> => {
      if (discoveryRefreshInFlightRef.current) {
        return;
      }
      discoveryRefreshInFlightRef.current = true;

      try {
        const result = await api.browser.listSessions({ workspaceId: props.workspaceId });
        if (cancelled) {
          return;
        }

        setDiscoveryError(null);
        setDiscoveredSessions(result.sessions);
        setSelectedSessionName((currentSessionName) =>
          chooseSelectedSession(currentSessionName, result.sessions)
        );
      } catch (error) {
        if (cancelled) {
          return;
        }

        // Preserve the last known discovery result so transient refresh failures do not
        // tear down an otherwise healthy browser bridge.
        setDiscoveryError(
          error instanceof Error ? error.message : "Failed to discover browser sessions."
        );
      } finally {
        discoveryRefreshInFlightRef.current = false;
      }
    };

    void refreshSessions();
    const refreshTimer = setInterval(() => {
      void refreshSessions();
    }, BROWSER_PREVIEW_RETRY_INTERVAL_MS);
    refreshTimer.unref?.();

    return () => {
      cancelled = true;
      clearInterval(refreshTimer);
    };
  }, [api, props.workspaceId, setSelectedSessionName]);

  useEffect(() => {
    if (api == null || selectedSessionName == null || selectedDiscoveredSession == null) {
      lastConnectAttemptRef.current = null;
      disconnect();
      return;
    }

    if (
      session?.sessionName === selectedSessionName &&
      (session.status === "starting" || session.status === "live")
    ) {
      return;
    }

    const shouldRetryConnection =
      session?.sessionName !== selectedSessionName ||
      session?.status === "ended" ||
      (session?.status === "error" && isRetryableBrowserError(visibleError));
    if (!shouldRetryConnection) {
      lastConnectAttemptRef.current = null;
      return;
    }

    const now = Date.now();
    if (
      shouldBackOffBrowserReconnect({
        selectedSessionName,
        session,
        visibleError,
        lastConnectAttempt: lastConnectAttemptRef.current,
        nowMs: now,
      })
    ) {
      return;
    }

    // Bootstrap failures can flip the bridge session into "error" almost immediately.
    // Remember the most recent attempt so the next render waits for the normal discovery
    // polling cadence instead of hammering browser.getBootstrap in a tight loop.
    lastConnectAttemptRef.current = {
      sessionName: selectedSessionName,
      attemptedAtMs: now,
    };
    connect(selectedSessionName);
  }, [
    api,
    connect,
    disconnect,
    selectedDiscoveredSession,
    selectedSessionName,
    session,
    visibleError,
  ]);

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
        {discoveredSessions.length > 0 && selectedSessionName != null && (
          <BrowserSessionPicker
            sessions={discoveredSessions}
            selectedSessionName={selectedSessionName}
            onChange={setSelectedSessionName}
          />
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
          sendInput={sendInput}
          placeholder={
            <BrowserViewerState
              sessionStatus={session?.status ?? null}
              isStarting={isStarting}
              selectedSession={selectedDiscoveredSession}
              hasDiscoveredSessions={discoveredSessions.length > 0}
            />
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

function BrowserSessionPicker(props: {
  sessions: BrowserDiscoveredSession[];
  selectedSessionName: string;
  onChange: (sessionName: string) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [isOpen]);

  return (
    <div ref={containerRef} className="relative shrink-0">
      <button
        type="button"
        className="border-border-light bg-background-secondary text-foreground hover:bg-hover inline-flex max-w-[16rem] items-center gap-1 rounded-md border px-2 py-1 text-[11px]"
        aria-expanded={isOpen}
        aria-haspopup="listbox"
        onClick={() => setIsOpen((current) => !current)}
      >
        <span className="truncate">{props.selectedSessionName}</span>
        <ChevronDown className="h-3 w-3 shrink-0" />
      </button>

      {isOpen && (
        <div className="bg-dark border-border absolute top-full right-0 z-[10001] mt-1 min-w-[16rem] overflow-hidden rounded-md border shadow-md">
          <div
            role="listbox"
            aria-label="Browser sessions"
            className="max-h-[240px] overflow-y-auto p-1"
          >
            {props.sessions.map((session) => (
              <button
                key={session.sessionName}
                type="button"
                role="option"
                aria-selected={session.sessionName === props.selectedSessionName}
                data-testid={`browser-session-${session.sessionName}`}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  props.onChange(session.sessionName);
                  setIsOpen(false);
                }}
                className="hover:bg-hover flex w-full items-center gap-1.5 rounded-sm px-2 py-1 text-left text-[11px]"
              >
                <Check
                  className={cn(
                    "h-3 w-3 shrink-0",
                    session.sessionName === props.selectedSessionName ? "opacity-100" : "opacity-0"
                  )}
                />
                <span className="min-w-0 flex-1 truncate">{session.sessionName}</span>
                {session.status === "missing_stream" && (
                  <span className="text-accent shrink-0 text-[10px]">Activating</span>
                )}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function BrowserViewerState(props: {
  sessionStatus: BrowserSessionStatus | null;
  isStarting: boolean;
  selectedSession: BrowserDiscoveredSession | null;
  hasDiscoveredSessions: boolean;
}) {
  const content = (() => {
    if (props.selectedSession?.status === "missing_stream") {
      return {
        title: "Starting live preview…",
        description: `Enabling streaming for session "${props.selectedSession.sessionName}"…`,
      };
    }

    if (props.isStarting || props.sessionStatus === "starting") {
      return {
        title: "Connecting to browser preview",
        description: "Mux is attaching to the selected agent-owned browser session.",
      };
    }

    if (props.sessionStatus === "error") {
      return {
        title: "Browser preview unavailable",
        description:
          "Mux will keep retrying while a discovered browser session is available for this project.",
      };
    }

    if (props.hasDiscoveredSessions) {
      return {
        title: "Waiting for browser frames",
        description: "Mux found a browser session and is waiting for live preview frames.",
      };
    }

    return {
      title: "Waiting for browser preview",
      description:
        "Mux will attach automatically when an agent-owned browser session is available for this project.",
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
