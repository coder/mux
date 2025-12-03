import { EventEmitter } from "events";

/**
 * MenuEventService - Bridges Electron menu events to oRPC subscriptions.
 *
 * Menu events are one-way notifications from main→renderer (e.g., user clicks
 * "Settings..." in the macOS app menu). This service allows the oRPC router
 * to expose these as subscriptions.
 */
export class MenuEventService {
  private emitter = new EventEmitter();

  /**
   * Emit an "open settings" event. Called by main.ts when menu item is clicked.
   */
  emitOpenSettings(): void {
    this.emitter.emit("openSettings");
  }

  /**
   * Subscribe to "open settings" events. Used by oRPC subscription handler.
   * Returns a cleanup function.
   */
  onOpenSettings(callback: () => void): () => void {
    this.emitter.on("openSettings", callback);
    return () => this.emitter.off("openSettings", callback);
  }
}
