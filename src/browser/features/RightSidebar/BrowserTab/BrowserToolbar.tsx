import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ArrowLeft, ArrowRight, Loader2, RotateCw } from "lucide-react";
import { useAPI } from "@/browser/contexts/API";
import { stopKeyboardPropagation } from "@/browser/utils/events";
import { cn } from "@/common/lib/utils";
import assert from "@/common/utils/assert";

interface BrowserToolbarProps {
  workspaceId: string;
  sessionName: string | null;
  currentUrl: string | null;
  pendingUrl: string | null;
  isPageLoading: boolean;
  isConnected: boolean;
  onSetPendingUrl: (url: string) => void;
}

const TOOLBAR_BUTTON_CLASS_NAME =
  "rounded p-1 text-muted-foreground hover:bg-hover hover:text-foreground disabled:pointer-events-none disabled:opacity-40";

export function BrowserToolbar(props: BrowserToolbarProps) {
  assert(props.workspaceId.trim().length > 0, "BrowserToolbar requires a workspaceId");

  const { api } = useAPI();
  const [editingUrl, setEditingUrl] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const errorTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isDisabled = !props.isConnected || props.sessionName == null;
  const displayUrl = props.pendingUrl ?? props.currentUrl ?? "";

  useEffect(() => {
    return () => {
      if (errorTimeoutRef.current != null) {
        clearTimeout(errorTimeoutRef.current);
      }
    };
  }, []);

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

  const runControlCommand = async (
    action: "back" | "forward" | "reload" | "open",
    url?: string
  ) => {
    try {
      assert(api != null, "Browser API client is unavailable.");
      assert(
        props.sessionName != null && props.sessionName.trim().length > 0,
        "Browser controls require an active session."
      );
      await api.browser.control({
        workspaceId: props.workspaceId,
        sessionName: props.sessionName,
        action,
        ...(url != null ? { url } : {}),
      });
    } catch (error) {
      showTransientError(
        error instanceof Error ? error.message : `Failed to ${action} the browser session.`
      );
    }
  };

  const submitOpenUrl = async (candidateUrl: string) => {
    const nextUrl = candidateUrl.trim();
    if (nextUrl.length === 0) {
      showTransientError("Enter a URL before navigating.");
      return;
    }

    props.onSetPendingUrl(nextUrl);
    await runControlCommand("open", nextUrl);
  };

  const handleUrlKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    stopKeyboardPropagation(event);

    if (event.key === "Escape") {
      event.preventDefault();
      event.currentTarget.blur();
      return;
    }

    if (event.key !== "Enter") {
      return;
    }

    event.preventDefault();
    const nextUrl = (editingUrl ?? displayUrl).trim();
    setEditingUrl(null);
    void submitOpenUrl(nextUrl);
  };

  return (
    <div className="border-border-light flex items-center gap-1 border-b px-2 py-1">
      <button
        type="button"
        aria-label="Back"
        className={cn(TOOLBAR_BUTTON_CLASS_NAME)}
        disabled={isDisabled}
        onClick={() => {
          void runControlCommand("back");
        }}
      >
        <ArrowLeft className="h-4 w-4" />
      </button>
      <button
        type="button"
        aria-label="Forward"
        className={cn(TOOLBAR_BUTTON_CLASS_NAME)}
        disabled={isDisabled}
        onClick={() => {
          void runControlCommand("forward");
        }}
      >
        <ArrowRight className="h-4 w-4" />
      </button>
      <button
        type="button"
        aria-label="Reload"
        className={cn(TOOLBAR_BUTTON_CLASS_NAME)}
        disabled={isDisabled}
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
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <input
          aria-label="Browser URL"
          type="text"
          className={cn(
            "flex-1 min-w-0 rounded border border-border-light bg-background-secondary px-2 py-0.5 text-[11px] text-foreground outline-none placeholder:text-muted-foreground focus:border-accent",
            errorMessage != null && "border-destructive"
          )}
          value={editingUrl ?? displayUrl}
          disabled={isDisabled}
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
          <span role="alert" className="text-destructive truncate text-[10px]">
            {errorMessage}
          </span>
        )}
      </div>
    </div>
  );
}
