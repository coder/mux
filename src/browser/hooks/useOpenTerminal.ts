import { useCallback } from "react";
import { useAPI } from "@/browser/contexts/API";

/**
 * Hook to open a terminal window for a workspace.
 * Handles the difference between Desktop (Electron) and Browser (Web) environments.
 *
 * In Electron (desktop) mode: Opens the user's native terminal emulator
 * (Ghostty, Terminal.app, etc.) with the working directory set to the workspace path.
 *
 * In browser mode: Opens a web-based xterm.js terminal in a popup window.
 */
export function useOpenTerminal() {
  const { api } = useAPI();

  return useCallback(
    (workspaceId: string) => {
      // Check if running in browser mode
      // window.api is only available in Electron (set by preload.ts)
      // If window.api exists, we're in Electron; if not, we're in browser mode
      const isBrowser = !window.api;

      if (isBrowser) {
        // In browser mode, we must open the window client-side using window.open
        // The backend cannot open a window on the user's client
        const url = `/terminal.html?workspaceId=${encodeURIComponent(workspaceId)}`;
        window.open(
          url,
          `terminal-${workspaceId}-${Date.now()}`,
          "width=1000,height=600,popup=yes"
        );

        // We also notify the backend, though in browser mode the backend handler currently does nothing.
        // This is kept for consistency and in case the backend logic changes to track open windows.
        void api?.terminal.openWindow({ workspaceId });
      } else {
        // In Electron (desktop) mode, open the native system terminal
        // This spawns the user's preferred terminal emulator (Ghostty, Terminal.app, etc.)
        void api?.terminal.openNative({ workspaceId });
      }
    },
    [api]
  );
}
