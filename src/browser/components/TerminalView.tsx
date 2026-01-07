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
  const [isFocused, setIsFocused] = useState(false);
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
    term.clear();

    const unsubscribe = router.subscribe(sessionId, {
      onOutput: (data) => {
        term.write(data);
      },
      onScreenState: (state) => {
        // Write screen state (may be empty for new sessions)
        if (state) {
          term.write(state);
        }
        // Mark loading complete - we now have valid content to show
        setIsLoading(false);
      },
      onExit: (code) => {
        term.write(`\r\n[Process exited with code ${code}]\r\n`);
      },
    });

    // Send initial resize to sync PTY dimensions
    const { cols, rows } = term;
    router.resize(sessionId, cols, rows);

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
      setIsFocused(true);
      if (termRef.current) {
        termRef.current.options.cursorBlink = true;
      }
    };

    const handleFocusOut = (e: FocusEvent) => {
      // Only blur if focus is leaving the container entirely
      if (!container.contains(e.relatedTarget as Node)) {
        setIsFocused(false);
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
    let resizeTimeoutId: ReturnType<typeof setTimeout> | null = null;
    let pendingResize: { cols: number; rows: number } | null = null;

    // Use both ResizeObserver (for container changes) and window resize (as backup)
    const handleResize = () => {
      if (fitAddonRef.current && termRef.current) {
        try {
          // Resize terminal UI to fit container immediately for responsive UX
          fitAddonRef.current.fit();

          // Get new dimensions
          const { cols, rows } = termRef.current;

          // Only process if dimensions actually changed
          if (cols === lastCols && rows === lastRows) {
            return;
          }

          lastCols = cols;
          lastRows = rows;

          // Store pending resize
          pendingResize = { cols, rows };

          // Always debounce PTY resize to prevent vim corruption
          // Clear any pending timeout and set a new one
          if (resizeTimeoutId !== null) {
            clearTimeout(resizeTimeoutId);
          }

          resizeTimeoutId = setTimeout(() => {
            if (pendingResize) {
              // Double requestAnimationFrame to ensure vim is ready
              requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                  if (pendingResize) {
                    router.resize(sessionId, pendingResize.cols, pendingResize.rows);
                    pendingResize = null;
                  }
                });
              });
            }
            resizeTimeoutId = null;
          }, 300); // 300ms debounce - enough time for vim to stabilize
        } catch (err) {
          console.error("[TerminalView] Error fitting terminal:", err);
        }
      }
    };

    const resizeObserver = new ResizeObserver(handleResize);
    resizeObserver.observe(containerRef.current);

    // Also listen to window resize as backup
    window.addEventListener("resize", handleResize);

    return () => {
      if (resizeTimeoutId !== null) {
        clearTimeout(resizeTimeoutId);
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
          // Subtle focus indicator: inner glow when focused
          boxShadow: isFocused ? "inset 0 0 0 1px var(--color-accent)" : "none",
          transition: "box-shadow 0.15s ease-in-out",
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
          <span className="text-muted text-sm animate-pulse">Connecting...</span>
        </div>
      )}
    </div>
  );
}
