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

  // When desktop actions are invoked via argv at startup (e.g. Windows JumpList
  // tasks), they can arrive before the renderer has subscribed.
  // Buffer these so they aren't dropped on cold start.
  private pendingStartNewAgentCount = 0;

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

  /**
   * Emit a "start new agent" event. Called by main process entrypoints like Dock
   * menus, JumpList tasks, or desktop actions.
   */
  emitStartNewAgent(): void {
    if (this.emitter.listenerCount("startNewAgent") === 0) {
      this.pendingStartNewAgentCount += 1;
      return;
    }

    this.emitter.emit("startNewAgent");
  }

  /**
   * Subscribe to "start new agent" events. Used by oRPC subscription handler.
   * Returns a cleanup function.
   */
  onStartNewAgent(callback: () => void): () => void {
    this.emitter.on("startNewAgent", callback);

    if (this.pendingStartNewAgentCount > 0) {
      const pending = this.pendingStartNewAgentCount;
      this.pendingStartNewAgentCount = 0;

      for (let i = 0; i < pending; i += 1) {
        callback();
      }
    }

    return () => this.emitter.off("startNewAgent", callback);
  }
}
