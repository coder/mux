/**
 * One-shot navigation intents for the Settings → Plugins section.
 *
 * The command palette's "Install Agent Plugin…" runs before the section
 * mounts, so it records an intent here and PluginsSettingsSection consumes it
 * in its state initializer. Module-level (not persisted) on purpose: the
 * intent is meaningful only for the navigation that just happened.
 */

let addPluginPanelRequested = false;

export function requestAddPluginPanel(): void {
  addPluginPanelRequested = true;
}

/** Returns whether the add panel was requested, clearing the intent. */
export function consumeAddPluginPanelRequest(): boolean {
  const requested = addPluginPanelRequested;
  addPluginPanelRequested = false;
  return requested;
}
