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
- Durable calls into user-defined host actions under `.mux/actions` or `~/.mux/actions`.

Do **not** create a workflow for a small one-off edit or a single simple investigation. The conductor cannot run arbitrary host operations directly; use `action.*` / `parallelActions` only for explicit, metadata-declared workflow actions, and delegate open-ended shell/filesystem/web investigation to sub-agents.

## Before authoring

1. Run `workflow_list` to see existing workflows.
2. If an existing workflow is close, run `workflow_read({ name })` and adapt the pattern.
3. Run `workflow_action_list` before writing `action.*` or `parallelActions` calls; use each action's metadata `inputSchema`, `outputSchema`, `effect`, and `permissions` to choose valid arguments.
4. For one-off drafts, write a scratch workflow:

   ```text
   .mux/workflows/.scratch/<name>.js
   ```

5. Use normal file tools (`file_read`, `file_edit_insert`, `file_edit_replace_string`) to author the JavaScript.
6. Run it by name with `workflow_run`; prefer foreground mode (omit `run_in_background` or set it to `false`) unless you have another workflow/task or independent work to run while it completes. If `workflow_run` returns `status: "running"` or `status: "backgrounded"`, await the returned `runId` before using the result.

Scratch workflows must include workflow metadata with a description and a default exported function:

```js
export const metadata = {
  description: "Short workflow description",
};

export default function workflow({
  args,
  phase,
  log,
  agent,
  action,
  parallelAgents,
  parallelActions,
  parallelWorkflows,
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
export default function workflow({
  args,
  phase,
  log,
  agent,
  action,
  parallelAgents,
  parallelActions,
  parallelWorkflows,
  applyPatch,
}) {}
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

### `agent(spec)`

Runs one workflow-owned sub-agent and waits for its final report.

Required fields:

- `id`: stable step ID used for replay; never derive from unstable ordering unless the input ordering is stable.
- `prompt`: child task prompt.

Optional fields:

- `title`: UI title; used as the spawned child workspace title and the run-card task row label, falling back to `id` when omitted. Prefer human numbering (e.g. 1-based "Verify claim 1") over raw 0-based step ids.
- `agentId`: sub-agent type/id; defaults to the workflow adapter default (usually `explore`).
- `outputSchema`: JSON Schema subset used to validate `structuredOutput`.
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

`taskId` is a host-issued patch artifact handle for workflow-owned child tasks. Pass the whole agent result as `applyPatch({ source: result })` instead of inventing task IDs.

Agent steps can fail terminally instead of returning a report. In particular, a model can refuse to answer (`model_refusal`): the child task is interrupted immediately and `agent(...)` throws with a descriptive message (e.g. `The model refused to continue (finishReason: content-filter): ...`) rather than retrying the same refusing request in a loop. Wrap agent steps in `try/catch` when the workflow should continue past a failed step — for example by recording an "abstain" outcome for verifier quorums (a refusal is not a verdict):

```js
let verdict;
try {
  const result = agent({ id: "verify", prompt, agentId: "explore" });
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

### `action.<namespace>.<name>(spec)`

Runs a built-in or user-defined workflow action. Mux ships read-only built-in Git actions under `action.git.*`; user actions are loaded from `.mux/actions/**/*.js` or `~/.mux/actions/**/*.js`. Nested folders become namespaces: `.mux/actions/graphite/stackSnapshot.js` is called as `action.graphite.stackSnapshot(...)`. User project/global actions take precedence over built-ins, so a project can override a built-in action name. Run `workflow_action_list` to discover available actions and their metadata before authoring calls. Actions currently run only for local workspaces; SSH/Docker workspaces are blocked until runtime-backed action execution exists.

Action calls are durable replay steps. Completed results are reused when the action source hash, statically-required relative dependencies, effective cwd, and input identity match. Incomplete read-only actions may retry; incomplete mutating actions (`effect: "workspace"` or `"external"`) do not blindly re-run unless the action exports a safe `reconcile` hook for the same replay identity.

Built-in Git actions:

- `action.git.status({ id, input: { includeIgnored? } })`: branch/upstream/ahead-behind plus staged, unstaged, untracked, and optionally ignored files.
- `action.git.commitsBetween({ id, input: { base?, trunk?, head?, limit? } })`: commits reachable from `head` (default `HEAD`) but not from the trunk/base branch. If `base`/`trunk` is omitted, the action tries `origin/HEAD`, then `main`, `master`, and `trunk`.
- `action.git.diff({ id, input: { base?, trunk?, head? } })`: `git diff` output for branch, staged, and unstaged changes, with truncation flags when action output limits are hit.
- `action.git.diffStat({ id, input: { base?, trunk?, head? } })`: `git diff --stat` output for branch, staged, and unstaged changes.
- `action.git.changedFiles({ id, input: { base?, trunk?, head? } })`: changed file lists for branch, staged, unstaged, and untracked state.

Required fields:

- `id`: stable replay ID.

Optional fields:

- `input`: JSON input validated against the action's `inputSchema` when declared.
- `timeoutMs`: per-call timeout override.
- `builtInOnly`: require a built-in action and bypass project/global overrides for this call.
- `cwd` / `worktreePath`: working directory for the action runner and default `ctx.exec` cwd.

```js
const snapshot = action.graphite.stackSnapshot({
  id: "snapshot-stack",
  input: { base: "main" },
});

const viaName = action.invoke("graphite.stackSnapshot", {
  id: "snapshot-stack-by-name",
  input: { base: "main" },
});
```

Action files run in a CommonJS-like Node wrapper. Metadata must be a static object literal (with `mux.schema.*` helper calls or a top-level `const s = mux.schema;` alias allowed) so replay checks can read it without executing action code. Action code may use `require(...)` plus the simple `export const metadata` / `export async function execute` declarations shown below; static `import` and export-list syntax are not supported yet.

A JavaScript action exports metadata and an execute function:

```js
const s = mux.schema;

export const metadata = {
  version: 1,
  description: "Return stack frames for the current Graphite stack",
  effect: "read", // "read" | "workspace" | "external"
  inputSchema: s.object({ base: s.optional(s.string()) }, { additionalProperties: false }),
  outputSchema: s.object(
    {
      frames: s.array(
        s.object(
          {
            branch: s.string(),
            parent: s.optional(s.nullable(s.string())),
          },
          { additionalProperties: false }
        )
      ),
    },
    { additionalProperties: false }
  ),
  // Advisory reviewer-facing metadata; not an enforced sandbox.
  permissions: [{ kind: "command", command: "gt" }],
  timeoutMs: 30000,
};

export async function execute(input, ctx) {
  const result = await ctx.exec("gt", ["stack", "--json"]);
  if (result.exitCode !== 0) throw new Error(result.stderr || "gt stack failed");
  return JSON.parse(result.stdout);
}
```

### `action.workflows.start(spec)`

Starts another workflow in the same workspace and waits for its terminal result. This is a special built-in workflow action: project/global actions can still override `workflows.start`, but the built-in version is coordinated by the durable workflow runner rather than a normal action process.

```js
const child = action.workflows.start({
  id: "research",
  input: {
    name: "deep-research",
    args: { input: args.topic },
  },
});

return { reportMarkdown: "Child said:\n\n" + child.reportMarkdown };
```

Replay semantics:

- Parent `id` + child `{ name, args }` maps to exactly one deterministic child run ID.
- Child workflow step IDs stay local to the child run; they do not collide with parent step IDs.
- Parent replay/resume reuses the linked child run, even if the child workflow source has changed since the child run was created.
- Child completion returns `{ runId, status, name, reportMarkdown, structuredOutput? }` to the parent.
- Child runs are omitted from top-level `task_list` and omitted-ID `task_await` discovery because the parent consumes their result; explicitly awaiting a known child `runId` still works.
- Child failure fails the parent step; parent interruption cascades to active child workflow runs.
- V1 is same-workspace and wait-to-terminal only; fire-and-forget child workflows are intentionally rejected.

### `parallelActions(specs, options?)`

Runs multiple workflow actions concurrently and returns results in input order. Use this for dynamic fan-out over durable host actions such as `workspace.ensure`, `workspace.sendMessage`, `workspace.awaitIdle`, Git snapshots, or `workflows.start` children when you need same-workspace orchestration instead of workflow-owned child agent workspaces.

Each item is an action invocation object:

- `name`: action name, e.g. `"workspace.ensure"`, `"git.status"`, or `"workflows.start"`.
- `id`: stable replay ID, unique within the `parallelActions` call.
- Any normal action fields: `input`, `timeoutMs`, `builtInOnly`, `cwd` / `worktreePath`, `cache`.

```js
const ensured = parallelActions(
  items.map((item) => ({
    name: "workspace.ensure",
    id: "ensure-" + item.key,
    input: {
      projectPath: item.projectPath,
      key: item.key,
      title: item.title,
      trunkBranch: item.trunkBranch,
    },
  })),
  { maxParallel: 8 }
);

const messages = parallelActions(
  ensured.map((result, index) => ({
    name: "workspace.sendMessage",
    id: "send-" + items[index].key,
    input: {
      workspaceId: result.output.workspaceId,
      message: buildPrompt(items[index]),
    },
  }))
);
```

Pass `options.maxParallel` (positive integer) to cap concurrent action executions with a sliding window. `parallelActions([])` returns `[]`, which is useful for dynamic schedules with no current work.

Replay and failure semantics:

- Each item uses the same durable replay/cache/reconcile behavior as a sequential `action.*` call.
- Duplicate item IDs in one `parallelActions` call are rejected before side effects start.
- On failure, queued items stop launching; already-started actions are allowed to settle so mutating/external actions are not abandoned mid-side-effect. The original failure is then thrown.
- Running mutating actions against the same checkout concurrently is only safe when those actions are idempotent/concurrency-safe; otherwise cap `maxParallel` or split the work.

### `parallelWorkflows(specs, options?)`

Convenience wrapper for running same-workspace child workflows concurrently. It maps each item to the built-in `workflows.start` action with `builtInOnly: true`, so it is equivalent to `parallelActions` over `workflows.start` but harder to accidentally shadow with a project action.

```js
const children = parallelWorkflows(
  topics.map((topic) => ({
    id: "research-" + topic.slug,
    name: "deep-research",
    args: { input: topic.question },
  })),
  { maxParallel: 4 }
);

return {
  reportMarkdown: children.map((child) => child.reportMarkdown).join("\n\n---\n\n"),
  structuredOutput: { childRunIds: children.map((child) => child.runId) },
};
```

Child workflow replay/background/interruption semantics are the same as `action.workflows.start`.

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

- Every `agent` / `parallelAgents` item, every `parallelActions` / `parallelWorkflows` item, and every `applyPatch` call must have a stable `id`.
- The replay key includes the step ID and normalized spec, so changing prompts, schemas, action inputs, child workflow args, patch source IDs, or apply options creates new work.
- `action.*` and `parallelActions` items replay completed results by stable `id`, action source path/hash, input, timeout, and cwd.
- `applyPatch` is a durable mutation effect: completed apply/conflict/failed results are replayed from the journal and are not re-applied on resume.
- The workflow conductor cannot call general tools, import modules, access Node, run shell, read files, use timers, or rely on `Date`/`Math.random`; only declared `action.*` / `parallelActions` calls can cross that boundary.
- Put open-ended shell/filesystem/web investigation inside delegated sub-agent prompts, or package repeatable host operations as actions with metadata and schemas.
- Cap model-produced fan-out before calling `parallelAgents`, `parallelActions`, or `parallelWorkflows`.
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
