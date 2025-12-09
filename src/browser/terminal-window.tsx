/**
 * Terminal Window Entry Point
 *
 * Separate entry point for pop-out terminal windows.
 * Each window connects to a terminal session via WebSocket.
 */

import React from "react";
import ReactDOM from "react-dom/client";
import { TerminalView } from "@/browser/components/TerminalView";
import { APIProvider } from "@/browser/contexts/API";
import "./styles/globals.css";

// Get workspace ID from query parameter
const params = new URLSearchParams(window.location.search);
const workspaceId = params.get("workspaceId");
const sessionId = params.get("sessionId"); // Reserved for future reload support

if (!workspaceId) {
  document.body.innerHTML = `
    <div style="color: #f44; padding: 20px; font-family: monospace;">
      Error: No workspace ID provided
    </div>
  `;
} else {
  document.title = `Terminal — ${workspaceId}`;

  // Don't use StrictMode for terminal windows to avoid double-mounting issues
  // StrictMode intentionally double-mounts components in dev, which causes
  // race conditions with WebSocket connections and terminal lifecycle
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <APIProvider>
      <TerminalView workspaceId={workspaceId} sessionId={sessionId ?? undefined} visible={true} />
    </APIProvider>
  );
}
