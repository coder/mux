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
import type { UIMode } from "@/common/types/mode";

interface VoiceInputButtonProps {
  state: VoiceInputState;
  isApiKeySet: boolean;
  shouldShowUI: boolean;
  requiresSecureContext: boolean;
  onToggle: () => void;
  disabled?: boolean;
  mode: UIMode;
}

/** Color classes for each voice input state */
const STATE_COLORS: Record<VoiceInputState, string> = {
  idle: "text-muted/50 hover:text-muted",
  recording: "", // Set dynamically based on mode
  transcribing: "text-amber-500",
};

const RECORDING_COLORS: Record<UIMode, string> = {
  plan: "text-plan-mode-light animate-pulse",
  exec: "text-exec-mode-light animate-pulse",
};

function getColorClass(state: VoiceInputState, mode: UIMode): string {
  return state === "recording" ? RECORDING_COLORS[mode] : STATE_COLORS[state];
}

export const VoiceInputButton: React.FC<VoiceInputButtonProps> = (props) => {
  if (!props.shouldShowUI) return null;

  const needsHttps = props.requiresSecureContext;
  const needsApiKey = !needsHttps && !props.isApiKeySet;
  const isDisabled = needsHttps || needsApiKey;

  const label = isDisabled
    ? needsHttps
      ? "Voice input (requires HTTPS)"
      : "Voice input (requires OpenAI API key)"
    : props.state === "recording"
      ? "Stop recording"
      : props.state === "transcribing"
        ? "Transcribing..."
        : "Voice input";

  const colorClass = isDisabled ? "text-muted/50" : getColorClass(props.state, props.mode);

  const Icon = props.state === "transcribing" ? Loader2 : Mic;
  const isTranscribing = props.state === "transcribing";

  return (
    <TooltipWrapper inline>
      <button
        type="button"
        onClick={props.onToggle}
        disabled={(props.disabled ?? false) || isTranscribing || isDisabled}
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
        {needsHttps ? (
          <>
            Voice input requires a secure connection.
            <br />
            Use HTTPS or access via localhost.
          </>
        ) : needsApiKey ? (
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
