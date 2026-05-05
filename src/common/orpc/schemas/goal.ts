import { z } from "zod";

export const GoalStatusSchema = z.enum(["active", "paused", "budget_limited", "complete"]);

/**
 * Public-callable subset of `GoalStatus`. `budget_limited` is reserved for
 * internal transitions driven by `applyBudgetDrivenStatus` — accepting it
 * from the oRPC layer would let a caller transition a paused goal to
 * `budget_limited`, which the budget-driven re-arm logic would then flip
 * back to `active`, bypassing the normal resume validation
 * (Coder-agents-review nit DEREM-53).
 */
export const PublicGoalStatusSchema = z.enum(["active", "paused", "complete"]);

/**
 * Origin kind of the stream that drove the goal into `budget_limited`.
 * Persisted in the goal record so `recoverPendingDispatchAfterRestart` can
 * decide whether to arm the wrap-up: only continuation/budget-limit/other
 * origins should trigger a synthetic wrap-up; if a user-origin stream hit
 * the budget the wrap-up was correctly suppressed pre-restart and must
 * stay suppressed (Coder-agents-review P3 DEREM-54).
 *
 * `null` means the field has not been set (legacy goal records, goals that
 * are not currently `budget_limited`).
 */
export const GoalBudgetLimitOriginKindSchema = z
  .enum(["goal_continuation", "goal_budget_limit", "user", "other"])
  .nullable();

export const GoalRecordV1Schema = z.object({
  version: z.literal(1),
  goalId: z.string().uuid(),
  objective: z.string().min(1),
  status: GoalStatusSchema,
  budgetCents: z.number().int().nonnegative().nullable(),
  turnCap: z.number().int().positive().nullable(),
  costCents: z.number().int().nonnegative(),
  // Total cost in millionths of a cent. Public snapshots still expose whole
  // cents, but persisted goal accounting must not discard sub-cent turns.
  costMicroCents: z.number().int().nonnegative().optional(),
  turnsUsed: z.number().int().nonnegative(),
  attributedChildren: z.array(z.string()),
  budgetLimitInjectedForGoalId: z.string().uuid().nullable(),
  // Origin of the stream that put the goal into `budget_limited`. Optional
  // so legacy persisted goal records keep loading without migration; new
  // writes set it explicitly. Only consulted by
  // `recoverPendingDispatchAfterRestart`.
  budgetLimitOriginKind: GoalBudgetLimitOriginKindSchema.optional(),
  requireUserAcknowledgmentSinceMs: z.number().int().nonnegative().nullable(),
  lastContinuationFiredAtMs: z.number().int().nonnegative().nullable().optional(),
  completionSummary: z.string().optional(),
  createdAtMs: z.number().int().nonnegative(),
  updatedAtMs: z.number().int().nonnegative(),
});

export const GoalSnapshotSchema = z.object({
  goalId: z.string().uuid(),
  status: GoalStatusSchema,
  objective: z.string().min(1),
  budgetCents: z.number().int().nonnegative().nullable(),
  costCents: z.number().int().nonnegative(),
  turnsUsed: z.number().int().nonnegative(),
  turnCap: z.number().int().positive().nullable(),
  completionSummary: z.string().optional(),
  startedAtMs: z.number().int().nonnegative(),
});

// Discriminated union so the oRPC handler can return typed errors for the
// invalid-transition / child-workspace branches that `setGoal` previously
// allowed to escape as unhandled 500s (Coder-agents-review P3 DEREM-36).
//
// `goal_conflict` carries the expected and actual goal ids. `expectedGoalId:
// null` means the caller explicitly expected no goal; `undefined` on input
// means no optimistic-concurrency check.
// The no-goal + status-set + no-objective path is now classified as
// `invalid_transition` (DEREM-35 / DEREM-43).
export const GoalSetErrorSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("goal_conflict"),
    expectedGoalId: z.string().uuid().nullable(),
    actualGoalId: z.string().uuid().nullable(),
  }),
  z.object({
    type: z.literal("child_workspace"),
    message: z.string(),
  }),
  z.object({
    type: z.literal("invalid_transition"),
    message: z.string(),
  }),
]);

export const GoalSetInputSchema = z.object({
  workspaceId: z.string().min(1),
  objective: z.string().nullish(),
  status: PublicGoalStatusSchema.nullish(),
  budgetCents: z.number().int().nonnegative().nullable().optional(),
  turnCap: z.number().int().positive().nullable().optional(),
  completionSummary: z.string().nullish(),
  expectedGoalId: z.string().uuid().nullish(),
  // NOTE: Internal-only fields like `requireUserAcknowledgmentSinceMs`
  // (crash-recovery acknowledgment gate), `initiator`, and other workflow
  // signals MUST NOT be exposed in the public oRPC schema (Coder-agents-
  // review P3 DEREM-22). A client that could pass
  // `requireUserAcknowledgmentSinceMs: null` would otherwise be able to
  // clear the gate without user interaction, bypassing both the
  // acknowledgment requirement and the auto-pause that `acknowledgeUser`
  // applies. Internal callers use `WorkspaceGoalService.SetGoalInput`
  // directly, which still carries these fields.
});

export const GoalGetInputSchema = z.object({ workspaceId: z.string().min(1) });
export const GoalClearInputSchema = z.object({ workspaceId: z.string().min(1) });
