/**
 * Voice input button - floats inside the chat input textarea.
 * Minimal footprint: just an icon that changes color based on state.
 */

import React from "react";
import { Mic, Loader2 } from "lucide-react";
import { TooltipWrapper, Tooltip } from "../Tooltip";
import { formatKeybind, KEYBINDS } from "@/browser/utils/ui/keybinds";
import { cn } from "@/common/lib/utils";
import type { VoiceInputState } from "@/browser/hooks/useVoiceInput";

interface VoiceInputButtonProps {
  state: VoiceInputState;
  isApiKeySet: boolean;
  shouldShowUI: boolean;
  onToggle: () => void;
  disabled?: boolean;
}

const STATE_CONFIG: Record<VoiceInputState, { label: string; colorClass: string }> = {
  idle: { label: "Voice input", colorClass: "text-muted/50 hover:text-muted" },
  recording: { label: "Stop recording", colorClass: "text-blue-500 animate-pulse" },
  transcribing: { label: "Transcribing...", colorClass: "text-amber-500" },
};

export const VoiceInputButton: React.FC<VoiceInputButtonProps> = (props) => {
  if (!props.shouldShowUI) return null;

  const needsApiKey = !props.isApiKeySet;
  const { label, colorClass } = needsApiKey
    ? { label: "Voice input (requires OpenAI API key)", colorClass: "text-muted/50" }
    : STATE_CONFIG[props.state];

  const Icon = props.state === "transcribing" ? Loader2 : Mic;
  const isTranscribing = props.state === "transcribing";

  return (
    <TooltipWrapper inline>
      <button
        type="button"
        onClick={props.onToggle}
        disabled={(props.disabled ?? false) || isTranscribing || needsApiKey}
        aria-label={label}
        aria-pressed={props.state === "recording"}
        className={cn(
          "inline-flex items-center justify-center rounded p-0.5 transition-colors duration-150",
          "disabled:cursor-not-allowed disabled:opacity-40",
          colorClass
        )}
      >
        <Icon className={cn("h-4 w-4", isTranscribing && "animate-spin")} strokeWidth={1.5} />
      </button>
      <Tooltip className="tooltip" align="right">
        {needsApiKey ? (
          <>
            Voice input requires OpenAI API key.
            <br />
            Configure in Settings → Providers.
          </>
        ) : (
          <>
            <strong>Voice input</strong> — press space on empty input
            <br />
            or {formatKeybind(KEYBINDS.TOGGLE_VOICE_INPUT)} anytime
            <br />
            <br />
            While recording: space sends, esc cancels
          </>
        )}
      </Tooltip>
    </TooltipWrapper>
  );
};
