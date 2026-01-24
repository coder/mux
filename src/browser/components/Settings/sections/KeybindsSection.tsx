import { KEYBINDS, formatKeybind } from "@/browser/utils/ui/keybinds";

/**
 * Human-readable labels for keybind IDs.
 * Derived from the comments in keybinds.ts.
 */
const KEYBIND_LABELS: Record<keyof typeof KEYBINDS, string> = {
  TOGGLE_AGENT: "Open agent picker",
  CYCLE_AGENT: "Cycle agent",
  SEND_MESSAGE: "Send message",
  NEW_LINE: "Insert newline",
  CANCEL: "Cancel / Close modal",
  CANCEL_EDIT: "Cancel editing message",
  SAVE_EDIT: "Save edit",
  INTERRUPT_STREAM_VIM: "Interrupt stream (Vim mode)",
  INTERRUPT_STREAM_NORMAL: "Interrupt stream",
  FOCUS_INPUT_I: "Focus input (i)",
  FOCUS_INPUT_A: "Focus input (a)",
  NEW_WORKSPACE: "New workspace",
  ARCHIVE_WORKSPACE: "Archive workspace",
  JUMP_TO_BOTTOM: "Jump to bottom",
  NEXT_WORKSPACE: "Next workspace",
  PREV_WORKSPACE: "Previous workspace",
  TOGGLE_SIDEBAR: "Toggle sidebar",
  CYCLE_MODEL: "Cycle model",
  OPEN_TERMINAL: "New terminal",
  OPEN_IN_EDITOR: "Open in editor",
  OPEN_COMMAND_PALETTE: "Command palette",
  TOGGLE_THINKING: "Toggle thinking",
  FOCUS_CHAT: "Focus chat input",
  CLOSE_TAB: "Close tab",
  SIDEBAR_TAB_1: "Tab 1",
  SIDEBAR_TAB_2: "Tab 2",
  SIDEBAR_TAB_3: "Tab 3",
  SIDEBAR_TAB_4: "Tab 4",
  SIDEBAR_TAB_5: "Tab 5",
  SIDEBAR_TAB_6: "Tab 6",
  SIDEBAR_TAB_7: "Tab 7",
  SIDEBAR_TAB_8: "Tab 8",
  SIDEBAR_TAB_9: "Tab 9",
  REFRESH_REVIEW: "Refresh diff",
  FOCUS_REVIEW_SEARCH: "Search in review",
  FOCUS_REVIEW_SEARCH_QUICK: "Search in review (quick)",
  TOGGLE_HUNK_READ: "Toggle hunk read",
  MARK_HUNK_READ: "Mark hunk read",
  MARK_HUNK_UNREAD: "Mark hunk unread",
  MARK_FILE_READ: "Mark file read",
  TOGGLE_HUNK_COLLAPSE: "Toggle hunk collapse",
  OPEN_SETTINGS: "Open settings",
  TOGGLE_VOICE_INPUT: "Toggle voice input",
  NAVIGATE_BACK: "Navigate back",
  NAVIGATE_FORWARD: "Navigate forward",
  TOGGLE_NOTIFICATIONS: "Toggle notifications",
};

/** Groups for organizing keybinds in the UI */
const KEYBIND_GROUPS: Array<{ label: string; keys: Array<keyof typeof KEYBINDS> }> = [
  {
    label: "General",
    keys: [
      "TOGGLE_AGENT",
      "CYCLE_AGENT",
      "OPEN_COMMAND_PALETTE",
      "OPEN_SETTINGS",
      "TOGGLE_SIDEBAR",
      "CYCLE_MODEL",
      "TOGGLE_THINKING",
      "TOGGLE_NOTIFICATIONS",
    ],
  },
  {
    label: "Chat",
    keys: [
      "SEND_MESSAGE",
      "NEW_LINE",
      "FOCUS_CHAT",
      "FOCUS_INPUT_I",
      "FOCUS_INPUT_A",
      "CANCEL",
      "INTERRUPT_STREAM_NORMAL",
      "INTERRUPT_STREAM_VIM",
      "TOGGLE_VOICE_INPUT",
    ],
  },
  {
    label: "Editing",
    keys: ["SAVE_EDIT", "CANCEL_EDIT"],
  },
  {
    label: "Navigation",
    keys: [
      "NEW_WORKSPACE",
      "ARCHIVE_WORKSPACE",
      "NEXT_WORKSPACE",
      "PREV_WORKSPACE",
      "NAVIGATE_BACK",
      "NAVIGATE_FORWARD",
      "JUMP_TO_BOTTOM",
    ],
  },
  {
    label: "Sidebar Tabs",
    keys: [
      "SIDEBAR_TAB_1",
      "SIDEBAR_TAB_2",
      "SIDEBAR_TAB_3",
      "SIDEBAR_TAB_4",
      "SIDEBAR_TAB_5",
      "SIDEBAR_TAB_6",
      "SIDEBAR_TAB_7",
      "SIDEBAR_TAB_8",
      "SIDEBAR_TAB_9",
      "CLOSE_TAB",
    ],
  },
  {
    label: "Code Review",
    keys: [
      "REFRESH_REVIEW",
      "FOCUS_REVIEW_SEARCH",
      "FOCUS_REVIEW_SEARCH_QUICK",
      "TOGGLE_HUNK_READ",
      "MARK_HUNK_READ",
      "MARK_HUNK_UNREAD",
      "MARK_FILE_READ",
      "TOGGLE_HUNK_COLLAPSE",
    ],
  },
  {
    label: "External",
    keys: ["OPEN_TERMINAL", "OPEN_IN_EDITOR"],
  },
];

export function KeybindsSection() {
  return (
    <div className="space-y-6">
      {KEYBIND_GROUPS.map((group) => (
        <div key={group.label}>
          <h3 className="text-foreground mb-3 text-sm font-medium">{group.label}</h3>
          <div className="space-y-1">
            {group.keys.map((key) => (
              <div
                key={key}
                className="flex items-center justify-between rounded px-2 py-1.5 text-sm"
              >
                <span className="text-muted">{KEYBIND_LABELS[key]}</span>
                <kbd className="bg-background-secondary text-foreground border-border-medium rounded border px-2 py-0.5 font-mono text-xs">
                  {formatKeybind(KEYBINDS[key])}
                </kbd>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
