import { EventEmitter } from "events";
import type { BrowserWindow } from "electron";
import { log } from "@/node/services/log";

type RestartAppHandler = () => void | Promise<void>;

/**
 * WindowService extends EventEmitter so backend services that need to react
 * to window focus state (e.g. AgentStatusService cadence gating) can subscribe
 * via `windowService.on("focus-change", listener)` without depending on
 * Electron internals or polling.
 */
export class WindowService extends EventEmitter {
  private mainWindow: BrowserWindow | null = null;
  private restartAppHandler: RestartAppHandler | null = null;
  // Default to true so headless/test environments behave as if the user is
  // actively watching. Desktop wires this to BrowserWindow focus/blur events
  // in `setMainWindow` below.
  private focused = true;

  setMainWindow(window: BrowserWindow) {
    this.mainWindow = window;

    // Seed from the window's current state if we can.
    try {
      this.setFocused(typeof window.isFocused === "function" ? window.isFocused() : true);
    } catch {
      this.setFocused(true);
    }

    // Wire focus/blur listeners directly to the window. The window is
    // recreated only on app restart, so we don't need to teardown listeners.
    // Tests pass a minimal stub without an EventEmitter surface; gracefully
    // skip listener wiring in that case so unrelated suites don't crash.
    const eventTarget = window as unknown as {
      on?: (event: string, listener: () => void) => unknown;
    };
    if (typeof eventTarget.on === "function") {
      eventTarget.on("focus", () => this.setFocused(true));
      eventTarget.on("blur", () => this.setFocused(false));
    }
  }
  setRestartAppHandler(handler: RestartAppHandler | null): void {
    this.restartAppHandler = handler;
  }

  /**
   * Returns whether the desktop main window is currently focused. Falls back
   * to `true` in non-desktop contexts (CLI server, tests) so backend
   * services don't accidentally throttle themselves to "unfocused" cadence
   * when there is no window at all.
   */
  isFocused(): boolean {
    return this.focused;
  }

  /**
   * Update the cached focus state. Emits `focus-change` only on transitions
   * so subscribers don't have to debounce duplicate notifications.
   *
   * Exposed publicly to allow tests and headless callers to drive focus
   * transitions without an actual BrowserWindow.
   */
  setFocused(focused: boolean): void {
    if (this.focused === focused) {
      return;
    }
    this.focused = focused;
    this.emit("focus-change", focused);
  }

  async restartApp(): Promise<{ supported: true } | { supported: false; message: string }> {
    const restartAppHandler = this.restartAppHandler;
    if (!restartAppHandler) {
      const message = "Restart is only available in the desktop app.";
      log.warn("WindowService: restartApp requested without a registered restart handler");
      return { supported: false, message };
    }

    try {
      await restartAppHandler();
      return { supported: true };
    } catch (error) {
      log.error("WindowService: restartApp failed", error);
      throw error;
    }
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
