import { useCallback } from "react";
import { useAPI } from "@/browser/contexts/API";
import type { RuntimeConfig } from "@/common/types/runtime";
import { isSSHRuntime } from "@/common/types/runtime";
import { createTerminalSession, openTerminalPopout } from "@/browser/utils/terminal";

/**
 * Hook to open a terminal window for a workspace.
 * Handles the difference between Desktop (Electron) and Browser (Web) environments.
 *
 * For SSH workspaces: Always opens a web-based xterm.js terminal that connects
 * through the backend PTY service (works in both browser and Electron modes).
 *
 * For local workspaces in Electron: Opens the user's native terminal emulator
 * (Ghostty, Terminal.app, etc.) with the working directory set to the workspace path.
 *
 * For local workspaces in browser: Opens a web-based xterm.js terminal in a popup window.
 */
export function useOpenTerminal() {
  const { api } = useAPI();

  return useCallback(
    async (workspaceId: string, runtimeConfig?: RuntimeConfig) => {
      if (!api) return;

      // Check if running in browser mode
      // window.api is only available in Electron (set by preload.ts)
      // If window.api exists, we're in Electron; if not, we're in browser mode
      const isBrowser = !window.api;
      const isSSH = isSSHRuntime(runtimeConfig);

      // SSH workspaces always use web terminal (in browser popup or Electron window)
      // because the PTY service handles the SSH connection to the remote host
      if (isBrowser || isSSH) {
        // Create terminal session first - window needs sessionId to connect
        const session = await createTerminalSession(api, workspaceId);
        openTerminalPopout(api, workspaceId, session.sessionId);
      } else {
        // In Electron (desktop) mode with local workspace, open the native system terminal
        // This spawns the user's preferred terminal emulator (Ghostty, Terminal.app, etc.)
        void api.terminal.openNative({ workspaceId });
      }
    },
    [api]
  );
}
