/**
 * Terminal Window Entry Point
 *
 * Separate entry point for pop-out terminal windows.
 * Each window connects to a terminal session via WebSocket.
 */

import React from "react";
import ReactDOM from "react-dom/client";
import { TerminalView } from "@/browser/components/TerminalView";
import "./styles/globals.css";

// Shims the `window.api` object with the browser API if not running in Electron
import "./api";

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
  // Set document title for browser tab
  // Fetch workspace metadata to get a better title
  if (window.api) {
    window.api.workspace
      .list()
      .then((workspaces: Array<{ id: string; projectName: string; name: string }>) => {
        const workspace = workspaces.find((ws) => ws.id === workspaceId);
        if (workspace) {
          document.title = `Terminal — ${workspace.projectName}/${workspace.name}`;
        } else {
          document.title = `Terminal — ${workspaceId}`;
        }
      })
      .catch(() => {
        document.title = `Terminal — ${workspaceId}`;
      });
  } else {
    document.title = `Terminal — ${workspaceId}`;
  }

  // Don't use StrictMode for terminal windows to avoid double-mounting issues
  // StrictMode intentionally double-mounts components in dev, which causes
  // race conditions with WebSocket connections and terminal lifecycle
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <TerminalView workspaceId={workspaceId} sessionId={sessionId ?? undefined} visible={true} />
  );
}
