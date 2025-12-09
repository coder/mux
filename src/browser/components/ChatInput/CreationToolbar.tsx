import React from "react";
import { Plus, Image, SendHorizontal } from "lucide-react";
import { cn } from "@/common/lib/utils";
import { ProviderIcon } from "../ProviderIcon";
import { formatModelDisplayName } from "@/common/utils/ai/modelDisplay";
import { getModelName, normalizeGatewayModel } from "@/common/utils/ai/models";
import { Select, SelectTrigger, SelectContent, SelectItem } from "../ui/select";
import { Tooltip, TooltipTrigger, TooltipContent } from "../ui/tooltip";
import { formatKeybind, KEYBINDS } from "@/browser/utils/ui/keybinds";
import type { UIMode } from "@/common/types/mode";

interface CreationToolbarProps {
  /** Current model string (provider:model format) */
  model: string;
  /** Recent models for dropdown */
  recentModels: string[];
  /** Callback when model changes */
  onModelChange: (model: string) => void;
  /** Current mode */
  mode: UIMode;
  /** Callback when mode changes */
  onModeChange: (mode: UIMode) => void;
  /** Whether send is enabled */
  canSend: boolean;
  /** Send callback */
  onSend: () => void;
  /** Add file callback */
  onAddFile?: () => void;
  /** Add image callback */
  onAddImage?: () => void;
  /** Whether the toolbar is disabled */
  disabled?: boolean;
}

/**
 * Extract provider from model string, handling gateway format
 * e.g., "anthropic:claude-sonnet-4-5" -> "anthropic"
 * e.g., "mux-gateway:anthropic/claude-sonnet-4-5" -> "anthropic"
 */
function getProvider(model: string): string {
  const normalized = normalizeGatewayModel(model);
  return normalized.split(":")[0] || "anthropic";
}

/**
 * Get short display name for mode
 */
function getModeDisplayName(mode: UIMode): string {
  return mode === "exec" ? "Exec" : "Plan";
}

/**
 * Compact toolbar for creation view matching the reference design:
 * [+] | [Icon Model ∨] [Mode ∨] [📷] [Send ⌘↵]
 */
export function CreationToolbar(props: CreationToolbarProps) {
  const provider = getProvider(props.model);
  const displayName = formatModelDisplayName(getModelName(props.model));

  return (
    <div
      className="bg-dark border-border-medium inline-flex items-center gap-3 rounded-lg border px-4 py-2"
      data-component="CreationToolbar"
    >
      {/* Add file button */}
      {props.onAddFile && (
        <>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={props.onAddFile}
                disabled={props.disabled}
                className="text-muted hover:text-foreground flex items-center justify-center p-1 transition-colors disabled:opacity-50"
                aria-label="Add file"
              >
                <Plus className="h-4 w-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent>Add file</TooltipContent>
          </Tooltip>
          <div className="bg-border-medium mx-1 h-4 w-px" />
        </>
      )}

      {/* Model selector */}
      <Select value={props.model} onValueChange={props.onModelChange} disabled={props.disabled}>
        <SelectTrigger className="text-muted hover:text-foreground h-auto gap-1.5 border-0 bg-transparent p-1 text-sm font-medium focus:ring-0">
          <ProviderIcon provider={provider} className="h-6 w-6" />
          <span>{displayName}</span>
        </SelectTrigger>
        <SelectContent>
          {props.recentModels.map((m) => {
            const mDisplayName = formatModelDisplayName(getModelName(m));
            return (
              <SelectItem key={m} value={m} textValue={mDisplayName}>
                {mDisplayName}
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>

      {/* Mode selector */}
      <Select
        value={props.mode}
        onValueChange={(value) => props.onModeChange(value as UIMode)}
        disabled={props.disabled}
      >
        <SelectTrigger className="text-muted hover:text-foreground h-auto gap-1 border-0 bg-transparent p-1 text-sm font-medium focus:ring-0">
          <span>{getModeDisplayName(props.mode)}</span>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="exec">Exec</SelectItem>
          <SelectItem value="plan">Plan</SelectItem>
        </SelectContent>
      </Select>

      {/* Add image button */}
      {props.onAddImage && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={props.onAddImage}
              disabled={props.disabled}
              className="text-muted hover:text-foreground flex items-center justify-center p-1 transition-colors disabled:opacity-50"
              aria-label="Add image"
            >
              <Image className="h-4 w-4" strokeWidth={1.5} />
            </button>
          </TooltipTrigger>
          <TooltipContent>Add image</TooltipContent>
        </Tooltip>
      )}

      {/* Send button */}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={props.onSend}
            disabled={!props.canSend || props.disabled}
            className={cn(
              "ml-1 inline-flex items-center justify-center rounded p-1.5 transition-colors disabled:opacity-50",
              props.mode === "plan"
                ? "bg-plan-mode hover:bg-plan-mode-hover text-white"
                : "bg-exec-mode hover:bg-exec-mode-hover text-white"
            )}
            aria-label="Send message"
          >
            <SendHorizontal className="h-4 w-4" />
          </button>
        </TooltipTrigger>
        <TooltipContent>Send message ({formatKeybind(KEYBINDS.SEND_MESSAGE)})</TooltipContent>
      </Tooltip>
    </div>
  );
}
