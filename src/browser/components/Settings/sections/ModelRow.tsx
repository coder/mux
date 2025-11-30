import React from "react";
import { Check, Pencil, Star, Trash2, X } from "lucide-react";
import { cn } from "@/common/lib/utils";
import { PROVIDER_DISPLAY_NAMES } from "@/common/constants/providers";
import { TooltipWrapper, Tooltip } from "@/browser/components/Tooltip";

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
  onSetDefault: () => void;
  onStartEdit?: () => void;
  onSaveEdit?: () => void;
  onCancelEdit?: () => void;
  onEditChange?: (value: string) => void;
  onRemove?: () => void;
}

export function ModelRow(props: ModelRowProps) {
  return (
    <div className="border-border-medium bg-background-secondary flex items-center justify-between rounded-md border px-4 py-2">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <span className="text-muted w-20 shrink-0 text-xs">
          {PROVIDER_DISPLAY_NAMES[props.provider as keyof typeof PROVIDER_DISPLAY_NAMES] ??
            props.provider}
        </span>
        {props.isEditing ? (
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <input
              type="text"
              value={props.editValue ?? props.modelId}
              onChange={(e) => props.onEditChange?.(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") props.onSaveEdit?.();
                if (e.key === "Escape") props.onCancelEdit?.();
              }}
              className="bg-modal-bg border-border-medium focus:border-accent min-w-0 flex-1 rounded border px-2 py-1 font-mono text-xs focus:outline-none"
              autoFocus
            />
            {props.editError && <div className="text-error text-xs">{props.editError}</div>}
          </div>
        ) : (
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="text-foreground min-w-0 truncate font-mono text-sm">
              {props.modelId}
            </span>
            {props.aliases && props.aliases.length > 0 && (
              <span className="text-muted-light text-xs">
                aliases: {props.aliases.map((a) => `/${a}`).join(", ")}
              </span>
            )}
          </div>
        )}
      </div>
      <div className="ml-2 flex shrink-0 items-center gap-1">
        {props.isEditing ? (
          <>
            <button
              type="button"
              onClick={props.onSaveEdit}
              disabled={props.saving}
              className="text-accent hover:text-accent-dark p-1 transition-colors"
              title="Save changes (Enter)"
            >
              <Check className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={props.onCancelEdit}
              disabled={props.saving}
              className="text-muted hover:text-foreground p-1 transition-colors"
              title="Cancel (Escape)"
            >
              <X className="h-4 w-4" />
            </button>
          </>
        ) : (
          <>
            {/* Favorite/default button */}
            <TooltipWrapper inline>
              <button
                type="button"
                onClick={() => {
                  if (!props.isDefault) props.onSetDefault();
                }}
                className={cn(
                  "p-1 transition-colors",
                  props.isDefault
                    ? "cursor-default text-yellow-400"
                    : "text-muted hover:text-yellow-400"
                )}
                disabled={props.isDefault}
                aria-label={props.isDefault ? "Current default model" : "Set as default model"}
              >
                <Star className={cn("h-4 w-4", props.isDefault && "fill-current")} />
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
                  className="text-muted hover:text-foreground p-1 transition-colors disabled:opacity-50"
                  title="Edit model"
                >
                  <Pencil className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={props.onRemove}
                  disabled={Boolean(props.saving) || Boolean(props.hasActiveEdit)}
                  className="text-muted hover:text-error p-1 transition-colors disabled:opacity-50"
                  title="Remove model"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
