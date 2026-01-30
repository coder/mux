/**
 * Shared mux:// deep link payload types.
 *
 * This lives in common so desktop main/preload/renderer can agree on semantics
 * without importing any Electron-only code.
 */

export interface MuxDeepLinkPayload {
  type: "new_chat";
  projectPath?: string;
  projectId?: string;
  prompt?: string;
  sectionId?: string;
}
