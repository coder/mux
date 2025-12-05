/**
 * Utilities for discovering available commands in the system.
 * Used by terminalService and openInEditor to find executables.
 */

import * as fs from "fs/promises";
import { spawnSync } from "child_process";

/** Known installation paths for GUI editors on macOS */
const MACOS_APP_PATHS: Record<string, string[]> = {
  cursor: ["/Applications/Cursor.app/Contents/Resources/app/bin/cursor", "/usr/local/bin/cursor"],
  code: [
    "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
    "/usr/local/bin/code",
  ],
  zed: ["/Applications/Zed.app/Contents/MacOS/cli", "/usr/local/bin/zed"],
  subl: ["/Applications/Sublime Text.app/Contents/SharedSupport/bin/subl", "/usr/local/bin/subl"],
  ghostty: [
    "/opt/homebrew/bin/ghostty",
    "/Applications/Ghostty.app/Contents/MacOS/ghostty",
    "/usr/local/bin/ghostty",
  ],
};

/**
 * Check if a command is available in the system PATH or known locations.
 * First checks macOS-specific paths for known apps, then falls back to `which`.
 */
export async function isCommandAvailable(command: string): Promise<boolean> {
  // Check known paths for macOS apps
  if (process.platform === "darwin" && command in MACOS_APP_PATHS) {
    for (const appPath of MACOS_APP_PATHS[command]) {
      try {
        const stats = await fs.stat(appPath);
        // Check if it's a file and any executable bit is set
        if (stats.isFile() && (stats.mode & 0o111) !== 0) {
          return true;
        }
      } catch {
        // Try next path
      }
    }
  }

  // Fall back to which
  try {
    const result = spawnSync("which", [command], { encoding: "utf8" });
    return result.status === 0;
  } catch {
    return false;
  }
}

/**
 * Find the first available command from a list of candidates.
 * Returns the command name (not full path) of the first available one.
 */
export async function findAvailableCommand(commands: string[]): Promise<string | null> {
  for (const cmd of commands) {
    if (await isCommandAvailable(cmd)) {
      return cmd;
    }
  }
  return null;
}

/** GUI editors that spawn detached (no terminal needed) */
export const GUI_EDITORS = ["cursor", "code", "zed", "subl"] as const;

/** Terminal editors that require a terminal session */
export const TERMINAL_EDITORS = ["nvim", "vim", "vi", "nano", "emacs"] as const;

/** All known GUI terminal emulators */
export const TERMINAL_EMULATORS = ["ghostty", "kitty", "alacritty", "wezterm", "iterm2"] as const;
