import type { BrowserWindowConstructorOptions } from "electron";

/**
 * Platform-specific BrowserWindow options for VSCode-like integrated titlebar.
 *
 * - macOS: hiddenInset keeps native traffic lights but lets web content fill the titlebar area
 * - Windows/Linux: titleBarOverlay keeps native window controls while hiding the titlebar
 *
 * The renderer must add drag regions (`-webkit-app-region: drag`) and reserve
 * space for native window controls (traffic lights on mac, overlay on win/linux).
 */
export function getTitleBarOptions(
  platform: NodeJS.Platform = process.platform
): Partial<BrowserWindowConstructorOptions> {
  if (platform === "darwin") {
    return {
      titleBarStyle: "hiddenInset",
      // trafficLightPosition can be added here if we need finer alignment
    };
  }

  // Windows and Linux: use titleBarOverlay to keep native window controls
  return {
    titleBarStyle: "hidden",
    titleBarOverlay: {
      // Match the sidebar background color (--color-sidebar from globals.css)
      color: "#171717",
      symbolColor: "#a3a3a3",
      height: 32, // Match our header height (h-8 = 32px)
    },
  };
}
