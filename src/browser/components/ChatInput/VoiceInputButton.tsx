/**
 * Voice input button - floats inside the chat input textarea.
 * Minimal footprint: just an icon that changes color based on state.
 */

import React from "react";
import { Mic, Loader2 } from "lucide-react";
import { Tooltip, TooltipTrigger, TooltipContent } from "../ui/tooltip";
import { formatKeybind, KEYBINDS } from "@/browser/utils/ui/keybinds";
import { cn } from "@/common/lib/utils";
import type { VoiceInputState } from "@/browser/hooks/useVoiceInput";

interface VoiceInputButtonProps {
  state: VoiceInputState;
  isApiKeySet: boolean;
  shouldShowUI: boolean;
  requiresSecureContext: boolean;
  onToggle: () => void;
  disabled?: boolean;
  /** CSS color value for recording state (e.g., "var(--color-exec-mode)") */
  agentColor: string;
}

/** Color classes for non-recording voice input states */
const STATE_COLORS: Record<Exclude<VoiceInputState, "recording">, string> = {
  idle: "text-muted/50 hover:text-muted",
  requesting: "text-amber-500 animate-pulse",
  transcribing: "text-amber-500",
};

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

  const isRecording = props.state === "recording";
  const isTranscribing = props.state === "transcribing";
  const colorClass = isDisabled
    ? "text-muted/50"
    : isRecording
      ? "animate-pulse"
      : STATE_COLORS[props.state as keyof typeof STATE_COLORS];

  const Icon = isTranscribing ? Loader2 : Mic;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={props.onToggle}
          disabled={(props.disabled ?? false) || isTranscribing || isDisabled}
          aria-label={label}
          aria-pressed={isRecording}
          className={cn(
            "inline-flex items-center justify-center rounded p-0.5 transition-colors duration-150",
            "disabled:cursor-not-allowed disabled:opacity-40",
            colorClass
          )}
          style={isRecording && !isDisabled ? { color: props.agentColor } : undefined}
        >
          <Icon className={cn("h-4 w-4", isTranscribing && "animate-spin")} strokeWidth={1.5} />
        </button>
      </TooltipTrigger>
      <TooltipContent>
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
      </TooltipContent>
    </Tooltip>
  );
};
