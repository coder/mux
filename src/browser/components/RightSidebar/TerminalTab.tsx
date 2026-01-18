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
  /** Whether to auto-focus the terminal when it becomes visible (e.g., when opened via keybind) */
  autoFocus?: boolean;
  /** Called when autoFocus has been consumed (to clear the parent state) */
  onAutoFocusConsumed?: () => void;
}

/**
 * Terminal tab component that renders a terminal view.
 *
 * Session ID is extracted directly from the tabType ("terminal:<sessionId>").
 * Sessions are created by RightSidebar before adding the tab, so tabType
 * always contains a valid sessionId (never the placeholder "terminal").
 */
export const TerminalTab: React.FC<TerminalTabProps> = (props) => {
  // Extract session ID from tab type - must exist (sessions created before tab added)
  const sessionId = getTerminalSessionId(props.tabType);

  if (!sessionId) {
    // This should never happen - RightSidebar creates session before adding tab
    return (
      <div className="flex h-full items-center justify-center text-red-400">
        Invalid terminal tab: missing session ID
      </div>
    );
  }

  return (
    <TerminalView
      workspaceId={props.workspaceId}
      sessionId={sessionId}
      visible={props.visible}
      setDocumentTitle={false}
      onTitleChange={props.onTitleChange}
      onAutoFocusConsumed={props.onAutoFocusConsumed}
      autoFocus={props.autoFocus ?? false}
    />
  );
};
