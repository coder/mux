/**
 * PROTOTYPE — throwaway V0 of the work-item reconciliation loop. Wipe me.
 *
 * Question this prototype answers: do the reconcile semantics we designed
 * (derived state from persistent workspaces, idempotency keys, archived-blocks /
 * deleted-re-arms) hold up against a live mux server?
 *
 * This file is the PURE core: no I/O, fully deterministic, shaped so it can be
 * ported into a durable-workflow JS skeleton (V1) unchanged. Everything impure
 * (source adapters, mux api actuator) lives in tick.ts.
 *
 * Decisions encoded here (from the design grilling):
 * - Dispatcher is a deterministic loop; judgment is invoked as a step, not the loop owner.
 * - Derived state: the predicate is a pure function of (work items) x (actual workspaces).
 *   No local ledger. Idempotency key = workspace title/branch (spike hack; V1 wants
 *   an explicit workItemKey metadata field).
 * - Re-arm rule: live-or-archived workspace with the key blocks redispatch;
 *   deleting the workspace re-arms the item.
 * - Archive is a reconciliation outcome: when the source says done, the dispatcher
 *   archives — agents never self-archive.
 * - Claims are human-visibility only (v1: log-only). Never read by this predicate.
 */

import assert from "node:assert";

export type Stage = "investigate" | "implement";

export interface WorkItem {
  /** Idempotency key, e.g. "issue-123-investigate". Doubles as branch + title. */
  key: string;
  stage: Stage;
  title: string;
  /** Initial prompt sent to the spawned workspace. */
  prompt: string;
  /** True when the source-of-record says this stage is complete. */
  done: boolean;
}

/** A mux workspace as observed via `workspace list` (live + archived). */
export interface Actual {
  workspaceId: string;
  key: string;
  archived: boolean;
}

export type PlannedAction =
  | { kind: "spawn"; item: WorkItem }
  | { kind: "archive"; workspaceId: string; key: string }
  | { kind: "blocked"; key: string; reason: string };

export interface ReconcileOptions {
  /** Spawn budget per tick — persistent peers bypass maxParallelAgentTasks. */
  maxSpawns: number;
}

export function reconcile(
  items: WorkItem[],
  actuals: Actual[],
  opts: ReconcileOptions
): PlannedAction[] {
  assert(opts.maxSpawns >= 0, "maxSpawns must be non-negative");
  // Defensive: duplicate keys mean the adapter or the world is corrupt — crash fast.
  const itemKeys = new Set(items.map((i) => i.key));
  assert(itemKeys.size === items.length, "duplicate work item keys from adapter");
  const actualByKey = new Map<string, Actual>();
  for (const a of actuals) {
    assert(!actualByKey.has(a.key), `multiple workspaces claim key "${a.key}" — resolve manually`);
    actualByKey.set(a.key, a);
  }

  const plan: PlannedAction[] = [];
  let spawnBudget = opts.maxSpawns;

  for (const item of items) {
    const actual = actualByKey.get(item.key);

    if (!item.done) {
      if (actual === undefined) {
        if (spawnBudget > 0) {
          spawnBudget--;
          plan.push({ kind: "spawn", item });
        } else {
          plan.push({ kind: "blocked", key: item.key, reason: "spawn budget exhausted this tick" });
        }
      } else if (actual.archived) {
        // Archived workspace blocks redispatch; deleting it re-arms the item.
        plan.push({
          kind: "blocked",
          key: item.key,
          reason: "archived workspace blocks (delete to re-arm)",
        });
      } else {
        plan.push({ kind: "blocked", key: item.key, reason: "live workspace in progress" });
      }
    } else if (actual !== undefined && !actual.archived) {
      // Source says done — clean up. Archive, never delete (delete is the human's re-arm lever).
      plan.push({ kind: "archive", workspaceId: actual.workspaceId, key: item.key });
    }
    // done + no live actual: nothing to do.
  }

  return plan;
}

/**
 * Shared source mapping: simplified issues -> work items.
 * Used by both the fixture adapter and the gh adapter so fixture tests exercise
 * the exact mapping the real source uses.
 */
export interface SourceIssue {
  number: number;
  title: string;
  labels: string[];
  state: "OPEN" | "CLOSED";
}

export function issuesToWorkItems(issues: SourceIssue[]): WorkItem[] {
  const items: WorkItem[] = [];
  for (const issue of issues) {
    const closed = issue.state === "CLOSED";
    const triaged = issue.labels.includes("triage:done");

    // Investigation stage: every issue gets one; done once triaged or closed.
    items.push({
      key: `issue-${issue.number}-investigate`,
      stage: "investigate",
      title: `Investigate #${issue.number}: ${issue.title}`,
      prompt:
        `Investigate issue #${issue.number} ("${issue.title}"). ` +
        `Produce a short triage report: likely cause, affected area, suggested next step.`,
      done: closed || triaged,
    });

    // Implementation stage: only exists while the label is present; done when closed.
    if (issue.labels.includes("ready-for-agent")) {
      items.push({
        key: `issue-${issue.number}-implement`,
        stage: "implement",
        title: `Implement #${issue.number}: ${issue.title}`,
        prompt:
          `Implement a fix for issue #${issue.number} ("${issue.title}"). ` +
          `Keep the change minimal and open no PR; a human reviews this workspace.`,
        done: closed,
      });
    }
  }
  return items;
}
