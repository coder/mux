import { Check, Eye, Info, Pencil, Star, Trash2, X } from "lucide-react";
import { createEditKeyHandler } from "@/browser/utils/ui/keybinds";
import { GatewayToggleButton } from "@/browser/components/GatewayToggleButton";
import { cn } from "@/common/lib/utils";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/browser/components/ui/tooltip";
import { ProviderWithIcon } from "@/browser/components/ProviderIcon";
import { Button } from "@/browser/components/ui/button";
import { getModelStats, type ModelStats } from "@/common/utils/tokens/modelStats";

/** Format tokens as human-readable string (e.g. 200000 -> "200k") */
function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000;
    return m % 1 === 0 ? `${m}M` : `${m.toFixed(1)}M`;
  }
  if (tokens >= 1_000) {
    const k = tokens / 1_000;
    return k % 1 === 0 ? `${k}k` : `${k.toFixed(1)}k`;
  }
  return tokens.toString();
}

/** Format cost per million tokens (e.g. 0.000001 -> "$1.00") */
function formatCostPerMillion(costPerToken: number): string {
  const perMillion = costPerToken * 1_000_000;
  if (perMillion < 0.01) return "~$0.00";
  return `$${perMillion.toFixed(2)}`;
}

function ModelTooltipContent(props: {
  fullId: string;
  aliases?: string[];
  stats: ModelStats | null;
}) {
  return (
    <div className="max-w-xs space-y-2 text-xs">
      <div className="text-foreground font-mono">{props.fullId}</div>

      {props.aliases && props.aliases.length > 0 && (
        <div className="text-muted">
          <span className="text-muted-light">Aliases: </span>
          {props.aliases.join(", ")}
        </div>
      )}

      {props.stats && (
        <>
          <div className="border-separator-light border-t pt-2">
            <div className="grid grid-cols-2 gap-x-3 gap-y-1">
              <div className="text-muted-light">Context Window</div>
              <div className="text-foreground">
                {formatTokenCount(props.stats.max_input_tokens)}
              </div>

              {props.stats.max_output_tokens && (
                <>
                  <div className="text-muted-light">Max Output</div>
                  <div className="text-foreground">
                    {formatTokenCount(props.stats.max_output_tokens)}
                  </div>
                </>
              )}
            </div>
          </div>

          <div className="border-separator-light border-t pt-2">
            <div className="text-muted-light mb-1">Pricing (per 1M tokens)</div>
            <div className="grid grid-cols-2 gap-x-3 gap-y-1">
              <div className="text-muted-light">Input</div>
              <div className="text-foreground">
                {formatCostPerMillion(props.stats.input_cost_per_token)}
              </div>

              <div className="text-muted-light">Output</div>
              <div className="text-foreground">
                {formatCostPerMillion(props.stats.output_cost_per_token)}
              </div>

              {props.stats.cache_read_input_token_cost !== undefined && (
                <>
                  <div className="text-muted-light">Cache Read</div>
                  <div className="text-foreground">
                    {formatCostPerMillion(props.stats.cache_read_input_token_cost)}
                  </div>
                </>
              )}

              {props.stats.cache_creation_input_token_cost !== undefined && (
                <>
                  <div className="text-muted-light">Cache Write</div>
                  <div className="text-foreground">
                    {formatCostPerMillion(props.stats.cache_creation_input_token_cost)}
                  </div>
                </>
              )}
            </div>
          </div>
        </>
      )}

      {!props.stats && <div className="text-muted-light italic">No pricing data available</div>}
    </div>
  );
}

/**
 * Inline toggle that slides between the model's base context window and 1M.
 * Renders as a compact pill: clicking toggles the state, with the active
 * end highlighted in accent.
 */
function ContextWindowSlider(props: {
  baseTokens: number;
  enabled: boolean;
  onToggle: () => void;
}) {
  const baseLabel = formatTokenCount(props.baseTokens);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            props.onToggle();
          }}
          className="border-border-medium bg-background-tertiary flex items-center gap-px rounded-full border px-0.5 py-px"
          aria-label={props.enabled ? "Disable 1M context (beta)" : "Enable 1M context (beta)"}
        >
          <span
            className={cn(
              "rounded-full px-1.5 py-0.5 text-[10px] leading-none font-medium transition-colors",
              !props.enabled ? "bg-background-secondary text-foreground" : "text-muted"
            )}
          >
            {baseLabel}
          </span>
          <span
            className={cn(
              "rounded-full px-1.5 py-0.5 font-mono text-[10px] leading-none font-bold transition-colors",
              props.enabled ? "bg-accent/20 text-accent" : "text-muted"
            )}
          >
            1M
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">
        {props.enabled ? "1M context enabled (beta)" : "Enable 1M context (beta)"}
      </TooltipContent>
    </Tooltip>
  );
}

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
  /** Whether 1M context is enabled for this model */
  is1MContextEnabled?: boolean;
  /** Whether this model is hidden from the selector */
  isHiddenFromSelector?: boolean;
  onSetDefault: () => void;
  onStartEdit?: () => void;
  onSaveEdit?: () => void;
  onCancelEdit?: () => void;
  onEditChange?: (value: string) => void;
  onRemove?: () => void;
  /** Toggle gateway mode for this model */
  onToggleGateway?: () => void;
  /** Toggle 1M context for this model (only shown when defined, i.e. model supports it) */
  onToggle1MContext?: () => void;
  /** Toggle visibility in model selector */
  onToggleVisibility?: () => void;
}

export function ModelRow(props: ModelRowProps) {
  const stats = getModelStats(props.fullId);

  // Editing mode - render as a full-width row
  if (props.isEditing) {
    return (
      <tr className="border-border-medium border-b">
        <td colSpan={4} className="px-2 py-1.5 md:px-3">
          <div className="flex items-center gap-2">
            <ProviderWithIcon
              provider={props.provider}
              displayName
              className="text-muted w-16 shrink-0 overflow-hidden text-xs md:w-20"
            />
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
          </div>
          {props.editError && <div className="text-error mt-1 text-xs">{props.editError}</div>}
        </td>
      </tr>
    );
  }

  return (
    <tr
      className={cn(
        "border-border-medium hover:bg-background-secondary/50 group border-b transition-colors",
        props.isHiddenFromSelector && "opacity-50"
      )}
    >
      {/* Provider */}
      <td className="w-20 py-1.5 pr-2 pl-2 md:w-24 md:pl-3">
        <ProviderWithIcon
          provider={props.provider}
          displayName
          className="text-muted overflow-hidden text-xs"
        />
      </td>

      {/* Model ID + Aliases */}
      <td className="min-w-0 py-1.5 pr-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="text-foreground min-w-0 truncate font-mono text-xs">
            {props.modelId}
          </span>
          {props.aliases && props.aliases.length > 0 && (
            <span className="text-muted-light shrink-0 text-xs">({props.aliases[0]})</span>
          )}
        </div>
      </td>

      {/* Context Window — inline slider for models that support 1M context */}
      <td className="w-16 py-1.5 pr-2 md:w-20">
        {props.onToggle1MContext && stats ? (
          <ContextWindowSlider
            baseTokens={stats.max_input_tokens}
            enabled={props.is1MContextEnabled ?? false}
            onToggle={props.onToggle1MContext}
          />
        ) : (
          <span className="text-muted block text-right text-xs">
            {stats ? formatTokenCount(stats.max_input_tokens) : "—"}
          </span>
        )}
      </td>

      {/* Actions */}
      <td className="w-28 py-1.5 pr-2 md:w-32 md:pr-3">
        <div className="flex items-center justify-end gap-0.5">
          {/* Info tooltip */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="text-muted hover:text-foreground p-0.5 transition-colors"
                aria-label="Model details"
              >
                <Info className="h-3.5 w-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" align="end" className="p-3">
              <ModelTooltipContent fullId={props.fullId} aliases={props.aliases} stats={stats} />
            </TooltipContent>
          </Tooltip>
          {/* Visibility toggle button */}
          {props.onToggleVisibility && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                props.onToggleVisibility?.();
              }}
              className={cn(
                "relative p-0.5 transition-colors",
                props.isHiddenFromSelector ? "text-muted-light" : "text-muted hover:text-foreground"
              )}
              aria-label={
                props.isHiddenFromSelector ? "Show in model selector" : "Hide from model selector"
              }
            >
              <Eye
                className={cn(
                  "h-3.5 w-3.5",
                  props.isHiddenFromSelector ? "opacity-30" : "opacity-70"
                )}
              />
              {props.isHiddenFromSelector && (
                <span className="bg-muted-light absolute inset-0 m-auto h-px w-4 rotate-45" />
              )}
            </button>
          )}
          {/* Gateway toggle button */}
          {props.onToggleGateway && (
            <GatewayToggleButton
              active={props.isGatewayEnabled ?? false}
              onToggle={() => props.onToggleGateway?.()}
            />
          )}
          {/* Favorite/default button */}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
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
          {/* Edit/delete buttons only for custom models */}
          {props.isCustom && (
            <>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  props.onStartEdit?.();
                }}
                disabled={Boolean(props.saving) || Boolean(props.hasActiveEdit)}
                className="text-muted hover:text-foreground p-0.5 transition-colors"
                aria-label="Edit model"
              >
                <Pencil className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  props.onRemove?.();
                }}
                disabled={Boolean(props.saving) || Boolean(props.hasActiveEdit)}
                className="text-muted hover:text-error p-0.5 transition-colors"
                aria-label="Remove model"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </>
          )}
        </div>
      </td>
    </tr>
  );
}
