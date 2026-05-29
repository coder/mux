import type { ModelStats } from "@/common/utils/tokens/modelStats";

/** Format tokens as human-readable string (e.g. 200000 -> "200k") */
export function formatTokenCount(tokens: number): string {
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
export function formatCostPerMillion(costPerToken: number): string {
  const perMillion = costPerToken * 1_000_000;
  if (perMillion < 0.01) return "~$0.00";
  return `$${perMillion.toFixed(2)}`;
}

export interface ModelPricingTooltipProps {
  fullId: string;
  aliases?: string[];
  stats: ModelStats | null;
}

/**
 * Body of the per-model pricing tooltip. Shared between the Settings → Models
 * info popover and the chat-input model picker hover tooltip so the two stay
 * visually identical.
 */
export function ModelPricingTooltip(props: ModelPricingTooltipProps) {
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
