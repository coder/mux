---
name: orchestrate
description: Coordinate sub-agent implementation and apply patches (delegate-first orchestration playbook)
advertise: false
---

# Orchestrate

Use this skill when the user invokes `/orchestrate` (or asks you to coordinate, orchestrate, or delegate a multi-step implementation). It teaches the **delegate-first** playbook that the former Orchestrator agent used: spawn sub-agents to do the work, integrate their patches, verify, and report.

This is a workflow skill, not an agent: the skill cannot remove tools from the calling agent. The constraints below are rules of the workflow — follow them even though the underlying tools remain available.

## Mission

Coordinate implementation by delegating investigation + coding to sub-agents, then integrating their patches into this workspace.

## Hard rules (delegate-first)

- **Do not implement features/bugfixes directly in this workspace.** Spawn `exec` sub-agents and have them complete the work end-to-end. Even though your `file_edit_*` tools are available, treat them as off-limits for this workflow.
- **Do not do broad repo investigation here.** If you need context, spawn an `explore` sub-agent with a narrow prompt to preserve your context window for coordination.
- **Trust `explore` sub-agent reports as authoritative for repo facts** (paths/symbols/callsites). Do not redo the same investigation yourself; only re-check if a report is ambiguous or contradicts other evidence. For correctness claims, an `explore` report counts as having read the referenced files.
- **`bash` is for orchestration only:** `git` / `gh` repo coordination, targeted post-apply verification, and waiting on PR review/CI. Do not use `bash` for file reads/writes, manual code editing, or broad repo exploration. If a direct verification check fails due to a code issue, delegate the fix to `exec` instead of patching it yourself.
- **Never read or scan session storage** (`~/.mux/sessions/**`, `~/.mux/sessions/subagent-patches/**`). Treat session storage as internal. Access patches only through `task_apply_git_patch`.
- **Do not call `propose_plan`** from this workflow. If a complex subtask needs more shape before implementation, decompose it with one or more `explore` tasks and write a richer brief for `exec`, rather than spawning a `plan` sub-agent (plan is not runnable as a sub-agent).

## When a plan is present

If an accepted plan exists in this workspace:

- Treat it as the source of truth. Paths/symbols/structure were validated during planning — do not routinely spawn `explore` to re-confirm them. Exception: if the plan references stale paths, one targeted `explore` to sanity-check critical paths is acceptable.
- Spawning `explore` for _additional_ context beyond the plan (existing helpers, test locations, patterns to match) is encouraged — this produces better implementation task briefs.
- Do not spawn `explore` just to verify a planner-generated plan; that was the planner's job.
- Convert the plan into concrete implementation subtasks and start delegation.

## Delegation guide

- **`explore`** — narrowly-scoped read-only questions (confirm an assumption, locate a symbol/callsite, find relevant tests). Avoid "scan the repo" prompts. Use multiple `explore` tasks (potentially in parallel) to shape a richer brief for `exec` when a subtask is non-trivial.
- **`exec`** — implementation work, simple or complex. For straightforward subtasks (single-file edits, localized wiring), a short brief is enough. For higher-complexity subtasks that touch multiple files or have an unclear approach, invest in the brief: include the goal, constraints, acceptance criteria, and any `explore` findings up front.
- **`desktop`** — GUI-heavy desktop automation requiring repeated screenshot → act → verify loops.

Note: `plan` is intentionally not runnable as a sub-agent. Use top-level plan mode if you need a reviewed plan before orchestration begins.

## Task brief template (Orchestrate → Exec)

- Task: <one sentence>
- Background (why this matters):
  - <bullet>
- Scope / non-goals:
  - Scope: <what to change>
  - Non-goals: <explicitly out of scope>
- Starting points: <paths / symbols / callsites>
- Dependencies / assumptions:
  - Assumes: <prereq patch(es) already applied in parent workspace, or required files/targets already exist>
  - If unmet: stop and report back; do not expand scope to create prerequisites.
- Acceptance: <bullets / checks>
- Deliverables:
  - Commits: <what to commit>
  - Verification: <commands to run>
- Constraints:
  - Do not expand scope.
  - Prefer `explore` tasks for repo investigation (paths/symbols/tests/patterns) to preserve your context window for implementation. Trust Explore reports as authoritative; do not re-verify unless ambiguous/contradictory. If starting points + acceptance are already clear, skip initial explore and only explore when blocked.
  - Create one or more git commits before `agent_report`.

For higher-complexity `exec` briefs, prioritize goal + constraints + acceptance criteria over file-by-file diff instructions.

## Dependency analysis (required before spawning implementation tasks)

For each candidate subtask, write:

- **Outputs:** files/targets/artifacts introduced/renamed/generated.
- **Inputs / prerequisites** (including for verification): what must already exist.

A subtask is "independent" only if its patch can be applied + verified on the current parent workspace HEAD, without any other pending patch.

**Parallelism is the default.** Maximize the size of each independent batch and run it in parallel. Use the sequential protocol only when a subtask has a concrete prerequisite on another subtask's outputs.

If task B depends on outputs from task A:

- Do not spawn B until A has completed **and A's patch is applied** in the parent workspace.
- If the dependency chain is tight (download → generate → wire-up), prefer one `exec` task rather than splitting.

Example dependency chain (schema download → generation):

- Task A outputs: a new download target + new schema files.
- Task B inputs: those schema files; verifies by running generation.
- Therefore: run Task A (await + apply patch) before spawning Task B.

## Patch integration loop (default)

1. Identify a batch of independent subtasks.
2. Spawn one `exec` sub-agent task per subtask with `run_in_background: true`.
3. Await the batch via `task_await`.
4. For each successful implementation task, integrate patches **one at a time**:
   - Treat every successful child task with a `taskId` as pending patch integration, whether the completion arrived inline from `task` or later from `task_await`.
   - Complete each dry-run + real-apply pair before starting the next patch. Applying one patch changes `HEAD`, which can invalidate later dry-run results.
   - Dry-run apply: `task_apply_git_patch` with `dry_run: true`.
   - If dry-run succeeds, immediately apply for real: `task_apply_git_patch` with `dry_run: false`.
   - Do not assume an inline `status: completed` result means the child changes are already present in this workspace.
   - If dry-run fails, treat it as a patch conflict and delegate reconciliation:
     1. Do not attempt a real apply for that patch in this workspace.
     2. Spawn a dedicated `exec` task. In the brief, include the original failing `task_id` and instruct the sub-agent to replay that patch via `task_apply_git_patch`, resolve conflicts in its own workspace, run `git am --continue`, commit the resolved result, and report back with a new patch to apply cleanly.
   - If real apply fails unexpectedly:
     1. Restore a clean working tree before delegating: run `git am --abort` via `bash` only when a git-am session is in progress; if abort reports no operation in progress, continue.
     2. Then follow the same delegated reconciliation flow above.
5. Verify + review:
   - Run focused verification directly with `bash` when practical (targeted tests or the repo's standard full-validation command), or delegate verification to `explore`/`exec` when investigation/fixes are likely.
   - Use `git`/`gh` directly for PR orchestration when a PR already exists (pushes, review-request comments, replies to review remarks, and CI/check-status waiting loops). Create a new PR only when the user explicitly asks.
   - PASS: summary-only (no long logs).
   - FAIL: include the failing command + key error lines; then delegate a fix to `exec` and re-verify.

## Sequential protocol (only for dependency chains)

1. Spawn the prerequisite `exec` implementation task with `run_in_background: false`.
2. If step 1 returns `queued`/`running` without a completed report, call `task_await` with the returned `taskId` before attempting any patch apply. If step 1 returns `status: completed` inline, that same `taskId` still requires patch application.
3. Dry-run apply its patch (`dry_run: true`); then apply for real (`dry_run: false`). If either step fails, follow the conflict playbook above (including `git am --abort` only when a real apply leaves a git-am session in progress).
4. Only then spawn the dependent task.

## Prerequisites

- **Max Task Nesting Depth must be ≥ 1** (Settings → Agents → Task Settings). Without it, `task` calls will fail and orchestration cannot proceed; surface that as the blocker rather than reverting to direct edits.
