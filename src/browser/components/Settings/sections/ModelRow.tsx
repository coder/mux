import React from "react";
import { Check, Pencil, Star, Trash2, X } from "lucide-react";
import { createEditKeyHandler } from "@/browser/utils/ui/keybinds";
import { GatewayIcon } from "@/browser/components/icons/GatewayIcon";
import { cn } from "@/common/lib/utils";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/browser/components/ui/tooltip";
import { ProviderWithIcon } from "@/browser/components/ProviderIcon";
import { Button } from "@/browser/components/ui/button";

export interface ModelRowProps {
  provider: string;
  modelId: string;
  fullId: string;
  aliases?: string[];
  isCustom: boolean;
  isDefault: boolean;
  isEditing: boolean;
  editValue?: string;
  editError?: string | null;
  saving?: boolean;
  hasActiveEdit?: boolean;
  /** Whether gateway mode is enabled for this model */
  isGatewayEnabled?: boolean;
  /** Whether to show the gateway toggle button */
  showGatewayToggle?: boolean;
  /** Whether the gateway toggle is disabled (show but can't click) */
  gatewayToggleDisabled?: boolean;
  onSetDefault: () => void;
  onStartEdit?: () => void;
  onSaveEdit?: () => void;
  onCancelEdit?: () => void;
  onEditChange?: (value: string) => void;
  onRemove?: () => void;
  /** Toggle gateway mode for this model */
  onToggleGateway?: () => void;
}

export function ModelRow(props: ModelRowProps) {
  return (
    <div className="border-border-medium bg-background-secondary flex items-center justify-between gap-2 rounded-md border px-2 py-1.5 md:px-3">
      <div className="flex min-w-0 flex-1 items-center gap-1.5 md:gap-2">
        <ProviderWithIcon
          provider={props.provider}
          displayName
          className="text-muted w-16 shrink-0 overflow-hidden text-xs md:w-20"
        />
        {props.isEditing ? (
          <div className="flex min-w-0 flex-1 items-center gap-1">
            <input
              type="text"
              value={props.editValue ?? props.modelId}
              onChange={(e) => props.onEditChange?.(e.target.value)}
              onKeyDown={createEditKeyHandler({
                onSave: () => props.onSaveEdit?.(),
                onCancel: () => props.onCancelEdit?.(),
              })}
              className="bg-modal-bg border-border-medium focus:border-accent min-w-0 flex-1 rounded border px-2 py-0.5 font-mono text-xs focus:outline-none"
              autoFocus
            />
            {props.editError && <div className="text-error text-xs">{props.editError}</div>}
          </div>
        ) : (
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <span className="text-foreground min-w-0 truncate font-mono text-xs">
              {props.modelId}
            </span>
            {props.aliases && props.aliases.length > 0 && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="text-muted-light shrink-0 text-xs">
                    ({props.aliases.join(", ")})
                  </span>
                </TooltipTrigger>
                <TooltipContent align="center">Use with /m {props.aliases[0]}</TooltipContent>
              </Tooltip>
            )}
          </div>
        )}
      </div>
      <div className="ml-2 flex shrink-0 items-center gap-0.5">
        {props.isEditing ? (
          <>
            <Button
              variant="ghost"
              size="icon"
              onClick={props.onSaveEdit}
              disabled={props.saving}
              className="text-accent hover:text-accent-dark h-6 w-6"
              title="Save changes (Enter)"
            >
              <Check className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={props.onCancelEdit}
              disabled={props.saving}
              className="text-muted hover:text-foreground h-6 w-6"
              title="Cancel (Escape)"
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </>
        ) : (
          <>
            {/* Gateway toggle button */}
            {props.showGatewayToggle && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={props.gatewayToggleDisabled ? undefined : props.onToggleGateway}
                    className={cn(
                      "p-0.5 transition-colors",
                      props.gatewayToggleDisabled
                        ? "cursor-not-allowed text-muted opacity-40"
                        : props.isGatewayEnabled
                          ? "text-accent"
                          : "text-muted hover:text-accent"
                    )}
                    aria-label={
                      props.gatewayToggleDisabled
                        ? "Configure Mux Gateway to enable"
                        : props.isGatewayEnabled
                          ? "Disable Mux Gateway"
                          : "Enable Mux Gateway"
                    }
                    disabled={props.gatewayToggleDisabled}
                  >
                    <GatewayIcon className="h-3.5 w-3.5" active={props.isGatewayEnabled} />
                  </button>
                </TooltipTrigger>
                <TooltipContent align="center">
                  {props.gatewayToggleDisabled
                    ? "Configure Mux Gateway in Providers to enable"
                    : props.isGatewayEnabled
                      ? "Using Mux Gateway"
                      : "Use Mux Gateway"}
                </TooltipContent>
              </Tooltip>
            )}
            {/* Favorite/default button */}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => {
                    if (!props.isDefault) props.onSetDefault();
                  }}
                  className={cn(
                    "h-6 w-6",
                    props.isDefault
                      ? "cursor-default text-yellow-400 hover:text-yellow-400"
                      : "text-muted hover:text-yellow-400"
                  )}
                  disabled={props.isDefault}
                  aria-label={props.isDefault ? "Current default model" : "Set as default model"}
                >
                  <Star className={cn("h-3.5 w-3.5", props.isDefault && "fill-current")} />
                </Button>
              </TooltipTrigger>
              <TooltipContent align="center">
                {props.isDefault ? "Default model" : "Set as default"}
              </TooltipContent>
            </Tooltip>
            {/* Edit/delete buttons only for custom models */}
            {props.isCustom && (
              <>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={props.onStartEdit}
                  disabled={Boolean(props.saving) || Boolean(props.hasActiveEdit)}
                  className="text-muted hover:text-foreground h-6 w-6"
                  title="Edit model"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={props.onRemove}
                  disabled={Boolean(props.saving) || Boolean(props.hasActiveEdit)}
                  className="text-muted hover:text-error h-6 w-6"
                  title="Remove model"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
