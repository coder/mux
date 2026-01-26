import * as path from "path";

/**
 * Returns the on-disk projectPath for the built-in Chat with Mux system workspace.
 *
 * Note: This must be computed from the active mux home dir (Config.rootDir) so
 * tests and dev installs (MUX_ROOT) behave consistently.
 */
export function getMuxChatProjectPath(muxHome: string): string {
  // Use a pretty basename for UI display (project name = basename of projectPath).
  return path.join(muxHome, "system", "Mux");
}
