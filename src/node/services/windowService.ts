import type { BrowserWindow } from "electron";
import { log } from "@/node/services/log";

export class WindowService {
  private mainWindow: BrowserWindow | null = null;

  setMainWindow(window: BrowserWindow) {
    this.mainWindow = window;
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
