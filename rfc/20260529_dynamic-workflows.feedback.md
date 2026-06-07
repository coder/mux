---
title: Feedback — Dynamic Workflows RFC
re: rfc/20260529_dynamic-workflows.md (PR #3431)
date: 2026-06-07
---

# Feedback: Dynamic Workflows RFC

## TL;DR

The v1 shape is right: a **bounded, single-player, deterministic agent-orchestration** engine — conductor-only, durable replay, lightweight run card. Nothing here argues for adding features to v1.

This feedback is about **preserving a few extension seams** so three later use-case classes can ride this engine without a rewrite: **human-in-the-loop approval**, **after-action reviews (AARs)**, and **incident investigation** ("investigate and resolve a production incident"). All three are *bounded* runs that terminate. A fourth seam keeps the engine **backend-agnostic** — able to drive non-mux agent runtimes, not only mux's own task system. None of this belongs in v1. The asks below are about *not narrowing an abstraction prematurely* — near-zero v1 build cost — plus writing down one boundary.

## What's right and should not change

- **Conductor-only; side-effects live in tasks.** Correct, and more capable than it looks: "publish the report," "file a ticket," "take a mitigation action" are all just tasks the workflow spawns with the right tools. Do not relax this for any use case below.
- **Deterministic replay + durable journal.** The right correctness model, and the crash-resilience is exactly what longer-running coordination needs. The asks below are about staying *inside* this model, not loosening it.
- **Structured task output + report-time validation** and the **adversarial-verification lane** are the most valuable parts and generalize well beyond deep research (verifiable artifacts; contributing-factor analysis that is refuted/qualified rather than asserted).
- JS v1, project-trust gating, scratch→promote, discoverable-like-skills: all good.

## The future use cases (all bounded)

1. **Human-in-the-loop approval** — a run that pauses for a human decision/sign-off, then continues.
2. **After-action review (AAR)** — agent reconstructs a timeline from logs/telemetry, drafts contributing factors, incorporates human input and sign-off, compiles action items, publishes the writeup. Retrospective.
3. **Incident investigation** — declared → investigate → mitigate → verify → resolved (AAR afterward). Bounded, but **event-reactive while open**: alerts fire, metrics cross thresholds, and a human posts an update ("rolled back service X") at unpredictable times *during* the run.

What unites all three: a run sometimes needs a **step whose result comes from outside the agent fan-out** — a human decision/input, or an external event. v1 only has agent-produced step results. Generalizing the *source* of a step result, without touching the journal/replay machinery, is the one seam that unlocks all three.

> Out of scope even for us: a *genuinely never-ending* run (e.g., a standing monitor that never resolves). That would break completion-assuming machinery (unbounded journal growth, blocked awaiters, ever-costlier replay) and is a different primitive. All three use cases above terminate, so this is not what we're asking for.

## Seams to preserve (low / zero v1 cost)

### 1. (Headline) Let a durable step be resolved by an external input — human *or* event — not only by an agent task

The replay model already short-circuits completed steps by stable ID + recorded result. A human approval/input and an external event (alert / metric / webhook) are *the same shape*: a durable replay-boundary step whose result is supplied from outside the agent fan-out and recorded in the journal exactly like an agent task's result. The run-status enum already lists **`waiting`**.

This is the unifying insight: **human input and external events are one mechanism, not two.** v1 only needs agent-produced results; the seam is to keep the step/journal abstraction general about *where a step's result comes from*, rather than assuming every replay-boundary primitive is an agent-task spawn.

Ask: model the durable step as "a boundary that resolves to a recorded result," with agent-task as the only v1 *source*, but no assumption baked in that it's the only possible source. This single seam unlocks approval, AAR, and incident investigation later, with no v1 feature work.

### 2. Keep run identity and the event bus addressable independent of the launching chat

The RFC already calls for background runs that "remain observable from the launching chat" and a run store that "should support future dashboard/list views." Both imply a run that can be inspected outside the immediate chat turn that started it.

Ask: ensure `WorkflowRunStore` run identity and `WorkflowEventBus` events are addressable on their own (a stable run id + a subscribable event stream), so the dashboard/background-observability surfaces the RFC already anticipates can attach without modifying the runtime. Just don't couple the event stream exclusively to one chat session. (Nothing new to build in v1 — only a coupling to avoid.)

### 3. Affirm the determinism boundary — and note that journaling external inputs is what keeps reactive-but-bounded runs inside it

Deterministic replay (rerun the script against the journal; short-circuit by step id + input hash) is the right v1 choice, and it does **not** conflict with event-reactivity — *as long as external inputs are recorded as journal entries* (seam 1). Then a crash-resume reproduces "alert fired at T1, human input at T2, agent concluded Y at T3" deterministically, even though those inputs arrived live.

Ask: state the boundary explicitly in the RFC — "the runtime assumes a run is a deterministic function of its inputs and **recorded** step results; reactive inputs are supported only when journaled; unbounded non-deterministic streams are out of scope." That makes reactive-but-bounded runs (incident investigation) a clean future on the same model, and unbounded reactive orchestration a deliberate non-goal rather than an accidental lock-in.

### 4. Keep the agent executor behind `agent(spec)` pluggable — don't assume mux's TaskService is the only backend

Just as mux abstracts *where code runs* behind a runtime backend (local, SSH, Docker, devcontainer, Coder), the workflow should abstract *what executes an agent step*. Today `agent(spec)` resolves to a mux sub-agent task. But the conductor doesn't need to know *who* ran the agent — it needs a spec to come back as a validated result.

The RFC is already most of the way there: it lists a **"TaskService adapter,"** and the structured-output report contract (`spec → { reportMarkdown, structuredOutput }`, validated at report time) *is* the executor-agnostic boundary. The async primitives (`backgroundAgent` → handle, `awaitAgents`) are also the right shape for an executor that runs elsewhere and is awaited/polled (return an external handle, resolve it later).

Ask: define the execution path as an `AgentExecutor` interface — roughly `(spec) → durable handle → validated result` — with the mux TaskService as the only v1 implementation. Don't thread `TaskService` directly through the conductor runtime.

Why it's worth it even if mux never adds another backend: it's a clean decoupling/testability win (a mockable executor) on its own merits. As a bonus, it leaves the door open for external agent runtimes to fulfill steps later — e.g., **Anthropic's Managed Agents** (a natural fit, since mux already integrates Anthropic models via `@ai-sdk/anthropic`) and other emerging agent orchestrators — making the workflow engine a backend-agnostic conductor rather than one welded to mux's own task system.

A backend may even bring its own *execution model* through this seam — e.g., the rubric-graded, iterate-until-satisfied loop in Anthropic's "Define Outcomes" — which mux would **inherit rather than build into v1**. (A conductor-side grade-and-retry, by contrast, is already expressible by composing existing primitives, as the deep-research adversarial-verification lane shows — so neither flavor needs a new v1 primitive.) Whether to *ship* any external executor is a separate product call; this is only about not foreclosing it.

## What this is explicitly NOT asking for

- No human-wait or event-source primitive in v1.
- No dashboard or cross-run observability surface in v1 (only: don't couple the event stream to a single chat).
- No never-ending / unbounded-reactive run kind — ever, on this model.
- No external/non-mux agent executor in v1 (only: an `AgentExecutor` interface with mux TaskService as the sole implementation).
- No relaxation of the conductor-only / side-effects-in-tasks boundary.

Net: keep the **step/journal** abstraction one notch more general about *where a step result comes from*, put agent execution behind an **`AgentExecutor`** interface, keep run identity/events addressable on their own, and write down the determinism boundary (seam 3). That's the whole ask — roughly free now, and it keeps human-in-the-loop approval, AARs, bounded incident investigation, and non-mux execution backends open as future work on the same engine.
