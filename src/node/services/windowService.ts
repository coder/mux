import type { BrowserWindow } from "electron";
import { log } from "@/node/services/log";

export class WindowService {
  private mainWindow: BrowserWindow | null = null;

  setMainWindow(window: BrowserWindow) {
    this.mainWindow = window;
  }

  focusMainWindow(): void {
    const mainWindow = this.mainWindow;
    if (!mainWindow) {
      return;
    }

    const isDestroyed =
      typeof (mainWindow as { isDestroyed?: () => boolean }).isDestroyed === "function"
        ? (mainWindow as { isDestroyed: () => boolean }).isDestroyed()
        : false;

    if (isDestroyed) {
      return;
    }

    try {
      if (
        typeof (mainWindow as { isMinimized?: () => boolean }).isMinimized === "function" &&
        (mainWindow as { isMinimized: () => boolean }).isMinimized() &&
        typeof (mainWindow as { restore?: () => void }).restore === "function"
      ) {
        (mainWindow as { restore: () => void }).restore();
      }

      if (typeof (mainWindow as { show?: () => void }).show === "function") {
        (mainWindow as { show: () => void }).show();
      }

      if (typeof (mainWindow as { focus?: () => void }).focus === "function") {
        (mainWindow as { focus: () => void }).focus();
      }
    } catch (error) {
      log.debug("WindowService: focusMainWindow failed", error);
    }
  }

  send(channel: string, ...args: unknown[]): void {
    const isDestroyed =
      this.mainWindow &&
      typeof (this.mainWindow as { isDestroyed?: () => boolean }).isDestroyed === "function"
        ? (this.mainWindow as { isDestroyed: () => boolean }).isDestroyed()
        : false;

    if (this.mainWindow && !isDestroyed) {
      this.mainWindow.webContents.send(channel, ...args);
      return;
    }

    log.debug(
      "WindowService: send called but mainWindow is not set or destroyed",
      channel,
      ...args
    );
  }

  setTitle(title: string): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.setTitle(title);
    } else {
      log.debug("WindowService: setTitle called but mainWindow is not set or destroyed");
    }
  }
}
