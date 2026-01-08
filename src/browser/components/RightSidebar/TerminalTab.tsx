import React from "react";
import { TerminalView } from "@/browser/components/TerminalView";
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
// Intentionally not persisted across reloads: backend sessions won't survive a restart.
// Sessions persist while the app runs to allow quick workspace switching without losing
// terminal state. Backend cleanup happens on workspace deletion (workspaceService calls
// terminalService.closeWorkspaceSessions) and app restart.
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
  // Dummy state to trigger re-render when session is set (since Map mutation doesn't cause re-render)
  const [, forceUpdate] = React.useReducer((x: number) => x + 1, 0);

  const instanceId = getTerminalInstanceId(props.tabType);
  const sessionKey = makeSessionKey(props.workspaceId, instanceId);

  // Read sessionId directly from the Map to ensure it always matches the current workspaceId.
  // Using useState with useEffect caused a timing bug: when workspaceId changed, the old sessionId
  // was passed to TerminalView before the effect could sync the new value.
  const existingSessionId = terminalSessions.get(sessionKey);

  const handleSessionId = React.useCallback(
    (sid: string) => {
      terminalSessions.set(sessionKey, sid);
      forceUpdate();
    },
    [sessionKey]
  );

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
