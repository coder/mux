import React from "react";
import assert from "@/common/utils/assert";
import type { DelegationChildSummary, DelegationInsights } from "@/common/orpc/schemas/chatStats";
import { formatTokens } from "@/common/utils/tokens/tokenMeterUtils";

const AGENT_TYPE_COLORS: Readonly<Record<string, string>> = {
  exec: "var(--color-exec-mode)",
  explore: "var(--color-task-mode)",
  plan: "var(--color-plan-mode)",
};

function formatCompressionRatio(ratio: number): string {
  assert(
    Number.isFinite(ratio) && ratio >= 0,
    "DelegationInsightsSection: compression ratio must be a finite non-negative number"
  );
  const roundedRatio = Math.max(1, Math.round(ratio));
  return `${roundedRatio}:1`;
}

function toPercent(numerator: number, denominator: number): number {
  assert(
    Number.isFinite(numerator) && numerator >= 0,
    "DelegationInsightsSection: numerator must be a finite non-negative number"
  );
  assert(
    Number.isFinite(denominator) && denominator >= 0,
    "DelegationInsightsSection: denominator must be a finite non-negative number"
  );

  if (denominator === 0) {
    return 0;
  }

  const ratio = (numerator / denominator) * 100;
  return Math.min(100, Math.max(0, ratio));
}

function getChildColor(child: DelegationChildSummary): string {
  const childType = child.agentType?.trim().toLowerCase();
  if (!childType) {
    return "var(--color-auto-mode)";
  }

  return AGENT_TYPE_COLORS[childType] ?? "var(--color-auto-mode)";
}

function getChildLabel(child: DelegationChildSummary): string {
  const childType = child.agentType?.trim();
  if (childType?.length) {
    return childType;
  }

  return "unknown";
}

interface DelegationInsightsSectionProps {
  insights: DelegationInsights;
}

export const DelegationInsightsSection: React.FC<DelegationInsightsSectionProps> = (props) => {
  const insights = props.insights;
  if (!insights.hasData) {
    return null;
  }

  const showCompression = insights.compressionRatio > 0;
  const showCompactions = insights.compactionsAvoided > 0;
  const sortedChildren = [...insights.children].sort((a, b) => b.totalTokens - a.totalTokens);
  const showChildren = sortedChildren.length > 0;

  if (!showCompression && !showCompactions && !showChildren) {
    return null;
  }

  const maxChildTokens = Math.max(sortedChildren[0]?.totalTokens ?? 0, 1);
  const reportWidth = toPercent(insights.exploreReportTokens, insights.exploreTokensConsumed);
  const avoidedPercentage = toPercent(
    insights.compactionsAvoided,
    insights.estimatedWithoutDelegation
  );

  return (
    <div className="flex flex-col gap-3">
      {showCompression && (
        <div data-testid="delegation-compression" className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <span className="text-foreground text-xs font-medium">Context Compression</span>
            <span
              className="rounded px-1.5 py-0.5 text-[10px] font-semibold"
              style={{
                background: "var(--color-task-mode)",
                color: "var(--color-on-accent)",
              }}
            >
              {formatCompressionRatio(insights.compressionRatio)}
            </span>
          </div>

          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between text-[11px]">
              <span className="text-muted">Consumed</span>
              <span className="text-muted">{formatTokens(insights.exploreTokensConsumed)}</span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded bg-[var(--color-task-mode)]" />
          </div>

          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between text-[11px]">
              <span className="text-muted">Report</span>
              <span className="text-muted">{formatTokens(insights.exploreReportTokens)}</span>
            </div>
            <div className="bg-border-light h-1.5 w-full overflow-hidden rounded">
              <div
                className="h-full rounded bg-[var(--color-task-mode)]"
                style={{ width: `${reportWidth}%` }}
              />
            </div>
          </div>
        </div>
      )}

      {showCompactions && (
        <div data-testid="delegation-compactions" className="flex flex-col gap-1.5">
          <span className="text-foreground text-xs font-medium">Compactions Avoided</span>
          <div className="flex flex-col gap-0.5 text-[11px]">
            <div className="flex items-center justify-between">
              <span className="text-muted">With delegation</span>
              <span className="text-foreground">{insights.actualCompactions}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted">Estimated without</span>
              <span className="text-foreground">{insights.estimatedWithoutDelegation}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted">Avoided</span>
              <span className="text-foreground">
                {insights.compactionsAvoided} ({Math.round(avoidedPercentage)}%)
              </span>
            </div>
          </div>
        </div>
      )}

      {showChildren && (
        <div data-testid="delegation-children" className="flex flex-col gap-1.5">
          <span className="text-foreground text-xs font-medium">Per-Child Breakdown</span>
          <div className="flex flex-col gap-1">
            {sortedChildren.map((child) => {
              const childPercentage = toPercent(child.totalTokens, maxChildTokens);

              return (
                <div
                  key={child.workspaceId}
                  data-testid="delegation-child-bar"
                  className="flex flex-col gap-0.5"
                >
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="text-muted">{getChildLabel(child)}</span>
                    <span className="text-muted">{formatTokens(child.totalTokens)}</span>
                  </div>
                  <div className="bg-hover h-1.5 w-full overflow-hidden rounded">
                    <div
                      className="h-full rounded transition-[width] duration-300"
                      style={{
                        width: `${childPercentage}%`,
                        background: getChildColor(child),
                      }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};
