/**
 * Terminal Window Entry Point
 *
 * Separate entry point for pop-out terminal windows.
 * Each window connects to a terminal session via WebSocket.
 */

import ReactDOM from "react-dom/client";
import { TerminalView } from "@/browser/components/TerminalView/TerminalView";
import { APIProvider, useAPI } from "@/browser/contexts/API";
import { TerminalRouterProvider } from "@/browser/terminal/TerminalRouterContext";
import "./styles/globals.css";

function TerminalWindowContent(props: { workspaceId: string; sessionId: string }) {
  const { api } = useAPI();

  return (
    <TerminalView
      workspaceId={props.workspaceId}
      sessionId={props.sessionId}
      visible={true}
      onExit={() => {
        api?.terminal.closeWindow({ workspaceId: props.workspaceId }).catch((err) => {
          console.warn("[TerminalWindow] Failed to close terminal window:", err);
        });
      }}
    />
  );
}

// Get workspace ID from query parameter
const params = new URLSearchParams(window.location.search);
const workspaceId = params.get("workspaceId");
const sessionId = params.get("sessionId");

if (!workspaceId || !sessionId) {
  document.body.innerHTML = `
    <div style="color: #f44; padding: 20px; font-family: monospace;">
      Error: Missing workspace ID or session ID
    </div>
  `;
} else {
  document.title = `Terminal — ${workspaceId}`;

  // Don't use StrictMode for terminal windows to avoid double-mounting issues
  // StrictMode intentionally double-mounts components in dev, which causes
  // race conditions with WebSocket connections and terminal lifecycle
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <APIProvider>
      <TerminalRouterProvider>
        <TerminalWindowContent workspaceId={workspaceId} sessionId={sessionId} />
      </TerminalRouterProvider>
    </APIProvider>
  );
}
