/**
 * Terminal Window Manager
 *
 * Manages pop-out terminal windows for workspaces.
 * Each workspace can have multiple terminal windows open simultaneously.
 */

import { app, BrowserWindow } from "electron";
import * as path from "path";
import { log } from "@/node/services/log";
import type { Config } from "@/node/config";

export class TerminalWindowManager {
  private windows = new Map<string, Set<BrowserWindow>>(); // workspaceId -> Set of windows
  private windowCount = 0; // Counter for unique window IDs
  private readonly config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  /**
   * Open a new terminal window for a workspace
   * Multiple windows can be open for the same workspace
   */
  async openTerminalWindow(workspaceId: string): Promise<void> {
    this.windowCount++;
    const windowId = this.windowCount;

    // Look up workspace metadata to get project and branch names
    const allWorkspaces = await this.config.getAllWorkspaceMetadata();
    const workspace = allWorkspaces.find((ws) => ws.id === workspaceId);

    let title: string;
    if (workspace) {
      title = `Terminal ${windowId} — ${workspace.projectName} (${workspace.name})`;
    } else {
      // Fallback if workspace not found
      title = `Terminal ${windowId} — ${workspaceId}`;
    }

    const terminalWindow = new BrowserWindow({
      width: 1000,
      height: 600,
      title,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        // __dirname is dist/services/ but preload.js is in dist/
        preload: path.join(__dirname, "../preload.js"),
      },
      backgroundColor: "#1e1e1e",
    });

    // Track the window
    if (!this.windows.has(workspaceId)) {
      this.windows.set(workspaceId, new Set());
    }
    this.windows.get(workspaceId)!.add(terminalWindow);

    // Clean up when window is closed
    terminalWindow.on("closed", () => {
      const windowSet = this.windows.get(workspaceId);
      if (windowSet) {
        windowSet.delete(terminalWindow);
        if (windowSet.size === 0) {
          this.windows.delete(workspaceId);
        }
      }
      log.info(`Terminal window ${windowId} closed for workspace: ${workspaceId}`);
    });

    // Load the terminal page
    // Match main window logic: use dev server unless packaged or MUX_E2E_LOAD_DIST=1
    const forceDistLoad = process.env.MUX_E2E_LOAD_DIST === "1";
    const useDevServer = !app.isPackaged && !forceDistLoad;

    if (useDevServer) {
      // Development mode - load from Vite dev server
      await terminalWindow.loadURL(
        `http://localhost:5173/terminal.html?workspaceId=${encodeURIComponent(workspaceId)}`
      );
      terminalWindow.webContents.openDevTools();
    } else {
      // Production mode (or E2E dist mode) - load from built files
      await terminalWindow.loadFile(path.join(__dirname, "../terminal.html"), {
        query: { workspaceId },
      });
    }

    log.info(`Terminal window ${windowId} opened for workspace: ${workspaceId}`);
  }

  /**
   * Close all terminal windows for a workspace
   */
  closeTerminalWindow(workspaceId: string): void {
    const windowSet = this.windows.get(workspaceId);
    if (windowSet) {
      for (const window of windowSet) {
        if (!window.isDestroyed()) {
          window.close();
        }
      }
      this.windows.delete(workspaceId);
    }
  }

  /**
   * Close all terminal windows for all workspaces
   */
  closeAll(): void {
    for (const [workspaceId, windowSet] of this.windows.entries()) {
      for (const window of windowSet) {
        if (!window.isDestroyed()) {
          window.close();
        }
      }
      this.windows.delete(workspaceId);
    }
  }

  /**
   * Get all windows for a workspace
   */
  getWindows(workspaceId: string): BrowserWindow[] {
    const windowSet = this.windows.get(workspaceId);
    if (!windowSet) return [];
    return Array.from(windowSet).filter((w) => !w.isDestroyed());
  }

  /**
   * Get count of open terminal windows for a workspace
   */
  getWindowCount(workspaceId: string): number {
    return this.getWindows(workspaceId).length;
  }
}
