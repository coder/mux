import React from "react";
import type { TokenConsumer } from "@/common/types/chatStats";
import { Tooltip, TooltipTrigger, TooltipContent, HelpIndicator } from "../ui/tooltip";

// Format token display - show k for thousands with 1 decimal
const formatTokens = (tokens: number) =>
  tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : tokens.toLocaleString();

interface ConsumerBreakdownProps {
  consumers: TokenConsumer[];
  totalTokens: number;
}

const ConsumerBreakdownComponent: React.FC<ConsumerBreakdownProps> = ({
  consumers,
  totalTokens,
}) => {
  if (consumers.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col gap-2">
      {consumers.map((consumer) => {
        // Calculate percentages for fixed and variable segments
        const fixedPercentage = consumer.fixedTokens
          ? (consumer.fixedTokens / totalTokens) * 100
          : 0;
        const variablePercentage = consumer.variableTokens
          ? (consumer.variableTokens / totalTokens) * 100
          : 0;

        return (
          <div key={consumer.name} className="flex flex-col gap-0.5">
            <div className="flex items-center justify-between">
              <span className="text-foreground flex items-center gap-1 text-xs font-medium">
                {consumer.name}
                {consumer.name === "web_search" && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <HelpIndicator>?</HelpIndicator>
                    </TooltipTrigger>
                    <TooltipContent align="center" className="max-w-80 whitespace-normal">
                      Web search results are encrypted and decrypted server-side. This estimate is
                      approximate.
                    </TooltipContent>
                  </Tooltip>
                )}
              </span>
              <span className="text-muted text-[11px]">
                {formatTokens(consumer.tokens)} ({consumer.percentage.toFixed(1)}%)
              </span>
            </div>
            <div className="bg-hover flex h-1.5 w-full overflow-hidden rounded">
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
          </div>
        );
      })}
    </div>
  );
};

// Memoize to prevent re-renders when parent re-renders but consumers data hasn't changed
// Only re-renders when consumers object reference changes (when store bumps it)
export const ConsumerBreakdown = React.memo(ConsumerBreakdownComponent);
