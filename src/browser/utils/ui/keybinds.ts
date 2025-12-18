/**
 * Centralized keybind utilities for consistent keyboard shortcut handling
 * and OS-aware display across the application.
 *
 * NOTE: This file is the source of truth for keybind definitions.
 * When adding/modifying keybinds, update docs/keybinds.md ONLY if the keybind
 * is not discoverable in the UI (e.g., no tooltip, placeholder text, or visible hint).
 */

/**
 * Keybind definition type
 */
export interface Keybind {
  key: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  meta?: boolean;
  /**
   * On macOS, Ctrl-based shortcuts traditionally use Cmd instead.
   * Use this field to control that behavior:
   * - "either" (default): accept Ctrl or Cmd
   * - "command": require Cmd specifically
   * - "control": require the Control key specifically
   */
  macCtrlBehavior?: "either" | "command" | "control";
}

/**
 * Detect if running on macOS
 */
export function isMac(): boolean {
  try {
    if (typeof window === "undefined") return false;
    interface MinimalAPI {
      platform: string;
    }
    const api = (window as unknown as { api?: MinimalAPI }).api;
    return api?.platform === "darwin";
  } catch {
    return false;
  }
}

/**
 * Check if a keyboard event matches a keybind definition.
 * On macOS, ctrl in the definition defaults to matching Ctrl or Cmd unless overridden.
 */
export function matchesKeybind(
  event: React.KeyboardEvent | KeyboardEvent,
  keybind: Keybind
): boolean {
  // Guard against undefined event.key (can happen with dead keys, modifier-only events, etc.)
  if (!event.key) {
    return false;
  }

  // Check key match (case-insensitive for letters)
  if (event.key.toLowerCase() !== keybind.key.toLowerCase()) {
    return false;
  }

  const onMac = isMac();
  const macCtrlBehavior = keybind.macCtrlBehavior ?? "either";
  const ctrlPressed = event.ctrlKey;
  const metaPressed = event.metaKey;

  let ctrlRequired = false;
  let ctrlAllowed = false;
  let metaRequired = keybind.meta ?? false;
  let metaAllowed = metaRequired;

  if (keybind.ctrl) {
    if (onMac) {
      switch (macCtrlBehavior) {
        case "control": {
          ctrlRequired = true;
          ctrlAllowed = true;
          // Only allow Cmd if explicitly requested via meta flag
          break;
        }
        case "command": {
          metaRequired = true;
          metaAllowed = true;
          ctrlAllowed = true;
          break;
        }
        case "either": {
          ctrlAllowed = true;
          metaAllowed = true;
          if (!ctrlPressed && !metaPressed) return false;
          break;
        }
      }
    } else {
      ctrlRequired = true;
      ctrlAllowed = true;
    }
  } else {
    ctrlAllowed = false;
  }

  if (ctrlRequired && !ctrlPressed) return false;
  if (!ctrlAllowed && ctrlPressed) return false;

  if (keybind.shift && !event.shiftKey) return false;
  if (!keybind.shift && event.shiftKey) return false;

  if (keybind.alt && !event.altKey) return false;
  if (!keybind.alt && event.altKey) return false;

  if (metaRequired && !metaPressed) return false;

  if (!metaAllowed) {
    // If Cmd is allowed implicitly via ctrl behavior, mark it now
    if (onMac && keybind.ctrl && macCtrlBehavior !== "control") {
      metaAllowed = true;
    }
  }

  if (!metaAllowed && metaPressed) {
    return false;
  }

  return true;
}

/**
 * Check if the event target is an editable element (input, textarea, contentEditable).
 * Used to prevent global keyboard shortcuts from interfering with text input.
 */
export function isEditableElement(target: EventTarget | null): boolean {
  if (!target || !(target instanceof HTMLElement)) {
    return false;
  }

  const tagName = target.tagName.toLowerCase();
  return tagName === "input" || tagName === "textarea" || target.contentEditable === "true";
}

/**
 * Format a keybind for display to users.
 * Returns Mac-style symbols on macOS, or Windows-style text elsewhere.
 */
export function formatKeybind(keybind: Keybind): string {
  const parts: string[] = [];

  if (isMac()) {
    // Mac-style formatting with symbols (using Unicode escapes for safety)
    // For ctrl on Mac, we actually mean Cmd in most cases since matcher treats them as equivalent
    if (keybind.ctrl && !keybind.meta) {
      const macCtrlBehavior = keybind.macCtrlBehavior ?? "either";
      if (macCtrlBehavior === "control") {
        parts.push("\u2303"); // ⌃ Control
      } else {
        parts.push("\u2318"); // ⌘ Command
      }
    } else if (keybind.ctrl) {
      parts.push("\u2303"); // ⌃ Control
    }
    if (keybind.alt) parts.push("\u2325"); // ⌥ Option
    if (keybind.shift) parts.push("\u21E7"); // ⇧ Shift
    if (keybind.meta) parts.push("\u2318"); // ⌘ Command
  } else {
    // Windows/Linux-style formatting with text
    if (keybind.ctrl) parts.push("Ctrl");
    if (keybind.alt) parts.push("Alt");
    if (keybind.shift) parts.push("Shift");
    if (keybind.meta) parts.push("Meta");
  }

  // Add the key (handle special cases, then capitalize single letters)
  let key: string;
  if (keybind.key === " ") {
    key = "Space";
  } else if (keybind.key.length === 1) {
    key = keybind.key.toUpperCase();
  } else {
    key = keybind.key;
  }
  parts.push(key);

  return isMac() ? parts.join("\u00B7") : parts.join("+"); // · on Mac, + elsewhere
}

/**
 * Centralized registry of application keybinds.
 * Single source of truth for all keyboard shortcuts.
 * In general we try to use shortcuts the user would naturally expect.
 * We also like vim keybinds.
 */
export const KEYBINDS = {
  /** Toggle between Plan and Exec modes */
  TOGGLE_MODE: { key: "M", ctrl: true, shift: true },

  /** Send message / Submit form */
  SEND_MESSAGE: { key: "Enter" },

  /** Insert newline in text input */
  NEW_LINE: { key: "Enter", shift: true },

  /** Cancel current action / Close modal (excludes stream interruption) */
  CANCEL: { key: "Escape" },

  /** Cancel editing message (exit edit mode) */
  CANCEL_EDIT: { key: "Escape" },

  /** Save edit (Cmd/Ctrl+Enter) */
  SAVE_EDIT: { key: "Enter", ctrl: true },

  /** Interrupt active stream (destructive - stops AI generation) */
  // Vim mode: Ctrl+C (familiar from terminal interrupt)
  // Non-Vim mode: Esc (intuitive cancel/stop key)
  INTERRUPT_STREAM_VIM: { key: "c", ctrl: true, macCtrlBehavior: "control" },
  INTERRUPT_STREAM_NORMAL: { key: "Escape" },

  /** Focus chat input */
  FOCUS_INPUT_I: { key: "i" },

  /** Focus chat input (alternate) */
  FOCUS_INPUT_A: { key: "a" },

  /** Create new workspace for current project */
  NEW_WORKSPACE: { key: "n", ctrl: true },

  /** Jump to bottom of chat */
  JUMP_TO_BOTTOM: { key: "G", shift: true },

  /** Navigate to next workspace in current project */
  NEXT_WORKSPACE: { key: "j", ctrl: true },

  /** Navigate to previous workspace in current project */
  PREV_WORKSPACE: { key: "k", ctrl: true },

  /** Toggle sidebar visibility */
  // VS Code-style quick toggle
  // macOS: Cmd+P, Win/Linux: Ctrl+P
  TOGGLE_SIDEBAR: { key: "P", ctrl: true },

  /** Cycle through configured models */
  CYCLE_MODEL: { key: "/", ctrl: true },

  /** Open workspace in terminal */
  // macOS: Cmd+T, Win/Linux: Ctrl+T
  OPEN_TERMINAL: { key: "T", ctrl: true },

  /** Open workspace in editor */
  // macOS: Cmd+Shift+E, Win/Linux: Ctrl+Shift+E
  OPEN_IN_EDITOR: { key: "E", ctrl: true, shift: true },

  /** Open Command Palette */
  // VS Code-style palette
  // macOS: Cmd+Shift+P, Win/Linux: Ctrl+Shift+P
  OPEN_COMMAND_PALETTE: { key: "P", ctrl: true, shift: true },

  /** Toggle thinking level between off and last-used value for current model */
  // Saves/restores thinking level per model (defaults to "medium" if not found)
  // macOS: Cmd+Shift+T, Win/Linux: Ctrl+Shift+T
  TOGGLE_THINKING: { key: "T", ctrl: true, shift: true },

  /** Focus chat input from anywhere */
  // Works even when focus is already in an input field
  // macOS: Cmd+I, Win/Linux: Ctrl+I
  FOCUS_CHAT: { key: "I", ctrl: true },

  /** Switch to Costs tab in right sidebar */
  // macOS: Cmd+1, Win/Linux: Ctrl+1
  COSTS_TAB: { key: "1", ctrl: true, description: "Costs tab" },

  /** Switch to Review tab in right sidebar */
  // macOS: Cmd+2, Win/Linux: Ctrl+2
  // NOTE: Both Ctrl and Cmd work for switching tabs on Mac (macOS has no standard Cmd+number behavior)
  // This differs from other keybinds where we distinguish Ctrl (literal) from Cmd (meta)
  REVIEW_TAB: { key: "2", ctrl: true, description: "Review tab" },

  /** Switch to Stats tab in right sidebar */
  // macOS: Cmd+3, Win/Linux: Ctrl+3
  STATS_TAB: { key: "3", ctrl: true, description: "Stats tab" },

  /** Refresh diff in Code Review panel */
  // macOS: Cmd+R, Win/Linux: Ctrl+R
  REFRESH_REVIEW: { key: "r", ctrl: true },

  /** Focus search input in Code Review panel */
  // macOS: Cmd+F, Win/Linux: Ctrl+F
  FOCUS_REVIEW_SEARCH: { key: "f", ctrl: true },

  /** Mark selected hunk as read/unread in Code Review panel */
  TOGGLE_HUNK_READ: { key: "m" },

  /** Mark selected hunk as read in Code Review panel */
  MARK_HUNK_READ: { key: "l" },

  /** Mark selected hunk as unread in Code Review panel */
  MARK_HUNK_UNREAD: { key: "h" },

  /** Mark entire file (all hunks) as read in Code Review panel */
  MARK_FILE_READ: { key: "M", shift: true },

  /** Toggle hunk expand/collapse in Code Review panel */
  TOGGLE_HUNK_COLLAPSE: { key: " " },

  /** Open settings modal */
  // macOS: Cmd+, Win/Linux: Ctrl+,
  OPEN_SETTINGS: { key: ",", ctrl: true },

  /** Toggle voice input (dictation) */
  // macOS: Cmd+D, Win/Linux: Ctrl+D
  // "D" for Dictate - intuitive and available
  TOGGLE_VOICE_INPUT: { key: "d", ctrl: true },
} as const;

/**
 * Create a keyboard event handler for inline edit inputs.
 * Handles Enter to save and Escape to cancel (with stopPropagation to prevent modal close).
 */
export function createEditKeyHandler(options: {
  onSave: () => void;
  onCancel: () => void;
}): (e: React.KeyboardEvent) => void {
  return (e) => {
    if (e.key === "Enter") {
      options.onSave();
    } else if (e.key === "Escape") {
      e.stopPropagation();
      options.onCancel();
    }
  };
}
