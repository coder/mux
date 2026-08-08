/**
 * One-shot navigation intents for the Settings → Plugins section.
 *
 * The command palette's "Install Agent Plugin…" may run before the section
 * mounts (intent consumed in the state initializer) or while it is already
 * mounted (navigating to the same route preserves the component, so mounted
 * sections subscribe and are notified immediately). Module-level (not
 * persisted) on purpose: the intent is meaningful only for the invocation
 * that just happened.
 */

let addPluginPanelRequested = false;
const listeners = new Set<() => void>();

export function requestAddPluginPanel(): void {
  addPluginPanelRequested = true;
  for (const listener of listeners) {
    listener();
  }
}

/** Returns whether the add panel was requested, clearing the intent. */
export function consumeAddPluginPanelRequest(): boolean {
  const requested = addPluginPanelRequested;
  addPluginPanelRequested = false;
  return requested;
}

/** Notifies an already-mounted section of new requests; returns an unsubscribe. */
export function subscribeAddPluginPanelRequests(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
