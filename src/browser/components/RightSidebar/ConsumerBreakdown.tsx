import React from "react";
import type { WorkspaceConsumersState } from "@/browser/stores/WorkspaceStore";
import { TooltipWrapper, Tooltip, HelpIndicator } from "../Tooltip";

// Format token display - show k for thousands with 1 decimal
const formatTokens = (tokens: number) =>
  tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : tokens.toLocaleString();

interface ConsumerBreakdownProps {
  consumers: WorkspaceConsumersState;
}

const ConsumerBreakdownComponent: React.FC<ConsumerBreakdownProps> = ({ consumers }) => {
  if (consumers.isCalculating) {
    return <div className="text-secondary py-3 italic">Calculating consumer breakdown...</div>;
  }

  if (consumers.consumers.length === 0) {
    return <div className="text-dim py-3 text-left italic">No consumer data available</div>;
  }

  return (
    <>
      <div className="text-muted mb-2 text-xs">
        Tokenizer: <span>{consumers.tokenizerName}</span>
      </div>
      <div className="flex flex-col gap-3">
        {consumers.consumers.map((consumer) => {
          // Calculate percentages for fixed and variable segments
          const fixedPercentage = consumer.fixedTokens
            ? (consumer.fixedTokens / consumers.totalTokens) * 100
            : 0;
          const variablePercentage = consumer.variableTokens
            ? (consumer.variableTokens / consumers.totalTokens) * 100
            : 0;

          const tokenDisplay = formatTokens(consumer.tokens);

          return (
            <div key={consumer.name} className="mb-2 flex flex-col gap-1">
              <div className="mb-1 flex items-center justify-between">
                <span className="text-foreground flex items-center gap-1 font-medium">
                  {consumer.name}
                  {consumer.name === "web_search" && (
                    <TooltipWrapper inline>
                      <HelpIndicator>?</HelpIndicator>
                      <Tooltip className="tooltip" align="center" width="wide">
                        Web search results are encrypted and decrypted server-side. This estimate is
                        approximate.
                      </Tooltip>
                    </TooltipWrapper>
                  )}
                </span>
                <span className="text-muted text-xs">
                  {tokenDisplay} ({consumer.percentage.toFixed(1)}%)
                </span>
              </div>
              <div className="flex flex-col gap-1">
                <div className="bg-hover flex h-2 w-full overflow-hidden rounded">
                  {consumer.fixedTokens && consumer.variableTokens ? (
                    <>
                      <div
                        className="bg-token-fixed h-full transition-[width] duration-300"
                        style={{ width: `${fixedPercentage}%` }}
                      />
                      <div
                        className="bg-token-variable h-full transition-[width] duration-300"
                        style={{ width: `${variablePercentage}%` }}
                      />
                    </>
                  ) : (
                    <div
                      className="h-full bg-[linear-gradient(90deg,var(--color-token-input)_0%,var(--color-token-output)_100%)] transition-[width] duration-300"
                      style={{ width: `${consumer.percentage}%` }}
                    />
                  )}
                </div>
                {consumer.fixedTokens && consumer.variableTokens && (
                  <div className="text-dim text-left text-[11px]">
                    Tool definition: {formatTokens(consumer.fixedTokens)} • Usage:{" "}
                    {formatTokens(consumer.variableTokens)}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
};

// Memoize to prevent re-renders when parent re-renders but consumers data hasn't changed
// Only re-renders when consumers object reference changes (when store bumps it)
export const ConsumerBreakdown = React.memo(ConsumerBreakdownComponent);
