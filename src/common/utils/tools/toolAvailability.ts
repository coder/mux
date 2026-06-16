import type { GoalStatus } from "@/common/types/goal";
import type { AgentId } from "@/common/types/agentDefinition";
import {
  isExecLikeEditingCapableInResolvedChain,
  type ToolsConfigCarrier,
} from "@/common/utils/agentTools";

export interface ToolAvailabilityContext {
  workspaceId: string;
  parentWorkspaceId?: string | null;
}

export interface GoalToolAvailability {
  setGoal: boolean;
  getGoal: boolean;
  completeGoal: boolean;
}

export interface GoalToolAvailabilityContext {
  goalStatus: GoalStatus | null;
  parentWorkspaceId?: string | null;
  allowAgentSetGoal?: boolean;
  agentInheritanceChain: ReadonlyArray<ToolsConfigCarrier & { id: AgentId }>;
}

const GOAL_TOOL_ACTIVE_STATUSES: ReadonlySet<GoalStatus> = new Set(["active", "budget_limited"]);
const GOAL_TOOL_REPLACEABLE_STATUSES: ReadonlySet<GoalStatus> = new Set([
  "active",
  "budget_limited",
  "paused",
  "complete",
]);

export function getGoalToolAvailability(
  context: GoalToolAvailabilityContext
): GoalToolAvailability {
  const isEditingCapable = isExecLikeEditingCapableInResolvedChain(context.agentInheritanceChain);
  const setGoal =
    context.allowAgentSetGoal === true && context.parentWorkspaceId == null && isEditingCapable;
  const hasActiveGoal =
    context.goalStatus != null && GOAL_TOOL_ACTIVE_STATUSES.has(context.goalStatus);
  const hasGoalReadableForReplacement =
    setGoal && context.goalStatus != null && GOAL_TOOL_REPLACEABLE_STATUSES.has(context.goalStatus);

  return {
    setGoal,
    getGoal: hasActiveGoal || hasGoalReadableForReplacement,
    completeGoal: hasActiveGoal && isEditingCapable,
  };
}

/**
 * Derive canonical tool-availability options from workspace context.
 * Single source of truth for which capability flags to pass to getAvailableTools().
 */
export function getToolAvailabilityOptions(context: ToolAvailabilityContext) {
  return {
    enableAgentReport: Boolean(context.parentWorkspaceId),
    // The Review pane is a user-facing parent-workspace concept. Sub-agents
    // (child task workspaces, identified by a parentWorkspaceId) shouldn't pin
    // code to it, so withhold the review_pane_* tools from them.
    enableReviewPane: !context.parentWorkspaceId,
    // skills_catalog_* tools are always available; agent tool policy controls access.
  } as const;
}
