---
description: Design decisions + V0 prototype learnings for the workspace reconciliation-loop dispatcher (scheduled agent system)
---

# Reconcile-loop dispatcher (scheduled workspace orchestration)

## Settled design decisions (grilling session)

- Dispatcher = deterministic reconciliation loop (K8s-style); judgment is invoked
  as a bounded step (agent/MCP adapter), never the loop owner.
- Derived state is authoritative: predicate = f(work items × actual workspaces).
  No ledger. Idempotency key encodes source+stage, e.g. `issue-123-investigate`.
- Re-arm rule: live-or-archived workspace with key blocks redispatch; deleting
  the workspace re-arms. Archive is a reconciliation outcome (dispatcher archives
  when source says done; agents never self-archive).
- Claims (status write-back to source) are human-visibility only; never read by
  the predicate. Cross-machine dedup explicitly out of scope (single-dev model).
- Spawned unit = persistent workspace (NOT sub-agent task): tasks are
  report-or-die + unconditionally cleaned; review feedback needs a re-promptable home.
- Roadmap: V0 script spike → V1 built-in workflow actions (action.workspace.ensure/
  sendMessage/awaitIdle/getLatestAssistantMessage/archive) → V2 WorkflowSchedulerService
  (wall-clock, at-least-once, skip-if-running) → V3 agent teams (spawn_peer_workspace /
  send_to_workspace→turnId / await_reply; mailbox semantics; NOT TaskService-based).
- Heartbeat is NOT a scheduler: idle-recency gated, needs a completed turn to
  bootstrap, MAX_CONCURRENT_IDLE_DISPATCHES=1 starvation.
- `mux workflow run` CLI spins up its OWN isolated backend — cron must use
  `mux api` (lockfile discovery via MUX_ROOT) to reach the running server.

## V0 prototype (scripts/prototypes/reconcile-loop/)

All transitions validated against a dev-server sandbox: dry-run, budget-capped
spawn, catch-up spawn, idempotent no-op tick, archive-on-done,
archived-blocks-redispatch, delete-re-arms-respawn.

API-caller learnings for V1 actions:
- workspace.create requires project trust (`projects set-trust`) and an explicit
  `trunkBranch` (UI auto-detects; API callers must supply) → ensure action should detect.
- trpc-cli output is lossy transport: empty array prints nothing; non-empty array
  prints CONCATENATED pretty JSON objects (not a JSON array). Typed actions needed.
- sendMessage works fire-and-forget on fresh workspace with
  `{model, agentId: "exec", mode: "exec"}`; spawned peers happily spawn their own
  sub-agent tasks (composition works).
- Workspace title survives as idempotency key only because dispatcher sets it
  explicitly; pendingAutoTitle/rename would break it → V1 wants explicit
  workItemKey metadata field.
- `make dev-server` watcher rebuilds dist/cli/api.mjs with mangled esbuild banner
  quoting (`from'module'` loses quotes) → rebuild manually with proper quoting if
  `bun dist/cli/api.mjs` throws a syntax error.
