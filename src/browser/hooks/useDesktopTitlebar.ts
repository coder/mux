/**
 * Desktop titlebar utilities for Electron's integrated titlebar.
 *
 * In Electron mode (window.api exists), the native titlebar is hidden and we need:
 * 1. Drag regions for window dragging
 * 2. Insets for native window controls (traffic lights on mac, overlay on win/linux)
 *
 * In browser/mux server mode, these are no-ops.
 */

/** Whether we're running in Electron desktop mode */
export function isDesktopMode(): boolean {
  return typeof window !== "undefined" && !!window.api;
}

/**
 * Returns the platform string in desktop mode, undefined in browser mode.
 */
export function getDesktopPlatform(): NodeJS.Platform | undefined {
  return window.api?.platform;
}

/**
 * Left inset (in pixels) to reserve for macOS traffic lights.
 * Only applies in Electron + macOS.
 *
 * The value accounts for the traffic lights (~52px) plus padding (~16px).
 */
export const MAC_TRAFFIC_LIGHTS_INSET = 72;

/**
 * Right inset (in pixels) to reserve for Windows/Linux titlebar overlay buttons.
 * Only applies in Electron + Windows/Linux.
 *
 * The value accounts for min/max/close buttons (~138px on Windows).
 */
export const WIN_LINUX_OVERLAY_INSET = 138;

/**
 * Returns the left inset needed for macOS traffic lights.
 * Returns 0 if not in desktop mode or not on macOS.
 */
export function getTitlebarLeftInset(): number {
  if (!isDesktopMode()) return 0;
  if (getDesktopPlatform() === "darwin") return MAC_TRAFFIC_LIGHTS_INSET;
  return 0;
}

/**
 * Returns the right inset needed for Windows/Linux titlebar overlay.
 * Returns 0 if not in desktop mode or on macOS.
 */
export function getTitlebarRightInset(): number {
  if (!isDesktopMode()) return 0;
  const platform = getDesktopPlatform();
  if (platform === "win32" || platform === "linux") return WIN_LINUX_OVERLAY_INSET;
  return 0;
}
