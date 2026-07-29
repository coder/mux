/**
 * Safari never focuses a `<button>` on click; WebKit hands focus to the nearest
 * mouse-focusable ancestor instead. Here that ancestor is the `tabIndex={0}`
 * transcript scrollport the composer dock lives inside, and focusing that
 * container highlights the entire transcript column. Callers resolve the control
 * the user actually pressed so they can claim focus for it.
 */

// Deliberately an allowlist: text entry and banner prose inside the dock must keep
// the browser's native caret placement and drag-select. `role="option"` rows are
// listed because the model/agent dropdowns build them from plain divs.
const CONTROL_SELECTOR = 'button, a[href], [role="button"], [role="option"]';

export function resolveComposerControlFocusTarget(
  target: EventTarget | null,
  dock: HTMLElement | null
): HTMLElement | null {
  if (!dock || !(target instanceof Element) || !dock.contains(target)) {
    return null;
  }
  const control = target.closest<HTMLElement>(CONTROL_SELECTOR);
  return control && dock.contains(control) ? control : null;
}
