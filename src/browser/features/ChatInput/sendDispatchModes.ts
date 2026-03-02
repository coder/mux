import { KEYBINDS, type Keybind } from "@/browser/utils/ui/keybinds";
import type { QueueDispatchMode } from "./types";

export interface SendDispatchModeEntry {
  mode: QueueDispatchMode;
  label: string;
  keybind: Keybind;
}

export const SEND_DISPATCH_MODES: readonly SendDispatchModeEntry[] = [
  {
    mode: "tool-end",
    label: "Send after step",
    keybind: KEYBINDS.SEND_MESSAGE,
  },
  {
    mode: "turn-end",
    label: "Send after turn",
    keybind: KEYBINDS.SEND_MESSAGE_AFTER_TURN,
  },
] as const;
