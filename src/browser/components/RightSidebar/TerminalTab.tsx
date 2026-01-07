import React from "react";
import { TerminalView } from "@/browser/components/TerminalView";
import type { TabType } from "@/browser/types/rightSidebar";
import { getTerminalSessionId } from "@/browser/types/rightSidebar";

interface TerminalTabProps {
  workspaceId: string;
  /** The tab type (e.g., "terminal:ws-123-1704567890") */
  tabType: TabType;
  visible: boolean;
  /** Called when terminal title changes (from shell OSC sequences) */
  onTitleChange?: (title: string) => void;
}

/**
 * Terminal tab component that renders a terminal view.
 *
 * Session ID is extracted directly from the tabType ("terminal:<sessionId>").
 * Sessions are created by RightSidebar before adding the tab, so tabType
 * always contains a valid sessionId (never the placeholder "terminal").
 */
export const TerminalTab: React.FC<TerminalTabProps> = (props) => {
  // Extract session ID from tab type
  const sessionId = getTerminalSessionId(props.tabType);

  return (
    <TerminalView
      workspaceId={props.workspaceId}
      sessionId={sessionId}
      visible={props.visible}
      setDocumentTitle={false}
      // Keep session alive: cleanup happens on workspace deletion or app restart
      closeOnCleanup={false}
      onTitleChange={props.onTitleChange}
    />
  );
};
