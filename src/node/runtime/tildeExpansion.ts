/**
 * Utilities for handling tilde path expansion
 *
 * For SSH commands, tilde paths need special handling:
 * - Quoted tildes won't expand: `cd '~'` fails, but `cd "$HOME"` works
 * - Must escape special shell characters when using $HOME expansion
 *
 * For local paths, tildes should be expanded to actual file system paths.
 */

import { PlatformPaths } from "../utils/paths.main";

/**
 * Expand tilde to actual home directory path for local file system operations.
 *
 * Converts:
 * - "~" → "/home/user" (actual home directory)
 * - "~/path" → "/home/user/path"
 * - "/abs/path" → "/abs/path" (unchanged)
 *
 * @param filePath - Path that may contain tilde prefix
 * @returns Fully expanded absolute path
 *
 * @example
 * expandTilde("~")           // => "/home/user"
 * expandTilde("~/workspace") // => "/home/user/workspace"
 * expandTilde("/abs/path")   // => "/abs/path"
 */
export function expandTilde(filePath: string): string {
  return PlatformPaths.expandHome(filePath);
}

/**
 * Expand tilde path to $HOME-based path for use in SSH commands.
 *
 * Converts:
 * - "~" → "$HOME"
 * - "~/path" → "$HOME/path"
 * - "/abs/path" → quoted absolute path (no expansion)
 *
 * The result is safe to use in bash commands and will properly expand at runtime.
 * Special characters in paths are escaped for use inside double quotes.
 *
 * @param path - Path that may contain tilde prefix
 * @returns Bash-safe string ready to use in commands
 *
 * @example
 * expandTildeForSSH("~")           // => "$HOME"
 * expandTildeForSSH("~/workspace") // => "$HOME/workspace"
 * expandTildeForSSH("/abs/path")   // => '"/abs/path"'
 */
export function expandTildeForSSH(path: string): string {
  if (path === "~") {
    return '"$HOME"';
  } else if (path.startsWith("~/")) {
    const pathAfterTilde = path.slice(2);
    // Escape special chars for use inside double quotes
    const escaped = pathAfterTilde
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\$/g, "\\$")
      .replace(/`/g, "\\`");
    return `"$HOME/${escaped}"`;
  } else {
    // No tilde - quote the path as-is
    // Note: We use double quotes to allow variable expansion if needed
    return `"${path.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\$/g, "\\$").replace(/`/g, "\\`")}"`;
  }
}

/**
 * Generate a cd command for use in SSH exec, handling tilde paths correctly.
 *
 * @param path - Working directory path (may contain tilde)
 * @returns Bash command string like `cd "$HOME/path"`
 *
 * @example
 * cdCommandForSSH("~")           // => 'cd "$HOME"'
 * cdCommandForSSH("~/workspace") // => 'cd "$HOME/workspace"'
 * cdCommandForSSH("/abs/path")   // => 'cd "/abs/path"'
 */
export function cdCommandForSSH(path: string): string {
  return `cd ${expandTildeForSSH(path)}`;
}
