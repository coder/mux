import { nativeImage, type NativeImage } from "electron";
import * as path from "path";

/**
 * Returns an Electron NativeImage that can be used as the app/window icon.
 *
 * Why:
 * - In development (`bun start` / `electron .`), Electron will otherwise show the default
 *   Electron icon in the Dock / taskbar / window chrome.
 * - `make start` runs `build-static`, which copies `public/icon.png` to `dist/icon.png`.
 * - Packaged builds also include `dist/icon.png`, so this works in both dev + prod.
 */
let cachedIcon: NativeImage | null | undefined;

export function getMuxAppIcon(): NativeImage | undefined {
  if (cachedIcon !== undefined) {
    return cachedIcon ?? undefined;
  }

  const candidatePaths: string[] = [];

  // On macOS, `app.dock.setIcon()` does not apply the system icon mask, so we prefer
  // a rounded-corner asset to avoid a harsh square in the Dock.
  if (process.platform === "darwin") {
    candidatePaths.push(
      path.join(__dirname, "../icon-mac.png"),
      path.join(__dirname, "../../public/icon-mac.png")
    );
  }

  candidatePaths.push(
    // Primary: built static assets (present for `make start` and packaged apps)
    path.join(__dirname, "../icon.png"),
    // Fallback: running from source without build-static
    path.join(__dirname, "../../public/icon.png")
  );

  for (const iconPath of candidatePaths) {
    const icon = nativeImage.createFromPath(iconPath);
    if (!icon.isEmpty()) {
      cachedIcon = icon;
      return icon;
    }
  }

  cachedIcon = null;
  return undefined;
}
