import React from "react";
import { TerminalView } from "@/browser/components/TerminalView";

// In-memory keep-alive mapping for terminal sessions per workspace.
// Intentionally not persisted across reloads: backend sessions won't survive a restart.
// Sessions persist while the app runs to allow quick workspace switching without losing
// terminal state. Backend cleanup happens on workspace deletion (workspaceService calls
// terminalService.closeWorkspaceSessions) and app restart.
const terminalSessionsByWorkspaceId = new Map<string, string>();

interface TerminalTabProps {
  workspaceId: string;
  visible: boolean;
}

export const TerminalTab: React.FC<TerminalTabProps> = ({ workspaceId, visible }) => {
  const [existingSessionId, setExistingSessionId] = React.useState<string | undefined>(() =>
    terminalSessionsByWorkspaceId.get(workspaceId)
  );

  React.useEffect(() => {
    setExistingSessionId(terminalSessionsByWorkspaceId.get(workspaceId));
  }, [workspaceId]);

  const handleSessionId = React.useCallback(
    (sid: string) => {
      terminalSessionsByWorkspaceId.set(workspaceId, sid);
      setExistingSessionId(sid);
    },
    [workspaceId]
  );

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
