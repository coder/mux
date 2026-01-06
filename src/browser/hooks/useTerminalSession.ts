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
  onExit?: (exitCode: number) => void,
  options?: {
    /**
     * Whether to close PTY sessions that were created by this hook when the hook cleans up.
     *
     * Default: true.
     *
     * Set to false for "keep alive" terminals (e.g. right sidebar) where switching workspaces
     * should preserve the session for later re-attach.
     */
    closeOnCleanup?: boolean;
    /**
     * Called with serialized screen state when reattaching to an existing session.
     * This allows the frontend to restore terminal view instantly before live streaming begins.
     * The state is VT escape sequences that reconstruct the current screen (~4KB).
     */
    onScreenState?: (state: string) => void;
  }
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

    const createNewSession = async (): Promise<string> => {
      const session: TerminalSession = await api.terminal.create({
        workspaceId,
        cols: terminalSize.cols,
        rows: terminalSize.rows,
      });
      createdSessionRef.current = true;
      return session.sessionId;
    };

    const subscribeToSession = (sid: string, signal: AbortSignal, onSessionInvalid: () => void) => {
      // Subscribe to output events via ORPC async iterator
      (async () => {
        try {
          const iterator = await api.terminal.onOutput({ sessionId: sid }, { signal });
          for await (const data of iterator) {
            if (!mounted) break;
            if (onOutput) onOutput(data);
          }
        } catch (err) {
          if (!signal.aborted) {
            // Check if this is a "session not found" type error (stale session)
            const errMsg = err instanceof Error ? err.message : String(err);
            if (errMsg.includes("isOpen") || errMsg.includes("undefined")) {
              console.warn("[Terminal] Session appears stale, will create new session");
              onSessionInvalid();
            } else {
              console.error("[Terminal] Output stream error:", err);
            }
          }
        }
      })();

      // Subscribe to exit events via ORPC async iterator
      (async () => {
        try {
          const iterator = await api.terminal.onExit({ sessionId: sid }, { signal });
          for await (const code of iterator) {
            if (!mounted) break;
            setConnected(false);
            if (onExit) onExit(code);
            break; // Exit happens only once
          }
        } catch (err) {
          if (!signal.aborted) {
            // Ignore stale session errors for exit stream (onOutput handler will deal with it)
            const errMsg = err instanceof Error ? err.message : String(err);
            if (!errMsg.includes("isOpen") && !errMsg.includes("undefined")) {
              console.error("[Terminal] Exit stream error:", err);
            }
          }
        }
      })();
    };

    const initSession = async () => {
      try {
        const abortController = new AbortController();
        const { signal } = abortController;
        cleanupFns.push(() => abortController.abort());

        // Flag to track if we need to recreate the session due to stale ID
        let needsRecreate = false;

        if (existingSessionId) {
          // Try to reattach to existing session (e.g., keep-alive terminal)
          targetSessionId = existingSessionId;
          createdSessionRef.current = false;

          // Fetch serialized screen state to restore terminal view instantly before live streaming
          if (options?.onScreenState) {
            try {
              const screenState = await api.terminal.getScreenState({
                sessionId: existingSessionId,
              });
              if (mounted && screenState) {
                options.onScreenState(screenState);
              }
            } catch (err) {
              // If state fetch fails, continue anyway - live stream will still work
              console.warn("[Terminal] Failed to fetch screen state:", err);
            }
          }

          // Set up subscription with a callback for invalid session detection
          subscribeToSession(targetSessionId, signal, () => {
            needsRecreate = true;
          });

          // Give the subscription a brief moment to fail if session is stale
          await new Promise((resolve) => setTimeout(resolve, 100));

          if (needsRecreate && mounted) {
            console.log("[Terminal] Creating new session after stale session detected");
            abortController.abort();
            // Create a new abort controller for the new session
            const newAbortController = new AbortController();
            cleanupFns.push(() => newAbortController.abort());

            targetSessionId = await createNewSession();
            if (!mounted) return;

            subscribeToSession(targetSessionId, newAbortController.signal, () => {
              // If this one fails too, just show error
              if (mounted) {
                setError("Failed to establish terminal session");
              }
            });
          }
        } else {
          // Create new terminal session with current terminal size
          targetSessionId = await createNewSession();
          if (!mounted) return;

          subscribeToSession(targetSessionId, signal, () => {
            // Newly created session shouldn't be stale
            if (mounted) {
              setError("Terminal session unexpectedly invalid");
            }
          });
        }

        setSessionId(targetSessionId);
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

      const closeOnCleanup = options?.closeOnCleanup ?? true;

      // Only close the session if WE created it (not for reattached sessions)
      // Reattached sessions (e.g., from openInEditor) should persist when the window closes
      if (closeOnCleanup && targetSessionId && createdSessionRef.current) {
        void api?.terminal.close({ sessionId: targetSessionId });
      }

      // Reset init flag so a new session can be created if workspace changes
      setShouldInit(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, existingSessionId, shouldInit, api, options?.closeOnCleanup]); // DO NOT include terminalSize - changes should not recreate session

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
