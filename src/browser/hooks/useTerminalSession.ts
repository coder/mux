import { useState, useEffect, useCallback } from "react";
import { useAPI } from "@/browser/contexts/API";

import type { TerminalSession } from "@/common/types/terminal";

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
  const { api } = useAPI();
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
    if (!shouldInit || !terminalSize || !api) {
      return;
    }

    let mounted = true;
    let createdSessionId: string | null = null; // Track session ID in closure
    const cleanupFns: Array<() => void> = [];

    const initSession = async () => {
      try {
        // Create terminal session with current terminal size
        const session: TerminalSession = await api.terminal.create({
          workspaceId,
          cols: terminalSize.cols,
          rows: terminalSize.rows,
        });

        if (!mounted) {
          return;
        }

        createdSessionId = session.sessionId; // Store in closure
        setSessionId(session.sessionId);

        const abortController = new AbortController();
        const { signal } = abortController;

        // Subscribe to output events via ORPC async iterator
        // Fire and forget async loop
        (async () => {
          try {
            const iterator = await api.terminal.onOutput(
              { sessionId: session.sessionId },
              { signal }
            );
            for await (const data of iterator) {
              if (!mounted) break;
              if (onOutput) onOutput(data);
            }
          } catch (err) {
            if (!signal.aborted) {
              console.error("[Terminal] Output stream error:", err);
            }
          }
        })();

        // Subscribe to exit events via ORPC async iterator
        (async () => {
          try {
            const iterator = await api.terminal.onExit(
              { sessionId: session.sessionId },
              { signal }
            );
            for await (const code of iterator) {
              if (!mounted) break;
              setConnected(false);
              if (onExit) onExit(code);
              break; // Exit happens only once
            }
          } catch (err) {
            if (!signal.aborted) {
              console.error("[Terminal] Exit stream error:", err);
            }
          }
        })();

        cleanupFns.push(() => abortController.abort());
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
        void api?.terminal.close({ sessionId: createdSessionId });
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
        void api?.terminal.sendInput({ sessionId, data });
      }
    },
    [sessionId, api]
  );

  // Resize terminal
  const resize = useCallback(
    (cols: number, rows: number) => {
      if (sessionId) {
        void api?.terminal.resize({ sessionId, cols, rows });
      }
    },
    [sessionId, api]
  );

  return {
    connected,
    sessionId,
    error,
    sendInput,
    resize,
  };
}
