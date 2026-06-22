---
name: workflow-authoring
description: Author durable JavaScript workflows for repeatable multi-agent orchestration
---

# Workflow Authoring

Use this skill **before writing or editing a workflow script**. Workflows are durable JavaScript conductors that coordinate sub-agent tasks, validate structured reports, and preserve run state for replay/resume.

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

1. Use skills to discover packaged workflows. Read a workflow skill with `agent_skill_read({ name: "<skill>" })`, then inspect its script with `agent_skill_read_file({ name: "<skill>", filePath: "workflow.js" })` when needed.
2. For local one-off workflow drafts, write an explicit workspace-contained JavaScript file, for example `./workflows/<name>.js`.
3. Use normal file tools (`file_read`, `file_edit_insert`, `file_edit_replace_string`) to author the JavaScript.
4. Run it by explicit path with `workflow_run({ script_path: "./workflows/<name>.js", args: {} })`; prefer foreground mode (omit `run_in_background` or set it to `false`) unless you have another workflow/task or independent work to run while it completes. If `workflow_run` returns `status: "running"` or `status: "backgrounded"`, await the returned `runId` before using the result.

Workflow scripts should include `meta` with a description and a default exported function:

```js
export const meta = {
  description: "Short workflow description",
};

export default function workflow({
  args,
  phase,
  log,
  agent,
  parallel,
  pipeline,
  workflow,
  applyPatch,
}) {
  phase("scope", { input: args.input });
  return { reportMarkdown: "Done" };
}
```

Top-level named export declarations (`export const|let|var|function|async function|class`) are
also allowed; `export {...}` lists are not. The export keywords are stripped lexically before
sandbox evaluation, so never start a line inside a template literal with `export ` — it would be
silently rewritten.

Packaged reusable workflows should live inside skill directories and be invoked with `skill://<skill-name>/<file.js>`. Explicit workspace workflow files require Project Trust.

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
export default function workflow({
  args,
  phase,
  log,
  agent,
  parallel,
  pipeline,
  workflow,
  applyPatch,
}) {}
```

### `args`

The invocation payload from `workflow_run`. Plain-text slash args are passed as `{ input: "..." }`, so normalize `args.input` for commands like:

```text
/workflow ./workflows/my-workflow.js review PR #123
```

If the workflow declares `meta.argsSchema`, Mux normalizes slash/CLI text against that schema before `args` reaches the workflow. Slash-friendly workflows that accept free-form prose should declare either an `input` string field or one `positional: true` string field:

```js
const s = mux.schema;

export const meta = {
  description: "Review a topic",
  argsSchema: s.object({
    input: s.optional(s.string()),
    quick: s.optional(s.boolean({ default: false, aliases: ["--quick"] })),
  }),
};
```

Without an `input` or positional field, free-form text such as `/workflow ./workflows/my-workflow.js review PR #123` has nowhere to go and can fail validation as an unexpected positional argument. Recognized aliases are parsed out of `input` text; use structured JSON args (for example `{ "topic": "review --quick literally" }`) when you need to preserve flag-like text verbatim or target named fields directly.

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

### `agent(prompt, options)`

Runs one workflow-owned sub-agent and waits for its final report.

Required options:

- `id`: stable step ID used for replay; never derive from unstable ordering unless the input ordering is stable.
- `schema`: optional JSON object schema. When present, the child reports schema-shaped data through `agent_report` and `agent()` returns that structured object directly. When omitted, `agent()` returns the child report markdown string.

Optional fields include `title`, `agentType`, `isolation`, and `onRefusal`. `model` and `effort` are rejected for now instead of being silently ignored.

```js
const scope = agent("Scope this topic", {
  id: "scope",
  schema: {
    type: "object",
    required: ["lanes"],
    properties: { lanes: { type: "array", items: { type: "string" } } },
  },
});

const summaryMarkdown = agent("Write a concise markdown summary", { id: "summary" });
```

### `parallel(thunks, options?)`

Runs independent workflow agent branches concurrently and returns results in input order. Each thunk should call `agent(...)` once. `options.maxParallel` may cap live child tasks.

```js
const reviews = parallel(
  lanes.map(
    (lane) => () =>
      agent(`Review ${lane}`, {
        id: `review-${lane}`,
        schema: issueListSchema(),
      })
  ),
  { maxParallel: 6 }
);
```

### `pipeline(items, ...stages)`

Runs items through stage functions without a full-stage barrier. An item can advance to the next stage as soon as its current stage finishes, even while other items are still in earlier stages. Each stage may return a value or call `agent(...)` once.

```js
const results = pipeline(
  lanes,
  (lane) => agent(`Review ${lane}`, { id: `review-${lane}`, schema: reviewSchema }),
  (review) =>
    agent(`Verify ${JSON.stringify(review)}`, { id: `verify-${review.id}`, schema: verifySchema })
);
```

### `workflow(scriptPath, options)`

Runs a nested durable workflow by explicit script path. `options.id` is required and participates in replay identity together with `scriptPath` and `options.args`; completed child runs are replayed from their source snapshot instead of re-resolving the file.

```js
const child = workflow("skill://workflow-smoke/workflow.js", {
  id: "child-research",
  args: { message: "from parent" },
});
```

The object form is also accepted when that is clearer for generated specs:

```js
const child = workflow({
  id: "child-research",
  script_path: "skill://workflow-smoke/workflow.js",
  args: { message: "from parent" },
});
```

### `applyPatch({ id, agentId, ... })`

Applies the patch artifact produced by a completed workflow-owned agent step into the parent workspace. Prefer `agentId`, matching a prior `agent(..., { id })`; only use raw task IDs when integrating legacy steps. Patch application requires Project Trust and runs a dry-run before applying.

```js
const summary = agent("Implement the requested change", { id: "implement" });
const patch = applyPatch({ id: "apply-implement", agentId: "implement" });
if (!patch.success)
  return { reportMarkdown: `Patch did not apply: ${patch.error ?? patch.status}` };
return { reportMarkdown: summary };
```

## Structured output schemas

`schema` supports this JSON Schema subset:

- `type` (including type arrays such as `["string", "null"]`)
- `properties`
- `required`
- `items`
- `additionalProperties`
- `enum` and `const`
- `oneOf`, `anyOf`, and `allOf`
- `minItems`, `maxItems`, `minLength`, `maxLength`, `minimum`, `maximum`, and `pattern`
- annotations such as `description`

Workflow agent schemas must be top-level object schemas. Wrap scalar or array results in an object field, for example `{ type: "object", properties: { value: { type: "string" } } }`. `$ref` and remote schemas are not supported.

Prefer `mux.schema` helpers over handwritten schema objects. For concise schemas, declare `const s = mux.schema;` at top level and use `s.*` in meta/schema builders. Object fields are required by default; wrap optional fields with `s.optional(...)`, nullable values with `s.nullable(...)`, and use `additionalProperties: false` for deterministic outputs.

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

- Every `agent(...)`, nested `workflow(...)`, and `applyPatch(...)` call must have a stable `id`; every `parallel(...)` thunk should call one `agent(...)` with a stable `id`.
- The replay key includes the step ID and normalized spec, so changing prompts, schemas, script paths, args, or patch options creates new work.
- The workflow conductor cannot call general tools, import modules, access Node, run shell, read files, use timers, or rely on `Date`/`Math.random`; put that work in delegated sub-agent prompts.
- Put open-ended shell/filesystem/web investigation inside delegated sub-agent prompts.
- Cap model-produced fan-out before calling `parallel(...)`.
- Return `{ reportMarkdown, structuredOutput }` so the parent agent and UI both get useful output.

## Minimal pattern

```js
export const meta = {
  name: "Deep Review",
  description: "Review a change with parallel lanes and verification",
};

export default function workflow({ args, phase, log, agent, parallel }) {
  const target = normalizeTarget(args);

  phase("scope", { target });
  const scope = agent("Identify review lanes for: " + target, {
    id: "scope",
    title: "Scope work",
    schema: {
      type: "object",
      required: ["lanes"],
      additionalProperties: false,
      properties: { lanes: { type: "array", items: { type: "string" } } },
    },
  });

  const lanes = scope.lanes.slice(0, 6);
  log("Running lanes", { lanes });

  phase("lane-review", { lanes });
  const reviews = parallel(
    lanes.map(
      (lane) => () =>
        agent("Review " + target + " for " + lane + " issues.", {
          id: "review-" + lane,
          title: "Review " + lane,
          schema: issueListSchema(),
        })
    )
  );

  phase("final-synthesis", { reviewCount: reviews.length });
  const finalMarkdown = agent("Synthesize these review outputs: " + JSON.stringify(reviews), {
    id: "synthesize",
  });

  return { reportMarkdown: finalMarkdown };
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
