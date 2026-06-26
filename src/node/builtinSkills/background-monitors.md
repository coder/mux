---
name: background-monitors
description: Run bounded background monitors that wake the agent only when a condition changes or the monitor finishes
---

# Background monitors

Use this skill when you need a long-running watcher for CI, mergeability, PR review, deployments, queue state, logs, or any condition where the agent can safely end its turn and be woken when the watcher finishes.

## What wakes the parent

Mux wakes the owning workspace when a background **task** or **workflow** reaches a terminal state (`completed`, `failed`, `interrupted`, or `error`). Use one of these forms for monitors:

- `task({ run_in_background: true, ... })` for an ad-hoc monitor implemented by a sub-agent.
- `workflow_run({ run_in_background: true, ... })` for durable/reusable monitors.

Raw `bash({ run_in_background: true })` is different: it keeps a process running and you can retrieve output with `task_await`, but it does **not** by itself send an automatic terminal wake-up to the parent. If you need wake-on-finish or wake-on-condition, wrap the shell polling inside a background task or workflow and have that task/workflow finish when the condition is reached.

## Monitor contract

Every monitor must be bounded and idempotent. Before launching one, define:

- **Condition:** exact event that should complete the monitor (for example, all required CI checks passed, mergeability changed, Codex left a review, deployment became healthy).
- **Actual-state read:** exact command/API used to check state (`gh pr view`, `gh run list`, project CLI, HTTP endpoint, log command).
- **Cadence:** sleep interval between checks; use one blocking loop in the monitor, not repeated parent turns.
- **Bound:** max attempts or wall-clock deadline, and what terminal report says on timeout.
- **Idempotency key:** PR number, deployment id, run id, or another stable identifier so duplicate monitors are recognizable in the report/title.
- **Output policy:** report only state transitions, convergence, or blockers; do not stream noisy logs into the parent.

## Preferred patterns

### Ad-hoc task monitor

Use a background `exec` task when the watch is specific to the current conversation:

```ts
task({
  agentId: "exec",
  title: "Monitor PR #123 CI",
  run_in_background: true,
  prompt: `
Task: Monitor PR #123 CI until it converges.

Loop guards:
- Desired state: all required checks pass, or a required check fails terminally.
- Actual-state read: gh pr checks 123 --watch=false --json name,state,conclusion,link.
- Cadence: sleep 60 seconds between checks.
- Bound: stop after 60 minutes or 60 attempts.
- Idempotency key: pr-123-ci.

Instructions:
1. Poll with a bounded shell loop.
2. Do not edit files or push commits.
3. When checks pass, call agent_report with a concise success summary and notable links.
4. If a required check fails, call agent_report with the failing check names and links.
5. If the bound expires, call agent_report with the last observed state and the next human decision needed.
`,
})
```

The parent may end its turn after the `task` tool returns. Mux will wake the parent when the monitor task calls `agent_report` or settles terminally.

### Parallel PR monitors

For PR readiness, run independent monitors in parallel when their state reads are independent:

- CI/checks monitor: required checks pass or fail.
- Mergeability monitor: merge state becomes clean/blocked/dirty.
- Review monitor: Codex/coder-agents review arrives, approves, or requests changes.
- Deployment monitor: preview/deployment health converges.

Each monitor should have a distinct title and idempotency key. Do not make the parent poll all monitors manually; let each monitor finish and wake the parent with a focused report.

### Durable workflow monitor

Use a workflow when monitoring must be reusable, resumable, or composed with other phases. A workflow can run in the background and own multiple bounded monitor steps. Workflow-owned child agents report through the workflow journal; the parent wakes when the workflow reaches a terminal result.

## Heartbeat fallback

Heartbeat is still useful as a coarse fallback reminder, but it should not replace a condition-driven monitor:

- Use the monitor to wake promptly when the condition changes.
- Use heartbeat only for periodic reconciliation if a monitor is interrupted, times out, or misses an external event.

## Avoid these traps

- Do not create unbounded `while true` monitors. Every monitor needs a deadline.
- Do not launch a raw background bash process and assume the parent will be woken automatically.
- Do not have multiple monitors watch the same idempotency key unless you intentionally want duplicate reports.
- Do not report every polling iteration. Report convergence, state transitions, failures, or timeout.
- Do not use monitors to hide work that the current answer depends on; use foreground/default mode or `task_await` when the next decision requires the result.
