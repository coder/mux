import React from "react";
import { CircleCheck } from "lucide-react";
import {
  ToolContainer,
  ToolHeader,
  ExpandIcon,
  StatusIndicator,
  ToolDetails,
  ErrorBox,
} from "./Shared/ToolPrimitives";
import {
  useToolExpansion,
  getStatusDisplay,
  isToolErrorResult,
  type ToolStatus,
} from "./Shared/toolUtils";
import {
  GoalToolStat,
  extractGoalFromResult,
  formatGoalBudgetSummary,
  formatGoalElapsed,
  formatGoalTurns,
  goalStatusLabel,
} from "./Goal/goalToolUtils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/browser/components/Tooltip/Tooltip";

interface CompleteGoalToolCallProps {
  args: { summary: string };
  result?: unknown;
  status?: ToolStatus;
}

export const CompleteGoalToolCall: React.FC<CompleteGoalToolCallProps> = ({
  args,
  result,
  status = "pending",
}) => {
  const { expanded, toggleExpanded } = useToolExpansion();
  const errorResult = isToolErrorResult(result) ? result : null;
  const goal = extractGoalFromResult(result);
  const summary = (goal?.completionSummary ?? args.summary).trim();
  const succeeded = status === "completed" && !errorResult;
  const iconClassName = succeeded
    ? "text-success inline-flex shrink-0 items-center [&_svg]:size-3.5"
    : "text-secondary inline-flex shrink-0 items-center [&_svg]:size-3.5";

  return (
    <ToolContainer
      expanded={expanded}
      className={succeeded ? "border-success/40 bg-success/5 @container border-l-2" : "@container"}
    >
      <ToolHeader onClick={toggleExpanded}>
        <ExpandIcon expanded={expanded}>▶</ExpandIcon>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className={iconClassName}>
              <CircleCheck aria-hidden="true" />
            </span>
          </TooltipTrigger>
          <TooltipContent>complete_goal</TooltipContent>
        </Tooltip>
        <span className="font-medium whitespace-nowrap">Goal complete</span>
        {summary && <span className="text-foreground min-w-0 truncate italic">“{summary}”</span>}
        <StatusIndicator status={status}>{getStatusDisplay(status)}</StatusIndicator>
      </ToolHeader>

      {expanded && (
        <ToolDetails>
          {errorResult && <ErrorBox>{errorResult.error}</ErrorBox>}

          {summary && (
            <div className="mb-2">
              <div className="text-secondary text-[10px] tracking-wide uppercase">
                Completion summary
              </div>
              <div className="text-foreground text-[11px] leading-relaxed">{summary}</div>
            </div>
          )}

          {goal && (
            <div className="bg-code-bg space-y-2 rounded px-3 py-2 text-[11px] leading-relaxed">
              <div>
                <div className="text-secondary text-[10px] tracking-wide uppercase">Objective</div>
                <div className="text-foreground">{goal.objective}</div>
              </div>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1">
                <GoalToolStat label="Final status" value={goalStatusLabel(goal.status)} />
                <GoalToolStat
                  label="Cost"
                  value={
                    <span className="counter-nums">
                      {formatGoalBudgetSummary(goal.costCents, goal.budgetCents)}
                    </span>
                  }
                />
                <GoalToolStat
                  label="Turns"
                  value={
                    <span className="counter-nums">
                      {formatGoalTurns(goal.turnsUsed, goal.turnCap)}
                    </span>
                  }
                />
                <GoalToolStat
                  label="Elapsed"
                  value={
                    <span className="counter-nums">{formatGoalElapsed(goal.createdAtMs)}</span>
                  }
                />
              </dl>
            </div>
          )}
        </ToolDetails>
      )}
    </ToolContainer>
  );
};
