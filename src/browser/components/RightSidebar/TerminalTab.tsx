import React from "react";
import { TerminalView } from "@/browser/components/TerminalView";
import { useAPI } from "@/browser/contexts/API";
import type { TabType } from "@/browser/types/rightSidebar";
import { getTerminalInstanceId } from "@/browser/types/rightSidebar";

/**
 * Key for terminal session storage: combines workspaceId and optional instanceId.
 * Format: "workspaceId" for default terminal, "workspaceId:instanceId" for additional terminals.
 */
function makeSessionKey(workspaceId: string, instanceId?: string): string {
  return instanceId ? `${workspaceId}:${instanceId}` : workspaceId;
}

// In-memory keep-alive mapping for terminal sessions.
// Key is "workspaceId" or "workspaceId:instanceId" for multiple terminals.
// Survives workspace switching; on page reload, we query backend for existing sessions.
// Backend cleanup happens on workspace deletion and server restart.
const terminalSessions = new Map<string, string>();

/**
 * Get the current terminal session ID for a workspace+instance (if one exists).
 * Used by pop-out to hand off the session to a new window.
 */
export function getTerminalSessionId(workspaceId: string, instanceId?: string): string | undefined {
  return terminalSessions.get(makeSessionKey(workspaceId, instanceId));
}

/**
 * Release a terminal session from the embedded terminal.
 * Called after pop-out so the embedded terminal stops controlling the session.
 */
export function releaseTerminalSession(workspaceId: string, instanceId?: string): void {
  terminalSessions.delete(makeSessionKey(workspaceId, instanceId));
}

interface TerminalTabProps {
  workspaceId: string;
  /** The tab type (e.g., "terminal" or "terminal:2") */
  tabType: TabType;
  visible: boolean;
  /** Called when terminal title changes (from shell OSC sequences) */
  onTitleChange?: (title: string) => void;
}

export const TerminalTab: React.FC<TerminalTabProps> = (props) => {
  const { api } = useAPI();
  // Dummy state to trigger re-render when session is set (since Map mutation doesn't cause re-render)
  const [, forceUpdate] = React.useReducer((x: number) => x + 1, 0);
  // Track if we've checked the backend for existing sessions for this workspace
  const [checkedBackend, setCheckedBackend] = React.useState(false);

  const instanceId = getTerminalInstanceId(props.tabType);
  const sessionKey = makeSessionKey(props.workspaceId, instanceId);

  // On mount or workspace change, query backend for existing sessions.
  // This enables reattach after page reload (backend sessions survive, frontend doesn't).
  React.useEffect(() => {
    if (!api) return;

    // Skip if we already have a session in memory (no need to query)
    if (terminalSessions.has(sessionKey)) {
      setCheckedBackend(true);
      return;
    }

    setCheckedBackend(false);
    let cancelled = false;

    api.terminal
      .listSessions({ workspaceId: props.workspaceId })
      .then((sessionIds) => {
        if (cancelled) return;

        // Find matching session for this instance.
        // Sessions are named "${workspaceId}-${timestamp}", so we can match by prefix.
        // For multi-terminal support, we'd need additional metadata on the backend.
        // For now, pick the first session if this is the default terminal instance.
        if (sessionIds.length > 0 && !instanceId) {
          // Default terminal instance: use first session
          terminalSessions.set(sessionKey, sessionIds[0]);
          forceUpdate();
        }
        // Additional terminal instances (instanceId != undefined) won't auto-reattach
        // since we can't distinguish which backend session maps to which instance.
        // They'll create new sessions, which is acceptable behavior.

        setCheckedBackend(true);
      })
      .catch(() => {
        // On error, proceed without existing session (will create new)
        if (!cancelled) setCheckedBackend(true);
      });

    return () => {
      cancelled = true;
    };
  }, [api, props.workspaceId, sessionKey, instanceId]);

  // Read sessionId directly from the Map to ensure it always matches the current workspaceId.
  const existingSessionId = terminalSessions.get(sessionKey);

  const handleSessionId = React.useCallback(
    (sid: string) => {
      terminalSessions.set(sessionKey, sid);
      forceUpdate();
    },
    [sessionKey]
  );

  // Don't render TerminalView until we've checked the backend for existing sessions.
  // This prevents creating a new session when one already exists.
  if (!checkedBackend) {
    return null;
  }

  return (
    <TerminalView
      workspaceId={props.workspaceId}
      sessionId={existingSessionId}
      visible={props.visible}
      setDocumentTitle={false}
      // Keep session alive: cleanup happens on workspace deletion or app restart
      closeOnCleanup={false}
      onSessionId={handleSessionId}
      onTitleChange={props.onTitleChange}
    />
  );
};
