---
name: workflow-authoring
description: Author durable JavaScript workflows for repeatable multi-agent orchestration
---

# Workflow Authoring

Use this skill **before writing or editing a workflow definition**. Workflows are durable JavaScript conductors that coordinate sub-agent tasks, validate structured reports, and preserve run state for replay/resume.

## When to use a workflow

Prefer a workflow when the task is a repeatable orchestration pattern, especially when it needs several of these:

- Multiple phases with clear progress reporting (`phase`, `log`).
- Parallel sub-agent fan-out with stable roles or lanes.
- Structured output validation from sub-agents.
- Adversarial verification / cross-checking of candidate findings.
- Durable state so completed work is reused after resume/restart.
- A reusable slash-invokable process, like deep research or deep review.
- Durable patch application from workflow-owned sub-agent tasks.

Do **not** create a workflow for a small one-off edit or a single simple investigation. The conductor cannot run arbitrary host operations directly; delegate open-ended shell/filesystem/web investigation to sub-agents.

## Before authoring

1. Run `workflow_list` to see existing workflows.
2. If an existing workflow is close, run `workflow_read({ name, view: "source" })` and adapt the pattern.
3. For one-off drafts, write a scratch workflow:

   ```text
   .mux/workflows/.scratch/<name>.js
   ```

4. Use normal file tools (`file_read`, `file_edit_insert`, `file_edit_replace_string`) to author the JavaScript.
5. Run it by name with `workflow_run`; prefer foreground mode (omit `run_in_background` or set it to `false`) unless you have another workflow/task or independent work to run while it completes. If `workflow_run` returns `status: "running"` or `status: "backgrounded"`, await the returned `runId` before using the result.

Scratch workflows must include workflow metadata with a description and a default exported function:

```js
export const metadata = {
  description: "Short workflow description",
};

export default function workflow({ args, phase, log, agent, parallelAgents, applyPatch }) {
  phase("scope", { input: args.input });
  return { reportMarkdown: "Done" };
}
```

Top-level named export declarations (`export const|let|var|function|async function|class`) are
also allowed; `export {...}` lists are not. The export keywords are stripped lexically before
sandbox evaluation, so never start a line inside a template literal with `export ` — it would be
silently rewritten.

Reusable project workflows live in `.mux/workflows/<name>.js`; global workflows live in `~/.mux/workflows/<name>.js`. Project and scratch workflows require Project Trust.

## Running workflows

Default to foreground workflow runs. When a foreground `workflow_run` returns `status: "completed"`, the final result is available directly, avoiding an unnecessary `task_await` call just to discover completion. Set `run_in_background: true` only when another workflow/task or unrelated work can proceed in parallel. If any `workflow_run` returns `status: "running"` or `status: "backgrounded"`, await the returned `runId` with `task_await` before using the result.

## Interrupting and resuming runs

Runs are durable, so stopping one is non-destructive:

- `task_terminate` with a `wfr_...` run ID interrupts the run; the event journal is preserved.
- `workflow_resume` continues an `interrupted` (or crash-orphaned `running`/`backgrounded`) run from its last durable event — completed steps are replayed from the journal, never re-executed. Resuming a `completed` run just returns its existing result.
- For `failed` runs, `workflow_resume` with `mode: "retry_from_checkpoint"` re-executes work after the last checkpoint; it is rejected when unfinished patch steps make that unsafe — start a fresh `workflow_run` instead.
- After an app restart, rediscover resumable runs with `task_list` (statuses `interrupted`/`failed`).

## Available workflow globals

A workflow default export receives one object:

```js
export default function workflow({ args, phase, log, agent, parallelAgents, applyPatch }) {}
```

### `args`

The invocation payload from `workflow_run`. Plain-text slash args are passed as `{ input: "..." }`, so normalize `args.input` for commands like:

```text
/workflow my-workflow review PR #123
```

If the workflow declares `metadata.argsSchema`, Mux normalizes slash/CLI text against that schema before `args` reaches the workflow. Slash-friendly workflows that accept free-form prose should declare either an `input` string field or one `positional: true` string field:

```js
const s = mux.schema;

export const metadata = {
  description: "Review a topic",
  argsSchema: s.object({
    input: s.optional(s.string()),
    quick: s.optional(s.boolean({ default: false, aliases: ["--quick"] })),
  }),
};
```

Without an `input` or positional field, free-form text such as `/workflow my-workflow review PR #123` has nowhere to go and can fail validation as an unexpected positional argument. Recognized aliases are parsed out of `input` text; use structured JSON args (for example `{ "topic": "review --quick literally" }`) when you need to preserve flag-like text verbatim or target named fields directly.

### `phase(name, details?)`

Records a durable phase event shown in the run card.

```js
phase("adversarial-verification", { candidateCount: issues.length });
```

### `log(message, data?)`

Records lightweight progress/details.

```js
log("Selected lanes", { lanes });
```

Keep `phase` and `log` events information-distinct. Use `phase()` for major workflow transitions and include the key details needed to understand that transition. Use `log()` only for additional information that is not already captured by the surrounding phase, such as a decision, result, warning, or intermediate finding.

If a `log()` appears immediately before a `phase()` and both carry the same details object or equivalent data, delete the log or move any unique details into the phase.

Prefer this:

```js
phase("lane-review", { lanes });
```

Over this:

```js
log("Selected lanes", { lanes });
phase("lane-review", { lanes });
```

Only keep the log when it adds distinct context:

```js
log("Trimmed lanes to max fan-out", {
  originalCount: allLanes.length,
  selectedCount: lanes.length,
});
phase("lane-review", { lanes });
```

### `agent(spec)`

Runs one workflow-owned sub-agent and waits for its final report.

Required fields:

- `id`: stable step ID used for replay; never derive from unstable ordering unless the input ordering is stable.
- `prompt`: child task prompt.
- `outputSchema`: JSON Schema subset used to validate the required `structuredOutput` submitted through `agent_report`.

Optional fields:

- `title`: UI title; used as the spawned child workspace title and the run-card task row label, falling back to `id` when omitted. Prefer human numbering (e.g. 1-based "Verify claim 1") over raw 0-based step ids.
- `agentId`: sub-agent type/id; defaults to the workflow adapter default (usually `explore`).
- `isolation`: `"fork" | "none"` (default `"fork"`). Use `"none"` only for read-only context-gathering agents that must inspect the parent checkout's uncommitted/staged state; mutating/fixer agents should stay forked.
- `onRefusal`: `"fail" | "fallback"` (default `"fallback"`). With `"fail"`, the step opts out of user-configured model-fallback chains so a model refusal fails the step honestly instead of silently retrying on a different model — recommended for verifier steps whose verdicts must come from the intended model.

Returns:

```ts
{
  taskId: string,
  reportMarkdown: string,
  title?: string,
  structuredOutput?: unknown
}
```

Workflow agent steps fail before child task creation when `outputSchema` is missing or uses unsupported schema keywords. If you only need prose, use a schema such as `s.object({ summary: s.string() })` and have the child put the prose under a structured field.

`taskId` is a host-issued patch artifact handle for workflow-owned child tasks. Pass the whole agent result as `applyPatch({ source: result })` instead of inventing task IDs.

Agent steps can fail terminally instead of returning a report. In particular, a model can refuse to answer (`model_refusal`): the child task is interrupted immediately and `agent(...)` throws with a descriptive message (e.g. `The model refused to continue (finishReason: content-filter): ...`) rather than retrying the same refusing request in a loop. Wrap agent steps in `try/catch` when the workflow should continue past a failed step — for example by recording an "abstain" outcome for verifier quorums (a refusal is not a verdict):

```js
let verdict;
try {
  const result = agent({ id: "verify", prompt, agentId: "explore", outputSchema: verdictSchema });
  verdict = result.structuredOutput;
} catch (error) {
  if (String(error).includes("refused to continue")) {
    // Treat the verifier as abstaining instead of failing the whole run.
    verdict = { outcome: "abstain", reason: String(error) };
  } else {
    throw error;
  }
}
```

### `applyPatch(spec)`

Applies a workflow-owned child task's git patch artifact to the current parent workspace. The host always dry-runs first in a temporary worktree and only performs the real apply when the dry-run succeeds. The conductor never receives raw patch text and cannot apply arbitrary patches.

Required fields:

- `id`: stable replay ID for this mutation step.
- `source` (or `from`): an `agent(...)` result, a `parallelAgents(...)` item, or a workflow-owned `taskId` string.

Optional fields:

- `target`: currently only `"parent"`; this is where the existing task patch artifact is applied.
- `projectPath` / `project_path`: limit a multi-project patch artifact to one project.
- `threeWay` / `three_way`: defaults to `true` and maps to `git am --3way`.
- `force`: allow re-apply / dirty-tree behavior exactly like `task_apply_git_patch`.
- `onConflict`: currently only `"return"`.

Returns structured status instead of throwing on ordinary patch conflicts:

```ts
{
  success: boolean,
  status: "applied" | "conflict" | "failed",
  taskId: string,
  projectResults?: unknown,
  conflictPaths?: string[],
  failedPatchSubject?: string,
  error?: string,
  note?: string
}
```

On conflict, spawn a dedicated `exec` resolver: include the failing `taskId`, tell it to call `task_apply_git_patch` in its own workspace, resolve `git am` conflicts, commit the resolved result, and report; then call `applyPatch` on the resolver result.

```js
const implementation = agent({
  id: "implement-auth-fix",
  agentId: "exec",
  prompt: execBrief,
  outputSchema: {},
});

let applied = applyPatch({
  id: "apply-auth-fix",
  source: implementation,
  target: "parent",
  onConflict: "return",
});

if (applied.status === "conflict") {
  const resolver = agent({
    id: "resolve-auth-fix-conflict",
    agentId: "exec",
    prompt: buildResolverBrief(applied),
    outputSchema: {},
  });
  applied = applyPatch({ id: "apply-resolved-auth-fix", source: resolver });
}
```

### `parallelAgents(specs, options?)`

Runs multiple `agent` specs concurrently and returns results in input order. Use this for review lanes, source summarization, claim verification, or other independent slices.

Pass `options.maxParallel` (positive integer) to cap how many sub-agents run at once. Queued specs start as running ones finish (a sliding window), so one slow agent delays only its own slot. Prefer it over manually slicing specs into sequential `parallelAgents` batches, which stall on each batch's slowest agent.

```js
const laneResults = parallelAgents(
  lanes.map((lane) => ({
    id: `review-${lane}`,
    title: `Review ${lane}`,
    prompt: lanePrompt(lane),
    outputSchema: issueListSchema(),
  }))
);

const verifications = parallelAgents(verifySpecs, { maxParallel: 10 });
```

## Structured output schemas

`outputSchema` supports this JSON Schema subset:

- `type` (including type arrays such as `["string", "null"]`)
- `properties`
- `required`
- `items`
- `additionalProperties`
- `enum`

Prefer `mux.schema` helpers over handwritten schema objects. For concise schemas, declare `const s = mux.schema;` at top level and use `s.*` in metadata/schema builders. Object fields are required by default; wrap optional fields with `s.optional(...)`, nullable values with `s.nullable(...)`, and use `additionalProperties: false` for deterministic outputs.

```js
const s = mux.schema;

function issueListSchema() {
  return s.object(
    {
      issues: s.array(
        s.object(
          {
            title: s.string(),
            severity: s.enum(["P0", "P1", "P2", "P3", "P4"]),
            filePaths: s.array(s.string()),
            evidence: s.string(),
            note: s.optional(s.nullable(s.string())),
          },
          { additionalProperties: false }
        )
      ),
    },
    { additionalProperties: false }
  );
}
```

## Replay rules and gotchas

- Every `agent` / `parallelAgents` item and every `applyPatch` call must have a stable `id`.
- The replay key includes the step ID and normalized spec, so changing prompts, schemas, patch source IDs, or apply options creates new work.
- `applyPatch` is a durable mutation effect: completed apply/conflict/failed results are replayed from the journal and are not re-applied on resume.
- The workflow conductor cannot call general tools, import modules, access Node, run shell, read files, use timers, or rely on `Date`/`Math.random`; put that work in delegated sub-agent prompts.
- Put open-ended shell/filesystem/web investigation inside delegated sub-agent prompts.
- Cap model-produced fan-out before calling `parallelAgents`.
- Return `{ reportMarkdown, structuredOutput }` so the parent agent and UI both get useful output.

## Minimal pattern

```js
export const metadata = {
  description: "Review a change with parallel lanes and verification",
};

export default function workflow({ args, phase, log, agent, parallelAgents }) {
  const target = normalizeTarget(args);

  phase("scope", { target });
  const scope = agent({
    id: "scope",
    title: "Scope work",
    prompt: "Identify review lanes for: " + target,
    outputSchema: {
      type: "object",
      required: ["lanes"],
      additionalProperties: false,
      properties: { lanes: { type: "array", items: { type: "string" } } },
    },
  });

  const lanes = scope.structuredOutput.lanes.slice(0, 6);
  log("Running lanes", { lanes });

  phase("lane-review", { lanes });
  const reviews = parallelAgents(
    lanes.map(function (lane) {
      return {
        id: "review-" + lane,
        title: "Review " + lane,
        prompt: "Review " + target + " for " + lane + " issues.",
        outputSchema: issueListSchema(),
      };
    })
  );

  phase("final-synthesis", { reviewCount: reviews.length });
  const final = agent({
    id: "synthesize",
    title: "Synthesize result",
    prompt: "Synthesize these structured review outputs: " + JSON.stringify(reviews),
    outputSchema: {},
  });

  return { reportMarkdown: final.reportMarkdown };
}

function normalizeTarget(args) {
  if (typeof args === "string" && args.trim()) return args.trim();
  if (args && typeof args === "object") {
    if (typeof args.target === "string" && args.target.trim()) return args.target.trim();
    if (typeof args.input === "string" && args.input.trim()) return args.input.trim();
  }
  return "current workspace";
}
```
