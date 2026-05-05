import React from "react";
import { Target } from "lucide-react";
import { cn } from "@/common/lib/utils";
import { GoalRecordV1Schema } from "@/common/orpc/schemas/goal";
import type { GoalRecordV1, GoalStatus } from "@/common/types/goal";
// Re-export the canonical formatter from common/utils so the rest of the app
// has one place to import from and we keep the assert guard intact across
// callers (Coder-agents-review P2 DEREM-11).
import { formatGoalCents } from "@/common/utils/goals/budgetPricing";
export { formatGoalCents };

export function formatGoalElapsed(startedAtMs: number, nowMs: number = Date.now()): string {
  const elapsedMs = Math.max(0, nowMs - startedAtMs);
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 1) {
    return "<1m";
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 1) {
    return `${minutes}m`;
  }
  return `${hours}h ${minutes % 60}m`;
}

export function formatGoalTurns(turnsUsed: number, turnCap: number | null): string {
  return turnCap == null
    ? `${turnsUsed} turn${turnsUsed === 1 ? "" : "s"}`
    : `${turnsUsed} / ${turnCap} turns`;
}

export function formatGoalBudgetSummary(costCents: number, budgetCents: number | null): string {
  if (budgetCents == null) {
    return formatGoalCents(costCents);
  }
  return `${formatGoalCents(costCents)} / ${formatGoalCents(budgetCents)}`;
}

const STATUS_LABELS: Record<GoalStatus, string> = {
  active: "Active",
  paused: "Paused",
  budget_limited: "Budget limited",
  complete: "Complete",
};

export function goalStatusLabel(status: GoalStatus): string {
  return STATUS_LABELS[status];
}

const STATUS_BADGE_CLASSES: Record<GoalStatus, string> = {
  active: "bg-success/10 text-success border-success/40",
  paused: "bg-pending/20 text-pending border-pending/40",
  budget_limited: "bg-warning-overlay text-warning border-warning/40",
  complete: "bg-success/10 text-success border-success/40",
};

interface GoalStatusBadgeProps {
  status: GoalStatus;
  className?: string;
}

export const GoalStatusBadge: React.FC<GoalStatusBadgeProps> = ({ status, className }) => (
  <span
    className={cn(
      "inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium leading-none uppercase tracking-wide",
      STATUS_BADGE_CLASSES[status],
      className
    )}
  >
    <Target aria-hidden="true" className="h-2.5 w-2.5" />
    {goalStatusLabel(status)}
  </span>
);

interface GoalToolStatProps {
  label: string;
  value: React.ReactNode;
}

export const GoalToolStat: React.FC<GoalToolStatProps> = ({ label, value }) => (
  <div className="flex items-baseline gap-1.5">
    <dt className="text-secondary text-[10px] tracking-wide uppercase">{label}</dt>
    <dd className="text-foreground">{value}</dd>
  </div>
);

export function extractGoalFromResult(result: unknown): GoalRecordV1 | null {
  if (!result || typeof result !== "object" || !("goal" in result)) {
    return null;
  }

  const parsed = GoalRecordV1Schema.safeParse(result.goal);
  return parsed.success ? parsed.data : null;
}
