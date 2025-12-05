import { useState, useEffect, useCallback, useRef } from "react";
import { useAPI } from "@/browser/contexts/API";

import type { TerminalSession } from "@/common/types/terminal";

/**
 * Hook to manage terminal IPC session lifecycle.
 *
 * Supports two modes:
 * 1. Create new session: when existingSessionId is undefined, creates a new PTY session
 * 2. Reattach to existing session: when existingSessionId is provided (e.g., from openInEditor),
 *    subscribes to that session without creating a new one
 */
export function useTerminalSession(
  workspaceId: string,
  existingSessionId: string | undefined,
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

  // Track whether we created the session (vs reattaching to existing)
  // Used to determine if we should close the session on cleanup
  const createdSessionRef = useRef(false);

  // Watch for terminalSize to become available
  useEffect(() => {
    if (enabled && terminalSize && !shouldInit) {
      setShouldInit(true);
    }
  }, [enabled, terminalSize, shouldInit]);

  // Create terminal session and subscribe to IPC events
  // Only depends on workspaceId, existingSessionId and shouldInit, NOT terminalSize
  useEffect(() => {
    if (!shouldInit || !terminalSize || !api) {
      return;
    }

    let mounted = true;
    let targetSessionId: string | null = null;
    const cleanupFns: Array<() => void> = [];

    const initSession = async () => {
      try {
        if (existingSessionId) {
          // Reattach to existing session (e.g., from openInEditor)
          // The session was already created by the backend with initialCommand
          targetSessionId = existingSessionId;
          createdSessionRef.current = false;
        } else {
          // Create new terminal session with current terminal size
          const session: TerminalSession = await api.terminal.create({
            workspaceId,
            cols: terminalSize.cols,
            rows: terminalSize.rows,
          });

          if (!mounted) {
            return;
          }

          targetSessionId = session.sessionId;
          createdSessionRef.current = true;
        }

        setSessionId(targetSessionId);

        const abortController = new AbortController();
        const { signal } = abortController;

        // Subscribe to output events via ORPC async iterator
        // Fire and forget async loop
        (async () => {
          try {
            const iterator = await api.terminal.onOutput(
              { sessionId: targetSessionId },
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
            const iterator = await api.terminal.onExit({ sessionId: targetSessionId }, { signal });
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
        console.error("[Terminal] Failed to initialize terminal session:", err);
        if (mounted) {
          setError(err instanceof Error ? err.message : "Failed to initialize terminal");
        }
      }
    };

    void initSession();

    return () => {
      mounted = false;

      // Unsubscribe from IPC events
      cleanupFns.forEach((fn) => fn());

      // Only close the session if WE created it (not for reattached sessions)
      // Reattached sessions (e.g., from openInEditor) should persist when the window closes
      if (targetSessionId && createdSessionRef.current) {
        void api?.terminal.close({ sessionId: targetSessionId });
      }

      // Reset init flag so a new session can be created if workspace changes
      setShouldInit(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, existingSessionId, shouldInit, api]); // DO NOT include terminalSize - changes should not recreate session

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
