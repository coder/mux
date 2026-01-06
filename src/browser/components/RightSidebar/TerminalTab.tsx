import React from "react";
import { TerminalView } from "@/browser/components/TerminalView";
import type { TabType } from "@/browser/types/rightSidebar";
import { getTerminalSessionId } from "@/browser/types/rightSidebar";

interface TerminalTabProps {
  workspaceId: string;
  /** The tab type (e.g., "terminal" or "terminal:ws-123-1704567890") */
  tabType: TabType;
  visible: boolean;
  /** Called when a new session is created (for placeholder "terminal" tabs) */
  onSessionCreated?: (sessionId: string) => void;
  /** Called when terminal title changes (from shell OSC sequences) */
  onTitleChange?: (title: string) => void;
}

/**
 * Terminal tab component that renders a terminal view.
 *
 * Session ID is extracted directly from the tabType:
 * - "terminal" = placeholder, will create new session
 * - "terminal:<sessionId>" = reattach to existing session
 *
 * This eliminates the need for a separate session-to-tab mapping.
 */
export const TerminalTab: React.FC<TerminalTabProps> = (props) => {
  // Extract session ID from tab type. undefined means create new session.
  const sessionId = getTerminalSessionId(props.tabType);

  return (
    <TerminalView
      workspaceId={props.workspaceId}
      sessionId={sessionId}
      visible={props.visible}
      setDocumentTitle={false}
      // Keep session alive: cleanup happens on workspace deletion or app restart
      closeOnCleanup={false}
      onSessionId={props.onSessionCreated}
      onTitleChange={props.onTitleChange}
    />
  );
};
