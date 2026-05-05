import { IdleDispatcher } from "./idleDispatcher";
import type { WorkspaceGoalService } from "./workspaceGoalService";

/**
 * Shared test helpers for dispatch / event-loop coordination across the
 * goal-service, idle-dispatcher, and workspace-service test files.
 *
 * Coder-agents-review P3 DEREM-41: prior to extraction, an identical
 * `drainPendingDispatches()` definition lived in three test files
 * (`workspaceGoalService.test.ts`, `idleDispatcher.test.ts`,
 * `workspaceService.test.ts`). Centralising it here keeps the helper in one
 * place so a future fourth caller does not introduce a fourth copy.
 *
 * NOT exported as `index.ts` to keep import paths explicit.
 */

/**
 * Drain pending microtasks/timer callbacks. Used as a deterministic-ish
 * barrier when asserting "nothing else happens" — we cannot prove the absence
 * of an event without giving any racing dispatchers a chance to fire. Encoded
 * as a named helper instead of inline `setTimeout` so the intent is explicit
 * (per AGENTS.md "Avoid timing-based coordination when deterministic signals
 * exist"; this is the case where one does not).
 */
export async function drainPendingDispatches(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

/**
 * Poll `condition` until it returns truthy, throwing if it never does within
 * `timeoutMs`. Used in dispatch tests where the production path emits work
 * via microtasks + timers and the test needs a deterministic "wait for X"
 * barrier without coupling to internal scheduler details.
 *
 * Coder-agents-review nit DEREM-48: previously duplicated byte-for-byte in
 * `workspaceGoalService.test.ts` and `idleDispatcher.test.ts`.
 */
export async function waitForCondition(
  condition: () => boolean,
  options?: { timeoutMs?: number; intervalMs?: number }
): Promise<void> {
  const timeoutMs = options?.timeoutMs ?? 1_000;
  const intervalMs = options?.intervalMs ?? 5;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`Timed out after ${timeoutMs}ms waiting for condition`);
}

/**
 * Flip the GOALS experiment ON for `WorkspaceGoalService` instances created
 * in tests. Many goal-service tests need the experiment-on path because the
 * pricing gate (DEREM-52) and other hot-path predicates short-circuit when
 * the bridge is missing. Registering a no-op continuation consumer with
 * `isGoalExperimentEnabled: () => true` is the canonical way to do that.
 *
 * Coder-agents-review nit DEREM-55: previously duplicated byte-for-byte in
 * `workspaceGoalService.test.ts` and `agentSession.budgetGate.test.ts`.
 */
export function enableGoalsExperimentForTest(
  service: WorkspaceGoalService,
  dispatcher: IdleDispatcher = new IdleDispatcher()
): () => void {
  return service.registerGoalContinuationConsumer(dispatcher, {
    isGoalExperimentEnabled: () => true,
    hasActiveDescendantTasks: () => false,
    getRuntimeState: () => ({ isRuntimeCompatible: true }),
    executeGoalContinuation: () => Promise.resolve(true),
  });
}
