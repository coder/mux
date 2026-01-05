import { useRef, useEffect, useState } from "react";
import { init, Terminal, FitAddon } from "ghostty-web";
import { useTerminalSession } from "@/browser/hooks/useTerminalSession";
import { useAPI } from "@/browser/contexts/API";

interface TerminalViewProps {
  workspaceId: string;
  /** Optional existing session id to reattach to (e.g. keep-alive terminals) */
  sessionId?: string;
  visible: boolean;
  /**
   * Whether to set document.title based on workspace name.
   *
   * Default: true (used by the dedicated terminal window).
   * Set to false when embedding inside the app (e.g. RightSidebar).
   */
  setDocumentTitle?: boolean;
  /**
   * Whether to close sessions created by this view when it cleans up.
   * Default: true.
   */
  closeOnCleanup?: boolean;
  /** Called when the terminal session id becomes available (created or reattached). */
  onSessionId?: (sessionId: string) => void;
}

export function TerminalView({
  workspaceId,
  sessionId,
  visible,
  setDocumentTitle = true,
  closeOnCleanup = true,
  onSessionId,
}: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const [terminalError, setTerminalError] = useState<string | null>(null);

  // Buffer output while the terminal UI is not mounted (e.g., tab hidden).
  // This preserves output for keep-alive sessions without keeping the WASM terminal instance alive.
  const outputBufferRef = useRef<string[]>([]);
  const outputBufferBytesRef = useRef(0);
  const MAX_BUFFER_BYTES = 512 * 1024; // 512KiB cap to prevent runaway memory

  const bufferOutput = (data: string) => {
    outputBufferRef.current.push(data);
    outputBufferBytesRef.current += data.length;

    // Trim from the front until we are within the limit.
    while (outputBufferBytesRef.current > MAX_BUFFER_BYTES && outputBufferRef.current.length > 0) {
      const removed = outputBufferRef.current.shift();
      if (removed) {
        outputBufferBytesRef.current -= removed.length;
      }
    }
  };

  const flushOutputBuffer = () => {
    const term = termRef.current;
    if (!term) return;

    const chunks = outputBufferRef.current;
    if (chunks.length === 0) return;

    term.write(chunks.join(""));
    outputBufferRef.current = [];
    outputBufferBytesRef.current = 0;
  };

  const clearOutputBuffer = () => {
    outputBufferRef.current = [];
    outputBufferBytesRef.current = 0;
  };

  // Clear output buffer when workspaceId changes to prevent cross-workspace contamination.
  // The buffer is meant for keep-alive sessions within a single workspace, not across workspaces.
  const prevWorkspaceIdRef = useRef(workspaceId);
  useEffect(() => {
    if (prevWorkspaceIdRef.current !== workspaceId) {
      clearOutputBuffer();
      prevWorkspaceIdRef.current = workspaceId;
    }
  }, [workspaceId]);

  const [terminalReady, setTerminalReady] = useState(false);
  const [terminalSize, setTerminalSize] = useState<{ cols: number; rows: number } | null>(null);

  // Handler for terminal output
  const handleOutput = (data: string) => {
    const term = termRef.current;
    if (term) {
      term.write(data);
    } else {
      bufferOutput(data);
    }
  };

  // Handler for terminal exit
  const handleExit = (exitCode: number) => {
    const msg = `\r\n[Process exited with code ${exitCode}]\r\n`;
    const term = termRef.current;
    if (term) {
      term.write(msg);
    } else {
      bufferOutput(msg);
    }
  };

  const { api } = useAPI();

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
  const {
    sendInput,
    resize,
    sessionId: activeSessionId,
    error: sessionError,
  } = useTerminalSession(workspaceId, sessionId, visible, terminalSize, handleOutput, handleExit, {
    closeOnCleanup,
  });

  useEffect(() => {
    if (!activeSessionId) return;
    onSessionId?.(activeSessionId);
  }, [activeSessionId, onSessionId]);

  // Keep refs to latest functions so callbacks always use current version
  const sendInputRef = useRef(sendInput);
  const resizeRef = useRef(resize);

  useEffect(() => {
    sendInputRef.current = sendInput;
    resizeRef.current = resize;
  }, [sendInput, resize]);

  // Initialize terminal when visible
  useEffect(() => {
    const containerEl = containerRef.current;
    if (!containerEl || !visible) {
      return;
    }

    // StrictMode will run this effect twice in dev (setup → cleanup → setup).
    // If the first async init completes after cleanup, we can end up with two ghostty-web
    // terminals wired to the same DOM node (double cursor + duplicated input). Make the
    // init path explicitly cancelable.
    let cancelled = false;

    let terminal: Terminal | null = null;
    let disposeOnData: { dispose: () => void } | null = null;

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
          fontSize: 14,
          fontFamily: "JetBrains Mono, Menlo, Monaco, monospace",
          cursorBlink: true,
          theme: {
            background: terminalBg,
            foreground: terminalFg,
          },
        });

        const fitAddon = new FitAddon();
        terminal.loadAddon(fitAddon);

        terminal.open(containerEl);
        fitAddon.fit();

        // ghostty-web focuses the container (contenteditable) on open(), which can show a
        // browser caret in addition to the terminal cursor. Focus the hidden textarea instead.
        const textarea = containerEl.querySelector("textarea");
        if (textarea instanceof HTMLTextAreaElement) {
          textarea.focus();
        }

        const { cols, rows } = terminal;

        // Set terminal size so PTY session can be created with matching dimensions
        // Use stable object reference to prevent unnecessary effect re-runs
        setTerminalSize((prev) => {
          if (prev?.cols === cols && prev?.rows === rows) {
            return prev;
          }
          return { cols, rows };
        });

        // User input → IPC (use ref to always get latest sendInput)
        disposeOnData = terminal.onData((data: string) => {
          sendInputRef.current(data);
        });

        termRef.current = terminal;
        fitAddonRef.current = fitAddon;

        // Flush any buffered output collected while this view was hidden.
        flushOutputBuffer();

        setTerminalReady(true);
      } catch (err) {
        if (cancelled) {
          return;
        }

        console.error("Failed to initialize terminal:", err);
        setTerminalError(err instanceof Error ? err.message : "Failed to initialize terminal");
      }
    };

    void initTerminal();

    return () => {
      cancelled = true;

      disposeOnData?.dispose();

      if (terminal) {
        terminal.dispose();
      }

      // Ensure the DOM is clean even if the terminal init was interrupted.
      containerEl.replaceChildren();

      termRef.current = null;
      fitAddonRef.current = null;
      setTerminalReady(false);
      setTerminalSize(null);
    };
    // Note: sendInput and resize are intentionally not in deps
    // They're used in callbacks, not during effect execution
  }, [visible, workspaceId]);

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

          // Update state (with stable reference to prevent unnecessary re-renders)
          setTerminalSize((prev) => {
            if (prev?.cols === cols && prev?.rows === rows) {
              return prev;
            }
            return { cols, rows };
          });

          // Store pending resize
          pendingResize = { cols, rows };

          // Always debounce PTY resize to prevent vim corruption
          // Clear any pending timeout and set a new one
          if (resizeTimeoutId !== null) {
            clearTimeout(resizeTimeoutId);
          }

          resizeTimeoutId = setTimeout(() => {
            if (pendingResize) {
              console.log(
                `[TerminalView] Sending resize to PTY: ${pendingResize.cols}x${pendingResize.rows}`
              );
              // Double requestAnimationFrame to ensure vim is ready
              requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                  if (pendingResize) {
                    resizeRef.current(pendingResize.cols, pendingResize.rows);
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
  }, [visible, terminalReady]); // terminalReady ensures ResizeObserver is set up after terminal is initialized

  if (!visible) return null;

  const errorMessage = terminalError ?? sessionError;

  return (
    <div
      className="terminal-view"
      style={{
        display: "flex",
        flexDirection: "column",
        width: "100%",
        height: "100%",
        minHeight: 0,
        backgroundColor: "var(--color-terminal-bg)",
      }}
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
        }}
      />
    </div>
  );
}
