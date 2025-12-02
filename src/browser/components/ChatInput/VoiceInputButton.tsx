/**
 * Voice input button - floats inside the chat input textarea.
 * Minimal footprint: just an icon that changes color based on state.
 *
 * Visual states:
 * - Idle: Subtle gray mic icon
 * - Recording: Blue pulsing mic
 * - Transcribing: Amber spinning loader
 * - Hidden: When on mobile, unsupported, or no OpenAI key
 */

import React from "react";
import { Mic, Loader2 } from "lucide-react";
import { TooltipWrapper, Tooltip } from "../Tooltip";
import { formatKeybind, KEYBINDS } from "@/browser/utils/ui/keybinds";
import { cn } from "@/common/lib/utils";

interface VoiceInputButtonProps {
  isListening: boolean;
  isTranscribing: boolean;
  isSupported: boolean;
  shouldShowUI: boolean;
  onToggle: () => void;
  disabled?: boolean;
}

export const VoiceInputButton: React.FC<VoiceInputButtonProps> = (props) => {
  // Don't render if we shouldn't show UI (mobile, unsupported, or no OpenAI key)
  if (!props.shouldShowUI) {
    return null;
  }

  const label = props.isTranscribing
    ? "Transcribing..."
    : props.isListening
      ? "Stop recording"
      : "Voice input";

  const Icon = props.isTranscribing ? Loader2 : Mic;

  return (
    <TooltipWrapper inline>
      <button
        type="button"
        onClick={props.onToggle}
        disabled={(props.disabled ?? false) || !props.isSupported || props.isTranscribing}
        aria-label={label}
        aria-pressed={props.isListening}
        className={cn(
          "inline-flex items-center justify-center rounded p-0.5 transition-colors duration-150",
          "disabled:cursor-not-allowed disabled:opacity-40",
          props.isTranscribing
            ? "text-amber-500"
            : props.isListening
              ? "text-blue-500 animate-pulse"
              : "text-muted/50 hover:text-muted"
        )}
      >
        <Icon className={cn("h-4 w-4", props.isTranscribing && "animate-spin")} strokeWidth={1.5} />
      </button>
      <Tooltip className="tooltip" align="right">
        {label} ({formatKeybind(KEYBINDS.TOGGLE_VOICE_INPUT)})
      </Tooltip>
    </TooltipWrapper>
  );
};
