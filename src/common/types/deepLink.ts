/**
 * Shared mux:// deep link payload types.
 *
 * This lives in common so desktop main/preload/renderer can agree on semantics
 * without importing any Electron-only code.
 */

export interface MuxDeepLinkPayload {
  type: "new_chat";

  /**
   * Human-friendly project selector. Matches against the final path segment
   * (e.g., /Users/me/repos/mux -> "mux").
   */
  project?: string;

  // Precise selectors (legacy/back-compat): these must match a configured project.
  projectPath?: string;
  projectId?: string;

  prompt?: string;
  sectionId?: string;
}
