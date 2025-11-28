import { useRef, useEffect, useState } from "react";
import { Terminal, FitAddon } from "ghostty-web";
import { useTerminalSession } from "@/browser/hooks/useTerminalSession";
import { useAPI } from "@/browser/contexts/API";

interface TerminalViewProps {
  workspaceId: string;
  sessionId?: string;
  visible: boolean;
}

export function TerminalView({ workspaceId, sessionId, visible }: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const [terminalError, setTerminalError] = useState<string | null>(null);
  const [terminalReady, setTerminalReady] = useState(false);
  const [terminalSize, setTerminalSize] = useState<{ cols: number; rows: number } | null>(null);

  // Handler for terminal output
  const handleOutput = (data: string) => {
    const term = termRef.current;
    if (term) {
      term.write(data);
    }
  };

  // Handler for terminal exit
  const handleExit = (exitCode: number) => {
    const term = termRef.current;
    if (term) {
      term.write(`\r\n[Process exited with code ${exitCode}]\r\n`);
    }
  };

  const { api } = useAPI();

  // Set window title
  useEffect(() => {
    if (!api) return;
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
  }, [api, workspaceId]);
  const {
    sendInput,
    resize,
    error: sessionError,
  } = useTerminalSession(workspaceId, sessionId, visible, terminalSize, handleOutput, handleExit);

  // Keep refs to latest functions so callbacks always use current version
  const sendInputRef = useRef(sendInput);
  const resizeRef = useRef(resize);

  useEffect(() => {
    sendInputRef.current = sendInput;
    resizeRef.current = resize;
  }, [sendInput, resize]);

  // Initialize terminal when visible
  useEffect(() => {
    if (!containerRef.current || !visible) {
      return;
    }

    let terminal: Terminal | null = null;

    const initTerminal = async () => {
      try {
        terminal = new Terminal({
          fontSize: 13,
          fontFamily: "Monaco, Menlo, 'Courier New', monospace",
          cursorBlink: true,
          theme: {
            background: "#1e1e1e",
            foreground: "#d4d4d4",
            cursor: "#d4d4d4",
            cursorAccent: "#1e1e1e",
            selectionBackground: "#264f78",
            black: "#000000",
            red: "#cd3131",
            green: "#0dbc79",
            yellow: "#e5e510",
            blue: "#2472c8",
            magenta: "#bc3fbc",
            cyan: "#11a8cd",
            white: "#e5e5e5",
            brightBlack: "#666666",
            brightRed: "#f14c4c",
            brightGreen: "#23d18b",
            brightYellow: "#f5f543",
            brightBlue: "#3b8eea",
            brightMagenta: "#d670d6",
            brightCyan: "#29b8db",
            brightWhite: "#ffffff",
          },
        });

        const fitAddon = new FitAddon();
        terminal.loadAddon(fitAddon);

        await terminal.open(containerRef.current!);
        fitAddon.fit();

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
        terminal.onData((data: string) => {
          sendInputRef.current(data);
        });

        termRef.current = terminal;
        fitAddonRef.current = fitAddon;
        setTerminalReady(true);
      } catch (err) {
        console.error("Failed to initialize terminal:", err);
        setTerminalError(err instanceof Error ? err.message : "Failed to initialize terminal");
      }
    };

    void initTerminal();

    return () => {
      if (terminal) {
        terminal.dispose();
      }
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
        width: "100%",
        height: "100%",
        backgroundColor: "#1e1e1e",
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
          width: "100%",
          height: "100%",
          overflow: "hidden",
        }}
      />
    </div>
  );
}
