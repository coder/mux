import React from "react";
import { useWorkspaceUsage, useWorkspaceConsumers } from "@/browser/stores/WorkspaceStore";
import { getModelStats } from "@/common/utils/tokens/modelStats";
import {
  sumUsageHistory,
  formatCostWithDollar,
  type ChatUsageDisplay,
} from "@/common/utils/tokens/usageAggregator";
import { usePersistedState } from "@/browser/hooks/usePersistedState";
import { ToggleGroup, type ToggleOption } from "../ToggleGroup";
import { useProviderOptions } from "@/browser/hooks/useProviderOptions";
import { supports1MContext } from "@/common/utils/ai/models";
import {
  TOKEN_COMPONENT_COLORS,
  calculateTokenMeterData,
  formatTokens,
} from "@/common/utils/tokens/tokenMeterUtils";
import { ConsumerBreakdown } from "./ConsumerBreakdown";
import { FileBreakdown } from "./FileBreakdown";
import { ContextUsageBar } from "./ContextUsageBar";
import { useAutoCompactionSettings } from "@/browser/hooks/useAutoCompactionSettings";
import { Tooltip, TooltipTrigger, TooltipContent } from "../ui/tooltip";
import { PostCompactionSection } from "./PostCompactionSection";
import { usePostCompactionState } from "@/browser/hooks/usePostCompactionState";
import { useOptionalWorkspaceContext } from "@/browser/contexts/WorkspaceContext";

/**
 * Calculate cost with elevated pricing for 1M context (200k-1M tokens)
 * For tokens above 200k, use elevated pricing rates
 */
const calculateElevatedCost = (tokens: number, standardRate: number, isInput: boolean): number => {
  if (tokens <= 200_000) {
    return tokens * standardRate;
  }
  const baseCost = 200_000 * standardRate;
  const elevatedTokens = tokens - 200_000;
  const elevatedMultiplier = isInput ? 2.0 : 1.5;
  const elevatedCost = elevatedTokens * standardRate * elevatedMultiplier;
  return baseCost + elevatedCost;
};

type ViewMode = "last-request" | "session";

const VIEW_MODE_OPTIONS: Array<ToggleOption<ViewMode>> = [
  { value: "session", label: "Session" },
  { value: "last-request", label: "Last Request" },
];

interface CostsTabProps {
  workspaceId: string;
}

const CostsTabComponent: React.FC<CostsTabProps> = ({ workspaceId }) => {
  const usage = useWorkspaceUsage(workspaceId);
  const consumers = useWorkspaceConsumers(workspaceId);
  const [viewMode, setViewMode] = usePersistedState<ViewMode>("costsTab:viewMode", "session");
  const { options } = useProviderOptions();
  const use1M = options.anthropic?.use1MContext ?? false;

  // Post-compaction context state for UI display
  const postCompactionState = usePostCompactionState(workspaceId);

  // Get runtimeConfig for SSH-aware editor opening
  const workspaceContext = useOptionalWorkspaceContext();
  const runtimeConfig = workspaceContext?.workspaceMetadata.get(workspaceId)?.runtimeConfig;

  // Get model from context usage for per-model threshold storage
  // Use lastContextUsage for context window display (last step's usage)
  const contextUsageForModel = usage.liveUsage ?? usage.lastContextUsage;
  const currentModel = contextUsageForModel?.model ?? null;

  // Auto-compaction settings: threshold per-model (100 = disabled)
  const { threshold: autoCompactThreshold, setThreshold: setAutoCompactThreshold } =
    useAutoCompactionSettings(workspaceId, currentModel);

  // Session usage for cost calculation
  // Uses sessionTotal (pre-computed) + liveCostUsage (cumulative during streaming)
  const sessionUsage = React.useMemo(() => {
    const parts: ChatUsageDisplay[] = [];
    if (usage.sessionTotal) parts.push(usage.sessionTotal);
    if (usage.liveCostUsage) parts.push(usage.liveCostUsage);
    return parts.length > 0 ? sumUsageHistory(parts) : undefined;
  }, [usage.sessionTotal, usage.liveCostUsage]);

  const hasUsageData =
    usage &&
    (usage.sessionTotal !== undefined ||
      usage.lastContextUsage !== undefined ||
      usage.liveUsage !== undefined);
  const hasConsumerData = consumers && (consumers.totalTokens > 0 || consumers.isCalculating);
  const hasAnyData = hasUsageData || hasConsumerData;

  // Only show empty state if truly no data anywhere
  if (!hasAnyData) {
    return (
      <div className="text-light font-primary text-[13px] leading-relaxed">
        <div className="text-secondary px-5 py-10 text-center">
          <p>No messages yet.</p>
          <p>Send a message to see token usage statistics.</p>
        </div>
      </div>
    );
  }

  // Last Request (for Cost section): from persisted data
  const lastRequestUsage = usage.lastRequest?.usage;

  // Cost and Details table use viewMode
  const displayUsage = viewMode === "last-request" ? lastRequestUsage : sessionUsage;

  return (
    <div className="text-light font-primary text-[13px] leading-relaxed">
      {hasUsageData && (
        <div data-testid="context-usage-section" className="mt-2 mb-5">
          <div data-testid="context-usage-list" className="flex flex-col gap-3">
            {(() => {
              const contextUsage = usage.liveUsage ?? usage.lastContextUsage;
              const model = contextUsage?.model ?? "unknown";

              const contextUsageData = contextUsage
                ? calculateTokenMeterData(contextUsage, model, use1M, false)
                : { segments: [], totalTokens: 0, totalPercentage: 0 };

              return (
                <ContextUsageBar
                  testId="context-usage"
                  data={contextUsageData}
                  autoCompaction={{
                    threshold: autoCompactThreshold,
                    setThreshold: setAutoCompactThreshold,
                  }}
                />
              );
            })()}
          </div>
          <PostCompactionSection
            workspaceId={workspaceId}
            planPath={postCompactionState.planPath}
            trackedFilePaths={postCompactionState.trackedFilePaths}
            excludedItems={postCompactionState.excludedItems}
            onToggleExclusion={postCompactionState.toggleExclusion}
            runtimeConfig={runtimeConfig}
          />
        </div>
      )}

      {hasUsageData && (
        <div data-testid="cost-section" className="mb-6">
          <div className="flex flex-col gap-3">
            {(() => {
              // Cost and Details use viewMode-dependent data
              // Get model from the displayUsage (which could be last request or session sum)
              const model = displayUsage?.model ?? lastRequestUsage?.model ?? "unknown";
              const modelStats = getModelStats(model);
              const is1MActive = use1M && supports1MContext(model);

              // Helper to calculate cost percentage
              const getCostPercentage = (cost: number | undefined, total: number | undefined) =>
                total !== undefined && total > 0 && cost !== undefined ? (cost / total) * 100 : 0;

              // Recalculate costs with elevated pricing if 1M context is active
              let adjustedInputCost = displayUsage?.input.cost_usd;
              let adjustedOutputCost = displayUsage?.output.cost_usd;
              let adjustedReasoningCost = displayUsage?.reasoning.cost_usd;

              if (is1MActive && displayUsage && modelStats) {
                // Recalculate input cost with elevated pricing
                adjustedInputCost = calculateElevatedCost(
                  displayUsage.input.tokens,
                  modelStats.input_cost_per_token,
                  true // isInput
                );
                // Recalculate output cost with elevated pricing
                adjustedOutputCost = calculateElevatedCost(
                  displayUsage.output.tokens,
                  modelStats.output_cost_per_token,
                  false // isOutput
                );
                // Recalculate reasoning cost with elevated pricing
                adjustedReasoningCost = calculateElevatedCost(
                  displayUsage.reasoning.tokens,
                  modelStats.output_cost_per_token,
                  false // isOutput
                );
              }

              // Calculate total cost (undefined if any cost is unknown)
              const totalCost: number | undefined = displayUsage
                ? adjustedInputCost !== undefined &&
                  displayUsage.cached.cost_usd !== undefined &&
                  displayUsage.cacheCreate.cost_usd !== undefined &&
                  adjustedOutputCost !== undefined &&
                  adjustedReasoningCost !== undefined
                  ? adjustedInputCost +
                    displayUsage.cached.cost_usd +
                    displayUsage.cacheCreate.cost_usd +
                    adjustedOutputCost +
                    adjustedReasoningCost
                  : undefined
                : undefined;

              // Calculate cost percentages (using adjusted costs for 1M context)
              const inputCostPercentage = getCostPercentage(adjustedInputCost, totalCost);
              const cachedCostPercentage = getCostPercentage(
                displayUsage?.cached.cost_usd,
                totalCost
              );
              const cacheCreateCostPercentage = getCostPercentage(
                displayUsage?.cacheCreate.cost_usd,
                totalCost
              );
              const outputCostPercentage = getCostPercentage(adjustedOutputCost, totalCost);
              const reasoningCostPercentage = getCostPercentage(adjustedReasoningCost, totalCost);

              // Build component data for table (using adjusted costs for 1M context)
              const components = displayUsage
                ? [
                    {
                      name: "Cache Read",
                      tokens: displayUsage.cached.tokens,
                      cost: displayUsage.cached.cost_usd,
                      color: TOKEN_COMPONENT_COLORS.cached,
                      show: displayUsage.cached.tokens > 0,
                    },
                    {
                      name: "Cache Create",
                      tokens: displayUsage.cacheCreate.tokens,
                      cost: displayUsage.cacheCreate.cost_usd,
                      color: TOKEN_COMPONENT_COLORS.cacheCreate,
                      show: displayUsage.cacheCreate.tokens > 0,
                    },
                    {
                      name: "Input",
                      tokens: displayUsage.input.tokens,
                      cost: adjustedInputCost,
                      color: TOKEN_COMPONENT_COLORS.input,
                      show: true,
                    },
                    {
                      name: "Output",
                      tokens: displayUsage.output.tokens,
                      cost: adjustedOutputCost,
                      color: TOKEN_COMPONENT_COLORS.output,
                      show: true,
                    },
                    {
                      name: "Thinking",
                      tokens: displayUsage.reasoning.tokens,
                      cost: adjustedReasoningCost,
                      color: TOKEN_COMPONENT_COLORS.thinking,
                      show: displayUsage.reasoning.tokens > 0,
                    },
                  ].filter((c) => c.show)
                : [];

              return (
                <>
                  {totalCost !== undefined && totalCost >= 0 && (
                    <div data-testid="cost-bar" className="relative mb-2 flex flex-col gap-1">
                      <div
                        data-testid="cost-header"
                        className="mb-2 flex items-baseline justify-between"
                      >
                        <div className="flex items-center gap-3">
                          <span className="text-foreground inline-flex items-baseline gap-1 font-medium">
                            Cost
                          </span>
                          <ToggleGroup
                            options={VIEW_MODE_OPTIONS}
                            value={viewMode}
                            onChange={setViewMode}
                          />
                        </div>
                        <span className="text-muted flex items-center gap-1 text-xs">
                          {formatCostWithDollar(totalCost)}
                          {displayUsage?.hasUnknownCosts && (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span className="text-warning cursor-help">?</span>
                              </TooltipTrigger>
                              <TooltipContent side="bottom" className="max-w-[200px]">
                                Cost may be incomplete — some models in this session have unknown
                                pricing
                              </TooltipContent>
                            </Tooltip>
                          )}
                        </span>
                      </div>
                      <div className="relative w-full">
                        <div className="bg-border-light flex h-1.5 w-full overflow-hidden rounded-[3px]">
                          {cachedCostPercentage > 0 && (
                            <div
                              className="h-full transition-[width] duration-300"
                              style={{
                                width: `${cachedCostPercentage}%`,
                                background: TOKEN_COMPONENT_COLORS.cached,
                              }}
                            />
                          )}
                          {cacheCreateCostPercentage > 0 && (
                            <div
                              className="h-full transition-[width] duration-300"
                              style={{
                                width: `${cacheCreateCostPercentage}%`,
                                background: TOKEN_COMPONENT_COLORS.cacheCreate,
                              }}
                            />
                          )}
                          <div
                            className="h-full transition-[width] duration-300"
                            style={{
                              width: `${inputCostPercentage}%`,
                              background: TOKEN_COMPONENT_COLORS.input,
                            }}
                          />
                          <div
                            className="h-full transition-[width] duration-300"
                            style={{
                              width: `${outputCostPercentage}%`,
                              background: TOKEN_COMPONENT_COLORS.output,
                            }}
                          />
                          {reasoningCostPercentage > 0 && (
                            <div
                              className="h-full transition-[width] duration-300"
                              style={{
                                width: `${reasoningCostPercentage}%`,
                                background: TOKEN_COMPONENT_COLORS.thinking,
                              }}
                            />
                          )}
                        </div>
                      </div>
                    </div>
                  )}
                  <table
                    data-testid="cost-details"
                    className="mt-1 w-full border-collapse text-[11px]"
                  >
                    <thead>
                      <tr className="border-border-light border-b">
                        <th className="text-muted py-1 pr-2 text-left font-medium [&:last-child]:pr-0 [&:last-child]:text-right">
                          Component
                        </th>
                        <th className="text-muted py-1 pr-2 text-left font-medium [&:last-child]:pr-0 [&:last-child]:text-right">
                          Tokens
                        </th>
                        <th className="text-muted py-1 pr-2 text-left font-medium [&:last-child]:pr-0 [&:last-child]:text-right">
                          Cost
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {components.map((component) => {
                        const costDisplay = formatCostWithDollar(component.cost);
                        const isNegligible =
                          component.cost !== undefined &&
                          component.cost > 0 &&
                          component.cost < 0.01;

                        return (
                          <tr key={component.name}>
                            <td className="text-foreground py-1 pr-2 [&:last-child]:pr-0 [&:last-child]:text-right">
                              <div className="flex items-center gap-1.5">
                                <div
                                  className="h-2 w-2 shrink-0 rounded-sm"
                                  style={{ background: component.color }}
                                />
                                {component.name}
                              </div>
                            </td>
                            <td className="text-foreground py-1 pr-2 [&:last-child]:pr-0 [&:last-child]:text-right">
                              {formatTokens(component.tokens)}
                            </td>
                            <td className="text-foreground py-1 pr-2 [&:last-child]:pr-0 [&:last-child]:text-right">
                              {isNegligible ? (
                                <span className="text-dim italic">{costDisplay}</span>
                              ) : (
                                costDisplay
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </>
              );
            })()}
          </div>
        </div>
      )}

      {consumers.topFilePaths && consumers.topFilePaths.length > 0 && (
        <div className="mb-4">
          <h3 className="text-subtle m-0 mb-2 flex items-center gap-1 text-xs font-semibold tracking-wide uppercase">
            File Breakdown
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="text-dim cursor-help text-[10px] font-normal">ⓘ</span>
              </TooltipTrigger>
              <TooltipContent align="start" className="max-w-72 whitespace-normal">
                Token usage from file_read and file_edit tools, aggregated by file path. Consider
                splitting large files to reduce context usage.
              </TooltipContent>
            </Tooltip>
          </h3>
          <FileBreakdown files={consumers.topFilePaths} totalTokens={consumers.totalTokens} />
        </div>
      )}

      {consumers.consumers.length > 0 && (
        <div className="mb-4">
          <h3 className="text-subtle m-0 mb-2 text-xs font-semibold tracking-wide uppercase">
            Consumer Breakdown
          </h3>
          {consumers.isCalculating ? (
            <div className="text-secondary py-2 text-xs italic">Calculating...</div>
          ) : (
            <ConsumerBreakdown
              consumers={consumers.consumers}
              totalTokens={consumers.totalTokens}
            />
          )}
        </div>
      )}

      {!consumers.isCalculating &&
        consumers.consumers.length === 0 &&
        (!consumers.topFilePaths || consumers.topFilePaths.length === 0) && (
          <div className="text-dim py-2 text-xs italic">No consumer data available</div>
        )}
    </div>
  );
};

// Memoize to prevent re-renders when parent (AIView) re-renders during streaming
// Only re-renders when workspaceId changes or internal hook data (usage/consumers) updates
export const CostsTab = React.memo(CostsTabComponent);
