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

## V1 implemented (V0 prototype deleted after absorbing learnings)

Shipped on branch cli-workspace-ggt1:
- Workspace tags: `tags?: Record<string,string>` on WorkspaceConfigSchema +
  WorkspaceMetadataSchema, mapped at 4 sites in src/node/config.ts, persisted
  atomically in workspaceService.create (8th param) + `updateTags` (merge,
  null deletes; drops record when empty). ORPC: workspace.create input `tags`,
  new workspace.updateTags. NOT rendered in UI by design.
- Host actions: `workspace.list/ensure/sendMessage/awaitIdle/
  getLatestAssistantMessage/archive` in
  src/node/services/workflows/workspaceHostActions.ts. Mechanism: generated
  CJS stub sources (real metadata + throwing execute) merged into
  BUILT_IN_WORKFLOW_ACTION_SOURCES so registry/describe/replay-hash work
  unchanged; WorkflowActionRunner intercepts built-in-scope names present in
  its hostActions map and runs in-process. Map built once in coreServices,
  shared via aiService.setWorkflowHostActions/getWorkflowHostActions (router's
  buildWorkflowService consumes the getter).
- ensure is idempotent by tag WORK_ITEM_TAG_KEY="workItemKey" (archived
  blocks; reconcile = execute). sendMessage deliberately has NO reconcile.

Key gotchas learned in dogfooding:
- Workflow JS receives the full WorkflowActionResult: payload is `.output`
  (e.g. `action.workspace.ensure({...}).output.workspaceId`).
- Host action outputs must be strict JSON: `undefined` props fail
  JsonValueSchema; runner now JSON-round-trips host outputs to normalize.
- workflows.start requires dynamic-workflows experiment
  (`mux api experiments set-override --experiment-id dynamic-workflows --enabled`).
- Project workflows are read from the WORKSPACE worktree (committed state at
  fork time), not the project dir — sync/commit before creating the workspace.
- `make dev-server` esbuild watcher still rebuilds dist/cli/api.mjs with the
  mangled banner (`frommodule`); rebuild manually with proper quoting
  (pre-existing bug, worth a separate fix).

Deep-review hardening pass (commit b5e48f7d4) fixed 12 findings:
- ensure: KeyedMutex per work-item key (check-then-create not atomic);
  predicate reads config.getAllWorkspaceMetadata() (list() swallows errors →
  duplicate creates); deriveEnsureBranchName (lowercase [a-z0-9_-], 64 cap,
  sha256-8 suffix on truncation); trust gate before detectDefaultTrunkBranch.
- runHostAction composes run-abort + step-timeout into ONE AbortController
  signal → ctx.abortSignal; abort/timeout throw WorkflowActionExecutionError
  (never durable success); awaitIdle throws on abort; poll interval injectable
  via services.awaitIdlePollMs.
- CoreServicesOptions.ephemeralConfigRoot=true in mux run/mux workflow skips
  setWorkflowHostActions (temp config would orphan tagged worktrees).
- sendMessage agent default = persisted workspace agentId (plan/compact→exec).
- updateTags Errs when no entry matched; oRPC tag key schemas non-blank;
  host output limit = Buffer.byteLength utf8.

## V2 shipped (commit 2b8d4e229)

WorkflowSchedulerService (src/node/services/workflows/WorkflowSchedulerService.ts):
- Config: WorkspaceConfigSchema.workflowSchedule { enabled, workflowName,
  args?, intervalMs (1min–24h), lastRunStartedAt? } + metadata exposure;
  mapped at the same 4 config.ts sites as tags/heartbeat.
- ORPC workspace.setWorkflowSchedule (null clears; re-set drops
  lastRunStartedAt → immediately due). Gated assertDynamicWorkflowsEnabled.
- Scheduler owned by ServiceContainer (start/stop next to HeartbeatService);
  30s tick scans config; due = intervalMs elapsed since lastRunStartedAt;
  skip-if-running via in-memory Map<workspaceId, Promise>; lastRunStartedAt
  persisted BEFORE dispatch (failures retry next interval, no hot-loop).
- Dispatch goes through resolveWorkflowContext (now EXPORTED from
  src/node/orpc/router.ts) so scheduled runs share run store/trust/host
  actions with workflows.* routes; ServiceContainer uses toORPCContext().
- Dogfood gotchas: trpc-cli can't pass `--schedule null` (coerces to true);
  use raw ORPC HTTP `POST /orpc/workspace/setWorkflowSchedule` with
  `{"json":{...,"schedule":null}}`. Nested JSON works as flag:
  `--schedule '{"enabled":true,...}'`. Global workflows live at
  <MUX_ROOT>/workflows/<name>.js — good for sandbox dogfooding (no
  project-commit dance).

V3 next: agent teams (spawn_peer_workspace / send_to_workspace→turnId / await_reply).
