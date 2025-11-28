import { useState, useEffect, useCallback } from "react";

/**
 * Hook to manage terminal IPC session lifecycle
 */
export function useTerminalSession(
  workspaceId: string,
  _existingSessionId: string | undefined, // Reserved for future use (session reload support)
  enabled: boolean,
  terminalSize?: { cols: number; rows: number } | null,
  onOutput?: (data: string) => void,
  onExit?: (exitCode: number) => void
) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shouldInit, setShouldInit] = useState(false);

  // Watch for terminalSize to become available
  useEffect(() => {
    if (enabled && terminalSize && !shouldInit) {
      setShouldInit(true);
    }
  }, [enabled, terminalSize, shouldInit]);

  // Create terminal session and subscribe to IPC events
  // Only depends on workspaceId and shouldInit, NOT terminalSize
  useEffect(() => {
    if (!shouldInit || !terminalSize) {
      return;
    }

    let mounted = true;
    let createdSessionId: string | null = null; // Track session ID in closure
    let cleanupFns: Array<() => void> = [];

    const initSession = async () => {
      try {
        // Check if window.api is available
        if (!window.api) {
          throw new Error("window.api is not available - preload script may not have loaded");
        }
        if (!window.api.terminal) {
          throw new Error("window.api.terminal is not available");
        }

        // Create terminal session with current terminal size
        const session = await window.api.terminal.create({
          workspaceId,
          cols: terminalSize.cols,
          rows: terminalSize.rows,
        });

        if (!mounted) {
          return;
        }

        createdSessionId = session.sessionId; // Store in closure
        setSessionId(session.sessionId);

        // Subscribe to output events
        const unsubOutput = window.api.terminal.onOutput(createdSessionId, (data: string) => {
          if (onOutput) {
            onOutput(data);
          }
        });

        // Subscribe to exit events
        const unsubExit = window.api.terminal.onExit(createdSessionId, (exitCode: number) => {
          if (mounted) {
            setConnected(false);
          }
          if (onExit) {
            onExit(exitCode);
          }
        });

        cleanupFns = [unsubOutput, unsubExit];
        setConnected(true);
        setError(null);
      } catch (err) {
        console.error("[Terminal] Failed to create terminal session:", err);
        if (mounted) {
          setError(err instanceof Error ? err.message : "Failed to create terminal");
        }
      }
    };

    void initSession();

    return () => {
      mounted = false;

      // Unsubscribe from IPC events
      cleanupFns.forEach((fn) => fn());

      // Close terminal session using the closure variable
      // This ensures we close the session created by this specific effect run
      if (createdSessionId) {
        void window.api.terminal.close(createdSessionId);
      }

      // Reset init flag so a new session can be created if workspace changes
      setShouldInit(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, shouldInit]); // DO NOT include terminalSize - changes should not recreate session

  // Send input to terminal
  const sendInput = useCallback(
    (data: string) => {
      if (sessionId) {
        window.api.terminal.sendInput(sessionId, data);
      }
    },
    [sessionId]
  );

  // Resize terminal
  const resize = useCallback(
    (cols: number, rows: number) => {
      if (sessionId) {
        void window.api.terminal.resize({ sessionId, cols, rows });
      }
    },
    [sessionId]
  );

  return {
    connected,
    sessionId,
    error,
    sendInput,
    resize,
  };
}
