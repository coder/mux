import React from "react";
import { TerminalView } from "@/browser/components/TerminalView";

// In-memory keep-alive mapping for terminal sessions per workspace.
// Intentionally not persisted across reloads: backend sessions won't survive a restart.
// Sessions persist while the app runs to allow quick workspace switching without losing
// terminal state. Backend cleanup happens on workspace deletion (workspaceService calls
// terminalService.closeWorkspaceSessions) and app restart.
const terminalSessionsByWorkspaceId = new Map<string, string>();

/**
 * Get the current terminal session ID for a workspace (if one exists).
 * Used by pop-out to hand off the session to a new window.
 */
export function getTerminalSessionId(workspaceId: string): string | undefined {
  return terminalSessionsByWorkspaceId.get(workspaceId);
}

/**
 * Release a terminal session from the embedded terminal.
 * Called after pop-out so the embedded terminal stops controlling the session.
 */
export function releaseTerminalSession(workspaceId: string): void {
  terminalSessionsByWorkspaceId.delete(workspaceId);
}

interface TerminalTabProps {
  workspaceId: string;
  visible: boolean;
  /** If true, terminal was popped out - show placeholder instead */
  poppedOut?: boolean;
}

export const TerminalTab: React.FC<TerminalTabProps> = ({ workspaceId, visible, poppedOut }) => {
  // Dummy state to trigger re-render when session is set (since Map mutation doesn't cause re-render)
  const [, forceUpdate] = React.useReducer((x: number) => x + 1, 0);

  // Read sessionId directly from the Map to ensure it always matches the current workspaceId.
  // Using useState with useEffect caused a timing bug: when workspaceId changed, the old sessionId
  // was passed to TerminalView before the effect could sync the new value.
  const existingSessionId = terminalSessionsByWorkspaceId.get(workspaceId);

  const handleSessionId = React.useCallback(
    (sid: string) => {
      terminalSessionsByWorkspaceId.set(workspaceId, sid);
      forceUpdate();
    },
    [workspaceId]
  );

  // When popped out, don't render the terminal - the session is now owned by the pop-out window
  if (poppedOut) {
    return (
      <div className="text-muted flex h-full items-center justify-center text-sm">
        Terminal opened in separate window
      </div>
    );
  }

  return (
    <TerminalView
      workspaceId={workspaceId}
      sessionId={existingSessionId}
      visible={visible}
      setDocumentTitle={false}
      // Keep session alive: cleanup happens on workspace deletion or app restart
      closeOnCleanup={false}
      onSessionId={handleSessionId}
    />
  );
};
