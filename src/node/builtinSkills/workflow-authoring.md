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

Do **not** create a workflow for a small one-off edit or a single simple investigation. The conductor cannot run arbitrary host operations directly; use `action.*` only for explicit, metadata-declared workflow actions, and delegate open-ended shell/filesystem/web investigation to sub-agents.

## Before authoring

1. Run `workflow_list` to see existing workflows.
2. If an existing workflow is close, run `workflow_read({ name })` and adapt the pattern.
3. Run `workflow_action_list` before writing `action.*` calls; use each action's metadata `inputSchema`, `outputSchema`, `effect`, and `permissions` to choose valid arguments.
4. For one-off drafts, write a scratch workflow:

   ```text
   .mux/workflows/.scratch/<name>.js
   ```

5. Use normal file tools (`file_read`, `file_edit_insert`, `file_edit_replace_string`) to author the JavaScript.
6. Run it by name with `workflow_run`; prefer foreground mode (omit `run_in_background` or set it to `false`) unless you have another workflow/task or independent work to run while it completes. If `workflow_run` returns `status: "running"` or `status: "backgrounded"`, await the returned `runId` before using the result.

Scratch workflows must include a description header and a default exported function:

```js
// description: Short workflow description
export default function workflow({ args, phase, log, agent, action, parallelAgents, applyPatch }) {
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

## Available workflow globals

A workflow default export receives one object:

```js
export default function workflow({ args, phase, log, agent, action, parallelAgents, applyPatch }) {}
```

### `args`

The invocation payload from `workflow_run`. Plain-text slash args are passed as `{ input: "..." }`, so normalize `args.input` for commands like:

```text
/workflow my-workflow review PR #123
```

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

- `title`: UI title.
- `agentId`: sub-agent type/id; defaults to the workflow adapter default (usually `explore`).
- `outputSchema`: JSON Schema subset used to validate `structuredOutput`.

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

Action files run in a CommonJS-like Node wrapper. Metadata must be a static object literal so replay checks can read it without executing action code. Action code may use `require(...)` plus the simple `export const metadata` / `export async function execute` declarations shown below; static `import` and export-list syntax are not supported yet.

A JavaScript action exports metadata and an execute function:

```js
export const metadata = {
  version: 1,
  description: "Return stack frames for the current Graphite stack",
  effect: "read", // "read" | "workspace" | "external"
  inputSchema: { type: "object" },
  outputSchema: { type: "object" },
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

Conflict resolution should follow the old Orchestrator pattern: spawn a dedicated `exec` resolver, include the failing `taskId`, tell it to call `task_apply_git_patch` in its own workspace, resolve `git am` conflicts, commit the resolved result, report, and then call `applyPatch` on the resolver result.

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

### `parallelAgents(specs)`

Runs multiple `agent` specs concurrently and returns results in input order. Use this for review lanes, source summarization, claim verification, or other independent slices.

```js
const laneResults = parallelAgents(
  lanes.map((lane) => ({
    id: `review-${lane}`,
    title: `Review ${lane}`,
    prompt: lanePrompt(lane),
    outputSchema: issueListSchema(),
  }))
);
```

## Structured output schemas

`outputSchema` supports this JSON Schema subset:

- `type`
- `properties`
- `required`
- `items`
- `additionalProperties`
- `enum`

Keep schemas small and strict. Use `additionalProperties: false` for deterministic outputs.

```js
function issueListSchema() {
  return {
    type: "object",
    required: ["issues"],
    additionalProperties: false,
    properties: {
      issues: {
        type: "array",
        items: {
          type: "object",
          required: ["title", "severity", "filePaths", "evidence"],
          additionalProperties: false,
          properties: {
            title: { type: "string" },
            severity: { type: "string", enum: ["P0", "P1", "P2", "P3", "P4"] },
            filePaths: { type: "array", items: { type: "string" } },
            evidence: { type: "string" },
          },
        },
      },
    },
  };
}
```

## Replay rules and gotchas

- Every `agent` / `parallelAgents` item and every `applyPatch` call must have a stable `id`.
- The replay key includes the step ID and normalized spec, so changing prompts, schemas, patch source IDs, or apply options creates new work.
- `action.*` calls replay completed results by stable `id`, action source path/hash, input, timeout, and cwd.
- `applyPatch` is a durable mutation effect: completed apply/conflict/failed results are replayed from the journal and are not re-applied on resume.
- The workflow conductor cannot call general tools, import modules, access Node, run shell, read files, use timers, or rely on `Date`/`Math.random`; only declared `action.*` calls can cross that boundary.
- Put open-ended shell/filesystem/web investigation inside delegated sub-agent prompts, or package repeatable host operations as actions with metadata and schemas.
- Cap model-produced fan-out before calling `parallelAgents`.
- Return `{ reportMarkdown, structuredOutput }` so the parent agent and UI both get useful output.

## Minimal pattern

```js
// description: Review a change with parallel lanes and verification
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
