import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { ArrowLeft, ArrowRight, Loader2, RotateCw } from "lucide-react";
import { TooltipIfPresent } from "@/browser/components/Tooltip/Tooltip";
import { useAPI } from "@/browser/contexts/API";
import { stopKeyboardPropagation } from "@/browser/utils/events";
import {
  ESCAPE_INTERRUPTS_STREAM_ATTR,
  formatKeybind,
  isEditableElement,
  matchesKeybind,
  type Keybind,
} from "@/browser/utils/ui/keybinds";
import { cn } from "@/common/lib/utils";
import assert from "@/common/utils/assert";

interface BrowserToolbarProps {
  workspaceId: string;
  sessionName: string | null;
  currentUrl: string | null;
  pendingUrl: string | null;
  isPageLoading: boolean;
  isConnected: boolean;
  onSetPendingUrl: (url: string | null) => void;
}

const TOOLBAR_BUTTON_CLASS_NAME =
  "rounded p-1 text-muted-foreground hover:bg-hover hover:text-foreground disabled:pointer-events-none disabled:opacity-40";

const BROWSER_TOOLBAR_KEYBINDS: Record<"back" | "forward" | "reload", Keybind> = {
  back: { key: "ArrowLeft", alt: true },
  forward: { key: "ArrowRight", alt: true },
  reload: { key: "r", ctrl: true },
};

const BROWSER_TOOLBAR_TITLES = {
  back: `Back (Alt+←)`,
  forward: `Forward (Alt+→)`,
  reload: `Reload (${formatKeybind(BROWSER_TOOLBAR_KEYBINDS.reload)})`,
} as const;

export function BrowserToolbar(props: BrowserToolbarProps) {
  assert(props.workspaceId.trim().length > 0, "BrowserToolbar requires a workspaceId");

  const { api } = useAPI();
  const [editingUrl, setEditingUrl] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // Session switches reuse the same toolbar instance, so pending state has to stay scoped to
  // the session that started each command instead of leaking into the newly selected session.
  const [pendingCommandSessions, setPendingCommandSessions] = useState<ReadonlySet<string>>(
    () => new Set<string>()
  );
  const errorTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isMountedRef = useRef(true);
  const currentSessionNameRef = useRef(props.sessionName);
  const pendingCommandSessionsRef = useRef<ReadonlySet<string>>(new Set<string>());
  const runControlCommandRef = useRef<
    (action: "back" | "forward" | "reload" | "open", url?: string) => Promise<void>
  >(() => Promise.resolve(undefined));
  const urlInputRef = useRef<HTMLInputElement>(null);
  currentSessionNameRef.current = props.sessionName;
  const isDisabled = !props.isConnected || props.sessionName == null;
  const isCommandPending =
    props.sessionName != null && pendingCommandSessions.has(props.sessionName);
  const controlsDisabled = isDisabled || isCommandPending;
  const displayUrl = props.pendingUrl ?? props.currentUrl ?? "";
  const escapeInterruptProps = { [ESCAPE_INTERRUPTS_STREAM_ATTR]: "true" } as const;

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (errorTimeoutRef.current != null) {
        clearTimeout(errorTimeoutRef.current);
      }
    };
  }, []);

  // Clear stale errors when the selected session changes so one session's failure does not
  // linger after the user switches to a different bridge.
  useEffect(() => {
    setErrorMessage(null);
    if (errorTimeoutRef.current != null) {
      clearTimeout(errorTimeoutRef.current);
      errorTimeoutRef.current = null;
    }
  }, [props.sessionName]);

  const showTransientError = (message: string) => {
    setErrorMessage(message);
    if (errorTimeoutRef.current != null) {
      clearTimeout(errorTimeoutRef.current);
    }
    errorTimeoutRef.current = setTimeout(() => {
      setErrorMessage(null);
      errorTimeoutRef.current = null;
    }, 3000);
  };

  const addPendingCommandSession = (sessionName: string) => {
    const nextPendingCommandSessions = new Set(pendingCommandSessionsRef.current);
    nextPendingCommandSessions.add(sessionName);
    pendingCommandSessionsRef.current = nextPendingCommandSessions;
    if (isMountedRef.current) {
      setPendingCommandSessions(nextPendingCommandSessions);
    }
  };

  const removePendingCommandSession = (sessionName: string) => {
    if (!pendingCommandSessionsRef.current.has(sessionName)) {
      return;
    }

    const nextPendingCommandSessions = new Set(pendingCommandSessionsRef.current);
    nextPendingCommandSessions.delete(sessionName);
    pendingCommandSessionsRef.current = nextPendingCommandSessions;
    if (isMountedRef.current) {
      setPendingCommandSessions(nextPendingCommandSessions);
    }
  };

  const runControlCommand = async (
    action: "back" | "forward" | "reload" | "open",
    url?: string
  ) => {
    const targetSession = props.sessionName;
    if (
      isDisabled ||
      targetSession == null ||
      pendingCommandSessionsRef.current.has(targetSession)
    ) {
      return;
    }

    assert(targetSession.trim().length > 0, "Browser controls require an active session.");
    addPendingCommandSession(targetSession);

    try {
      assert(api != null, "Browser API client is unavailable.");
      const result = await api.browser.control({
        workspaceId: props.workspaceId,
        sessionName: targetSession,
        action,
        ...(url != null ? { url } : {}),
      });
      if (currentSessionNameRef.current !== targetSession) {
        return;
      }
      if (!result.success) {
        if (action === "open") {
          props.onSetPendingUrl(null);
        }
        showTransientError(result.error ?? `Failed to ${action} the browser session.`);
        return;
      }
    } catch (error) {
      if (currentSessionNameRef.current !== targetSession) {
        return;
      }
      if (action === "open") {
        props.onSetPendingUrl(null);
      }
      showTransientError(
        error instanceof Error ? error.message : `Failed to ${action} the browser session.`
      );
    } finally {
      removePendingCommandSession(targetSession);
    }
  };

  runControlCommandRef.current = runControlCommand;

  const submitOpenUrl = async (candidateUrl: string) => {
    if (
      isDisabled ||
      (props.sessionName != null && pendingCommandSessionsRef.current.has(props.sessionName))
    ) {
      return;
    }

    const nextUrl = candidateUrl.trim();
    if (nextUrl.length === 0) {
      showTransientError("Enter a URL before navigating.");
      return;
    }

    props.onSetPendingUrl(nextUrl);
    await runControlCommand("open", nextUrl);
  };

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || controlsDisabled) {
        return;
      }

      if (
        document.activeElement === urlInputRef.current ||
        isEditableElement(event.target) ||
        event.repeat
      ) {
        return;
      }

      const action = matchesKeybind(event, BROWSER_TOOLBAR_KEYBINDS.back)
        ? "back"
        : matchesKeybind(event, BROWSER_TOOLBAR_KEYBINDS.forward)
          ? "forward"
          : matchesKeybind(event, BROWSER_TOOLBAR_KEYBINDS.reload)
            ? "reload"
            : null;
      if (action == null) {
        return;
      }

      event.preventDefault();
      stopKeyboardPropagation(event);
      void runControlCommandRef.current(action);
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [controlsDisabled]);

  const handleUrlKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      // Let Escape bubble to the global stream interrupt handler, which checks the
      // input's opt-in attribute before interrupting an active stream.
      event.currentTarget.blur();
      return;
    }

    if (event.key !== "Enter") {
      return;
    }

    stopKeyboardPropagation(event);
    event.preventDefault();
    const nextUrl = (editingUrl ?? displayUrl).trim();
    setEditingUrl(null);
    void submitOpenUrl(nextUrl);
  };

  return (
    <div className="border-border-light flex items-center gap-1 border-b px-2 py-1">
      <TooltipIfPresent tooltip={BROWSER_TOOLBAR_TITLES.back}>
        <button
          type="button"
          aria-label="Back"
          className={cn(TOOLBAR_BUTTON_CLASS_NAME)}
          disabled={controlsDisabled}
          onClick={() => {
            void runControlCommand("back");
          }}
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
      </TooltipIfPresent>
      <TooltipIfPresent tooltip={BROWSER_TOOLBAR_TITLES.forward}>
        <button
          type="button"
          aria-label="Forward"
          className={cn(TOOLBAR_BUTTON_CLASS_NAME)}
          disabled={controlsDisabled}
          onClick={() => {
            void runControlCommand("forward");
          }}
        >
          <ArrowRight className="h-4 w-4" />
        </button>
      </TooltipIfPresent>
      <TooltipIfPresent tooltip={BROWSER_TOOLBAR_TITLES.reload}>
        <button
          type="button"
          aria-label="Reload"
          className={cn(TOOLBAR_BUTTON_CLASS_NAME)}
          disabled={controlsDisabled}
          onClick={() => {
            void runControlCommand("reload");
          }}
        >
          {props.isPageLoading ? (
            <Loader2 data-testid="browser-toolbar-loading-icon" className="h-4 w-4 animate-spin" />
          ) : (
            <RotateCw data-testid="browser-toolbar-reload-icon" className="h-4 w-4" />
          )}
        </button>
      </TooltipIfPresent>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <input
          {...escapeInterruptProps}
          ref={urlInputRef}
          aria-label="Browser URL"
          type="text"
          className={cn(
            "flex-1 min-w-0 rounded border border-border-light bg-background-secondary px-2 py-0.5 text-[11px] text-foreground outline-none placeholder:text-muted-foreground focus:border-accent",
            errorMessage != null && "border-destructive"
          )}
          value={editingUrl ?? displayUrl}
          disabled={controlsDisabled}
          placeholder="Enter a URL"
          autoCapitalize="none"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          onFocus={() => {
            setEditingUrl(displayUrl);
          }}
          onChange={(event) => {
            setEditingUrl(event.target.value);
          }}
          onBlur={() => {
            setEditingUrl(null);
          }}
          onKeyDown={handleUrlKeyDown}
        />
        {errorMessage != null && (
          <span
            role="alert"
            aria-live="assertive"
            aria-atomic="true"
            className="text-destructive truncate text-[10px]"
          >
            {errorMessage}
          </span>
        )}
      </div>
    </div>
  );
}
