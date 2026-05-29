import type React from "react";

/**
 * Stop keyboard event propagation for both React synthetic events and native KeyboardEvents.
 *
 * Use this when handling keyboard events in React components that need to prevent
 * global window listeners (like stream interrupt) from firing.
 *
 * Background: React's `e.stopPropagation()` only stops propagation within React's
 * synthetic event system. Native window listeners attached via `addEventListener`
 * will still receive the event. This helper stops both.
 *
 * Note: This only affects bubble-phase native listeners. Capture-phase listeners
 * will have already fired before this is called.
 */
export function stopKeyboardPropagation(e: React.KeyboardEvent | KeyboardEvent): void {
  if ("nativeEvent" in e) {
    // React synthetic event - stop both React and native propagation
    e.stopPropagation();
    e.nativeEvent.stopPropagation();
    return;
  }

  // Native KeyboardEvent - stop propagation directly
  e.stopPropagation();
}
