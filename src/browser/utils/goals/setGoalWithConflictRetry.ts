import type { APIClient } from "@/browser/contexts/API";

/**
 * Optimistic-concurrency retry pattern shared by every browser-side goal
 * mutation entry point (Coder-agents-review P3 DEREM-25).
 *
 * Pre-DEREM-25, three independent copies of this loop existed:
 *  - `RightSidebar.tsx`: threw on second failure
 *  - `chatCommands.ts`: returned a typed `Result`
 *  - `sources.ts`: returned the raw API response
 *
 * The behaviour was identical (read → setGoal with `expectedGoalId` → on
 * conflict, re-read → retry once → surface raw result), but the three
 * already diverged in error handling. This function returns the raw
 * `setGoal` API response so each caller can adapt it to their own contract
 * (throw / Result / void) without forking the loop.
 *
 * Behavior:
 *   1. `getGoal` to read the current persisted goalId (may be null).
 *   2. `setGoal` with `expectedGoalId = currentGoal.goalId`, or `null` when
 *      no goal exists (explicitly asserting empty state).
 *   3. On `success === true` → return immediately.
 *   4. On `goal_conflict` → re-fetch the
 *      goal once and retry the same mutation with the fresh
 *      `expectedGoalId`. The second attempt's raw result is returned
 *      regardless of outcome.
 *
 * Callers MUST decide what to do with a second failure — most surface a
 * "Goal changed in another window. Please try again." error; some bubble
 * the typed Result; some swallow it.
 */
export function setGoalWithConflictRetry(
  api: APIClient,
  workspaceId: string,
  // Use `Omit` to forbid `workspaceId`/`expectedGoalId` in the input — the
  // helper supplies both.
  input: Omit<Parameters<APIClient["workspace"]["setGoal"]>[0], "workspaceId" | "expectedGoalId">
): ReturnType<APIClient["workspace"]["setGoal"]> {
  return setGoalWithConflictRetryImpl(api, workspaceId, input);
}

async function setGoalWithConflictRetryImpl(
  api: APIClient,
  workspaceId: string,
  input: Omit<Parameters<APIClient["workspace"]["setGoal"]>[0], "workspaceId" | "expectedGoalId">
): Promise<Awaited<ReturnType<APIClient["workspace"]["setGoal"]>>> {
  const currentGoal = (await api.workspace.getGoal({ workspaceId })).goal;
  const firstResult = await api.workspace.setGoal({
    workspaceId,
    ...input,
    expectedGoalId: currentGoal?.goalId ?? null,
  });
  if (firstResult.success || firstResult.error.type !== "goal_conflict") {
    return firstResult;
  }

  const freshGoal = (await api.workspace.getGoal({ workspaceId })).goal;
  return api.workspace.setGoal({
    workspaceId,
    ...input,
    expectedGoalId: freshGoal?.goalId ?? null,
  });
}
