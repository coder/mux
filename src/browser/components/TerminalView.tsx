import { useRef, useEffect, useState, useCallback } from "react";
import { init, Terminal, FitAddon } from "ghostty-web";
import { useAPI } from "@/browser/contexts/API";
import { useTerminalRouter } from "@/browser/terminal/TerminalRouterContext";

interface TerminalViewProps {
  workspaceId: string;
  /** Session ID to connect to (required - must be created before mounting) */
  sessionId: string;
  visible: boolean;
  /**
   * Whether to set document.title based on workspace name.
   *
   * Default: true (used by the dedicated terminal window).
   * Set to false when embedding inside the app (e.g. RightSidebar).
   */
  setDocumentTitle?: boolean;
  /** Called when the terminal title changes (via OSC escape sequences from running processes) */
  onTitleChange?: (title: string) => void;
  /**
   * Whether to auto-focus the terminal on mount/visibility change.
   *
   * Default: true (used by dedicated terminal window).
   * Set to false when embedding (e.g. RightSidebar) to avoid stealing focus on workspace switch.
   */
  autoFocus?: boolean;
}

export function TerminalView({
  workspaceId,
  sessionId,
  visible,
  setDocumentTitle = true,
  onTitleChange,
  autoFocus = true,
}: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const [terminalError, setTerminalError] = useState<string | null>(null);
  const [terminalReady, setTerminalReady] = useState(false);
  // Track whether we've received the initial screen state from backend
  const [isLoading, setIsLoading] = useState(true);

  const { api } = useAPI();
  const router = useTerminalRouter();

  // Set window title (dedicated terminal window only)
  useEffect(() => {
    if (!api || !setDocumentTitle) return;
    const setWindowDetails = async () => {
      try {
        const workspaces = await api.workspace.list();
        const workspace = workspaces.find((ws) => ws.id === workspaceId);
        if (workspace) {
          document.title = `Terminal — ${workspace.projectName}/${workspace.name}`;
        } else {
          document.title = `Terminal — ${workspaceId}`;
        }
      } catch {
        document.title = `Terminal — ${workspaceId}`;
      }
    };
    void setWindowDetails();
  }, [api, workspaceId, setDocumentTitle]);

  // Reset loading state when session changes
  useEffect(() => {
    setIsLoading(true);
  }, [sessionId]);

  // Subscribe to router when terminal is ready and visible
  useEffect(() => {
    if (!visible || !terminalReady || !termRef.current) {
      return;
    }

    // Capture current terminal ref for this subscription's lifetime
    const term = termRef.current;

    // Clear terminal before subscribing to prevent any stale content flash
    try {
      term.clear();
    } catch (err) {
      console.warn("[TerminalView] Error clearing terminal:", err);
    }

    const unsubscribe = router.subscribe(sessionId, {
      onOutput: (data) => {
        try {
          term.write(data);
        } catch (err) {
          // xterm WASM can throw "memory access out of bounds" intermittently
          console.warn("[TerminalView] Error writing output:", err);
        }
      },
      onScreenState: (state) => {
        // Write screen state (may be empty for new sessions)
        if (state) {
          try {
            term.write(state);
          } catch (err) {
            // xterm WASM can throw "memory access out of bounds" intermittently
            console.warn("[TerminalView] Error writing screenState:", err);
          }
        }
        // Mark loading complete - we now have valid content to show
        setIsLoading(false);
      },
      onExit: (code) => {
        try {
          term.write(`\r\n[Process exited with code ${code}]\r\n`);
        } catch (err) {
          console.warn("[TerminalView] Error writing exit message:", err);
        }
      },
    });

    // Send initial resize to sync PTY dimensions
    const { cols, rows } = term;
    void router.resize(sessionId, cols, rows);

    return unsubscribe;
  }, [visible, terminalReady, sessionId, router]);

  // Keep ref to onTitleChange for use in terminal callback
  const onTitleChangeRef = useRef(onTitleChange);
  useEffect(() => {
    onTitleChangeRef.current = onTitleChange;
  }, [onTitleChange]);

  const disposeOnDataRef = useRef<{ dispose: () => void } | null>(null);
  const disposeOnTitleChangeRef = useRef<{ dispose: () => void } | null>(null);
  const initInProgressRef = useRef(false);

  // Clean up the terminal instance when workspace changes (or component unmounts).
  useEffect(() => {
    const containerEl = containerRef.current;

    return () => {
      disposeOnDataRef.current?.dispose();
      disposeOnTitleChangeRef.current?.dispose();
      disposeOnDataRef.current = null;
      disposeOnTitleChangeRef.current = null;

      termRef.current?.dispose();

      // Ensure the DOM is clean even if the terminal init was interrupted.
      containerEl?.replaceChildren();

      termRef.current = null;
      fitAddonRef.current = null;
      initInProgressRef.current = false;
      setTerminalReady(false);
    };
  }, [workspaceId]);

  // Initialize terminal when it first becomes visible.
  // We intentionally keep the terminal instance alive when hidden so we don't lose
  // frontend-only state (like scrollback) and so TUI apps don't thrash on tab switches.
  useEffect(() => {
    if (!visible) return;
    if (termRef.current || initInProgressRef.current) return;

    const containerEl = containerRef.current;
    if (!containerEl) {
      return;
    }

    // StrictMode will run this effect twice in dev (setup → cleanup → setup).
    // If the first async init completes after cleanup, we can end up with two ghostty-web
    // terminals wired to the same DOM node (double cursor + duplicated input). Make the
    // init path explicitly cancelable.
    let cancelled = false;
    initInProgressRef.current = true;

    let terminal: Terminal | null = null;
    let disposeOnData: { dispose: () => void } | null = null;
    let disposeOnTitleChange: { dispose: () => void } | null = null;

    setTerminalError(null);

    const initTerminal = async () => {
      try {
        // Initialize ghostty-web WASM module (idempotent, safe to call multiple times)
        await init();

        if (cancelled) {
          return;
        }

        // Be defensive: if anything previously mounted into this container (e.g. from an
        // interrupted init), clear it before opening a new terminal.
        containerEl.replaceChildren();

        // Resolve CSS variables for xterm.js (canvas rendering doesn't support CSS vars)
        const styles = getComputedStyle(document.documentElement);
        const terminalBg = styles.getPropertyValue("--color-terminal-bg").trim() || "#1e1e1e";
        const terminalFg = styles.getPropertyValue("--color-terminal-fg").trim() || "#d4d4d4";

        terminal = new Terminal({
          fontSize: 13,
          fontFamily: "JetBrains Mono, Menlo, Monaco, monospace",
          // Start with no blinking - we enable it on focus
          cursorBlink: false,
          theme: {
            background: terminalBg,
            foreground: terminalFg,
          },
        });

        const fitAddon = new FitAddon();
        terminal.loadAddon(fitAddon);

        terminal.open(containerEl);
        fitAddon.fit();

        // ghostty-web calls focus() internally in open(), which steals focus.
        // It also schedules a delayed focus with setTimeout(0) as "backup".
        // If autoFocus is disabled, blur immediately AND with a delayed blur to counteract.
        // If autoFocus is enabled, focus the hidden textarea to avoid browser caret.
        if (autoFocus) {
          const textarea = containerEl.querySelector("textarea");
          if (textarea instanceof HTMLTextAreaElement) {
            textarea.focus();
          }
        } else {
          // Blur immediately
          terminal.blur();
          // Counter the delayed focus() in ghostty-web
          const termToBlur = terminal;
          setTimeout(() => {
            termToBlur.blur();
          }, 0);
        }

        // User input → router
        disposeOnData = terminal.onData((data: string) => {
          router.sendInput(sessionId, data);
        });

        // Terminal title changes (from OSC escape sequences like "echo -ne '\033]0;Title\007'")
        // Use ref to always get latest callback
        disposeOnTitleChange = terminal.onTitleChange((title: string) => {
          onTitleChangeRef.current?.(title);
        });

        termRef.current = terminal;
        fitAddonRef.current = fitAddon;
        disposeOnDataRef.current = disposeOnData;
        disposeOnTitleChangeRef.current = disposeOnTitleChange;

        setTerminalReady(true);
      } catch (err) {
        if (cancelled) {
          return;
        }

        console.error("Failed to initialize terminal:", err);
        setTerminalError(err instanceof Error ? err.message : "Failed to initialize terminal");
      } finally {
        initInProgressRef.current = false;
      }
    };

    void initTerminal();

    return () => {
      cancelled = true;

      // If the terminal finished initializing, we keep it alive across visible toggles.
      if (termRef.current) {
        return;
      }

      // Otherwise, clean up any partially created resources so a future attempt can succeed.
      disposeOnData?.dispose();
      disposeOnTitleChange?.dispose();
      terminal?.dispose();
      containerEl.replaceChildren();
      initInProgressRef.current = false;
    };
  }, [visible, workspaceId, router, sessionId, autoFocus]);

  // Track focus/blur on the terminal container to control cursor blinking
  useEffect(() => {
    if (!terminalReady || !containerRef.current) {
      return;
    }

    const container = containerRef.current;

    const handleFocusIn = () => {
      if (termRef.current) {
        termRef.current.options.cursorBlink = true;
      }
    };

    const handleFocusOut = (e: FocusEvent) => {
      // Only blur if focus is leaving the container entirely
      if (!container.contains(e.relatedTarget as Node)) {
        if (termRef.current) {
          termRef.current.options.cursorBlink = false;
        }
      }
    };

    container.addEventListener("focusin", handleFocusIn);
    container.addEventListener("focusout", handleFocusOut);

    return () => {
      container.removeEventListener("focusin", handleFocusIn);
      container.removeEventListener("focusout", handleFocusOut);
    };
  }, [terminalReady]);

  // Resize on container size change
  useEffect(() => {
    if (!visible || !fitAddonRef.current || !containerRef.current || !termRef.current) {
      return;
    }

    let lastCols = 0;
    let lastRows = 0;
    let resizeInFlight = false;
    let pendingResize = false;
    let rafId: number | null = null;
    let disposed = false;

    // PTY-first resize: calculate desired dimensions, resize the PTY, then resize the
    // frontend terminal to match.
    //
    // This eliminates the race that causes output clobbering when the frontend resizes
    // before the PTY (shell output is formatted for old dimensions but displayed in the
    // already-resized frontend terminal).
    const doResize = async () => {
      if (!fitAddonRef.current) return;

      // Calculate what size we want without applying it yet.
      // (fit() would resize the frontend immediately, reintroducing the race.)
      const proposed = fitAddonRef.current.proposeDimensions();
      if (!proposed) return;

      const { cols, rows } = proposed;
      if (cols === lastCols && rows === lastRows) return;

      // Record the requested dimensions up front so we don't re-request the same resize
      // if more resize events arrive while awaiting the backend.
      lastCols = cols;
      lastRows = rows;

      try {
        // Resize PTY first - wait for backend to confirm.
        await router.resize(sessionId, cols, rows);

        if (disposed) {
          return;
        }

        // Now resize frontend to match the PTY *exactly*.
        // We intentionally do NOT call fit() here because it can recompute dimensions
        // (if the container changed while awaiting) and would resize the frontend without
        // resizing the PTY, reintroducing the mismatch.
        termRef.current?.resize(cols, rows);
      } catch (err) {
        // Allow future retries if the resize call failed.
        lastCols = 0;
        lastRows = 0;
        console.error("[TerminalView] Error resizing terminal:", err);
      }
    };

    const handleResize = () => {
      if (disposed) {
        return;
      }

      // If a resize is already in flight, mark that we need another one
      if (resizeInFlight) {
        pendingResize = true;
        return;
      }

      resizeInFlight = true;
      pendingResize = false;

      // Use RAF to batch rapid resize events (e.g., window drag)
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
      }

      rafId = requestAnimationFrame(() => {
        rafId = null;

        void doResize().finally(() => {
          resizeInFlight = false;
          // If another resize was requested while we were busy, handle it
          if (pendingResize) {
            handleResize();
          }
        });
      });
    };

    const resizeObserver = new ResizeObserver(handleResize);
    resizeObserver.observe(containerRef.current);

    // Also listen to window resize as backup
    window.addEventListener("resize", handleResize);

    return () => {
      disposed = true;
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
      }
      resizeObserver.disconnect();
      window.removeEventListener("resize", handleResize);
    };
  }, [visible, terminalReady, router, sessionId]);

  const errorMessage = terminalError;

  // Focus the terminal when the container is clicked
  const handleContainerClick = useCallback(() => {
    if (termRef.current) {
      termRef.current.focus();
    }
  }, []);

  // Show loading overlay until we receive initial screen state
  const showLoading = isLoading && terminalReady && visible;

  return (
    <div
      className="terminal-view"
      style={{
        display: visible ? "flex" : "none",
        flexDirection: "column",
        width: "100%",
        height: "100%",
        minHeight: 0,
        backgroundColor: "var(--color-terminal-bg)",
        position: "relative",
      }}
      onClick={handleContainerClick}
    >
      {errorMessage && (
        <div className="border-b border-red-900/30 bg-red-900/20 p-2 text-sm text-red-400">
          Terminal Error: {errorMessage}
        </div>
      )}
      <div
        ref={containerRef}
        className="terminal-container"
        style={{
          flex: 1,
          minHeight: 0,
          width: "100%",
          overflow: "hidden",
          // ghostty-web uses a contenteditable root for input; hide the browser caret
          // so we don't show a "second cursor".
          caretColor: "transparent",
          // Hide terminal content while loading to prevent flash
          visibility: showLoading ? "hidden" : "visible",
        }}
      />
      {/* Loading overlay - shows until we receive screen state from backend */}
      {showLoading && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: "var(--color-terminal-bg)",
          }}
        >
          <span className="text-muted animate-pulse text-sm">Connecting...</span>
        </div>
      )}
    </div>
  );
}
