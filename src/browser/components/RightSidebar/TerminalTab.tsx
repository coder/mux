import React from "react";
import { TerminalView } from "@/browser/components/TerminalView";

// In-memory keep-alive mapping for terminal sessions per workspace.
// Intentionally not persisted across reloads: backend sessions won't survive a restart.
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
      closeOnCleanup={false}
      onSessionId={handleSessionId}
    />
  );
};
