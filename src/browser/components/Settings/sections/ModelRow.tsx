import React from "react";
import { Check, Pencil, Star, Trash2, X } from "lucide-react";
import { GatewayIcon } from "@/browser/components/icons/GatewayIcon";
import { cn } from "@/common/lib/utils";
import { TooltipWrapper, Tooltip } from "@/browser/components/Tooltip";
import { ProviderWithIcon } from "@/browser/components/ProviderIcon";

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
          className="text-muted w-16 shrink-0 text-xs md:w-20"
        />
        {props.isEditing ? (
          <div className="flex min-w-0 flex-1 items-center gap-1">
            <input
              type="text"
              value={props.editValue ?? props.modelId}
              onChange={(e) => props.onEditChange?.(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") props.onSaveEdit?.();
                if (e.key === "Escape") props.onCancelEdit?.();
              }}
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
              <TooltipWrapper inline>
                <span className="text-muted-light shrink-0 text-xs">
                  ({props.aliases.join(", ")})
                </span>
                <Tooltip className="tooltip" align="center">
                  Use with /m {props.aliases[0]}
                </Tooltip>
              </TooltipWrapper>
            )}
          </div>
        )}
      </div>
      <div className="ml-2 flex shrink-0 items-center gap-0.5">
        {props.isEditing ? (
          <>
            <button
              type="button"
              onClick={props.onSaveEdit}
              disabled={props.saving}
              className="text-accent hover:text-accent-dark p-0.5 transition-colors"
              title="Save changes (Enter)"
            >
              <Check className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={props.onCancelEdit}
              disabled={props.saving}
              className="text-muted hover:text-foreground p-0.5 transition-colors"
              title="Cancel (Escape)"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </>
        ) : (
          <>
            {/* Gateway toggle button */}
            {props.onToggleGateway && (
              <TooltipWrapper inline>
                <button
                  type="button"
                  onClick={props.onToggleGateway}
                  className={cn(
                    "p-0.5 transition-colors",
                    props.isGatewayEnabled ? "text-accent" : "text-muted hover:text-accent"
                  )}
                  aria-label={props.isGatewayEnabled ? "Disable Mux Gateway" : "Enable Mux Gateway"}
                >
                  <GatewayIcon className="h-3.5 w-3.5" active={props.isGatewayEnabled} />
                </button>
                <Tooltip className="tooltip" align="center">
                  {props.isGatewayEnabled ? "Using Mux Gateway" : "Use Mux Gateway"}
                </Tooltip>
              </TooltipWrapper>
            )}
            {/* Favorite/default button */}
            <TooltipWrapper inline>
              <button
                type="button"
                onClick={() => {
                  if (!props.isDefault) props.onSetDefault();
                }}
                className={cn(
                  "p-0.5 transition-colors",
                  props.isDefault
                    ? "cursor-default text-yellow-400"
                    : "text-muted hover:text-yellow-400"
                )}
                disabled={props.isDefault}
                aria-label={props.isDefault ? "Current default model" : "Set as default model"}
              >
                <Star className={cn("h-3.5 w-3.5", props.isDefault && "fill-current")} />
              </button>
              <Tooltip className="tooltip" align="center">
                {props.isDefault ? "Default model" : "Set as default"}
              </Tooltip>
            </TooltipWrapper>
            {/* Edit/delete buttons only for custom models */}
            {props.isCustom && (
              <>
                <button
                  type="button"
                  onClick={props.onStartEdit}
                  disabled={Boolean(props.saving) || Boolean(props.hasActiveEdit)}
                  className="text-muted hover:text-foreground p-0.5 transition-colors disabled:opacity-50"
                  title="Edit model"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={props.onRemove}
                  disabled={Boolean(props.saving) || Boolean(props.hasActiveEdit)}
                  className="text-muted hover:text-error p-0.5 transition-colors disabled:opacity-50"
                  title="Remove model"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
