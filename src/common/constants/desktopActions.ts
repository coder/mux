/**
 * Desktop action flags passed via argv when the app is launched from OS-native
 * entrypoints (e.g., Windows JumpList tasks).
 *
 * Keep these stable: they may be referenced by external shortcuts.
 */
export const DESKTOP_ACTION_FLAGS = {
  OPEN: "--open",
  NEW_AGENT: "--new-agent",
  QUIT: "--quit",
} as const;

export type DesktopActionFlag = (typeof DESKTOP_ACTION_FLAGS)[keyof typeof DESKTOP_ACTION_FLAGS];
