/* eslint-disable @typescript-eslint/await-thenable, @typescript-eslint/no-unsafe-argument, @typescript-eslint/require-await */
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { describe, expect, test } from "bun:test";
import { ForegroundWaitBackgroundedError } from "@/node/services/taskService";
import { DisposableTempDir } from "@/node/services/tempDir";
import { QuickJSRuntimeFactory } from "@/node/services/ptc/quickjsRuntime";
import { WorkflowActionRegistry } from "./WorkflowActionRegistry";
import { WorkflowDefinitionStore } from "./WorkflowDefinitionStore";
import { WorkflowRunStore } from "./WorkflowRunStore";
import { WorkflowService } from "./WorkflowService";
import type { WorkflowTaskAdapter } from "./WorkflowRunner";
import { normalizeWorkflowArgsForSource } from "./workflowArgs";
import { hashWorkflowStepInput } from "./workflowReplayKey";

async function writeWorkflow(root: string, name: string, source: string) {
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, `${name}.js`), source, "utf-8");
}

async function waitForCondition(
  description: string,
  predicate: () => boolean,
  timeoutMs = 5_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function waitForWorkflowStatus(
  runStore: WorkflowRunStore,
  runId: string,
  status: string
): Promise<void> {
  // Match waitForCondition's 5s budget: loaded CI runners have hit >1s for the
  // post-agent append/lease-renewal phase (see flaky "fresh persisted lease" failures).
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const run = await runStore.getRun(runId);
    if (run.status === status) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const run = await runStore.getRun(runId);
  throw new Error(`Timed out waiting for ${runId} to become ${status}; got ${run.status}`);
}
async function waitForWorkflowRunFileStatus(
  sessionDir: string,
  runId: string,
  status: string
): Promise<void> {
  const runFile = path.join(sessionDir, "workflows", runId, "run.json");
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const run = JSON.parse(await fs.readFile(runFile, "utf-8")) as { status?: unknown };
      if (run.status === status) {
        return;
      }
    } catch {
      // Keep polling until the background writer flushes run.json.
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${runId} run file to become ${status}`);
}

describe("WorkflowService", () => {
  test("lists workflow actions with statically parsed metadata", async () => {
    using tmp = new DisposableTempDir("workflow-service-actions");
    const workspaceRoot = path.join(tmp.path, "project");
    const projectRoot = path.join(workspaceRoot, ".mux", "workflows");
    const globalRoot = path.join(tmp.path, "mux-home", "workflows");
    const projectActionRoot = path.join(workspaceRoot, ".mux", "actions");
    const globalActionRoot = path.join(tmp.path, "mux-home", "actions");
    await fs.mkdir(projectActionRoot, { recursive: true });
    await fs.writeFile(
      path.join(projectActionRoot, "echo.js"),
      `
        module.exports.metadata = {
          version: 1,
          description: "Echo action",
          effect: "read",
          inputSchema: { type: "object", required: ["name"], properties: { name: { type: "string" } } },
          outputSchema: { type: "object" },
        };
        module.exports.execute = async function (input) { return input; };
      `,
      "utf-8"
    );

    const service = new WorkflowService({
      definitionStore: new WorkflowDefinitionStore({ projectRoot, globalRoot, builtIns: [] }),
      actionRegistry: new WorkflowActionRegistry({
        projectRoot: projectActionRoot,
        globalRoot: globalActionRoot,
      }),
      runStore: new WorkflowRunStore({ sessionDir: tmp.path }),
      runtimeFactory: new QuickJSRuntimeFactory(),
      taskAdapter: {
        async runAgent() {
          return { taskId: "task_1", reportMarkdown: "unused", structuredOutput: {} };
        },
      },
      runnerId: "runner-a",
    });

    const actions = await service.listActions({ projectTrusted: true });
    const action = actions.find((candidate) => candidate.name === "echo");

    expect(action).toEqual({
      name: "echo",
      scope: "project",
      sourcePath: path.join(projectActionRoot, "echo.js"),
      executable: true,
      metadata: {
        version: 1,
        description: "Echo action",
        effect: "read",
        inputSchema: {
          type: "object",
          required: ["name"],
          properties: { name: { type: "string" } },
        },
        outputSchema: { type: "object" },
      },
      hasReconcile: false,
    });
  });

  test("keeps action discovery available when one action has invalid metadata", async () => {
    using tmp = new DisposableTempDir("workflow-service-actions-invalid");
    const workspaceRoot = path.join(tmp.path, "project");
    const projectRoot = path.join(workspaceRoot, ".mux", "workflows");
    const globalRoot = path.join(tmp.path, "mux-home", "workflows");
    const projectActionRoot = path.join(workspaceRoot, ".mux", "actions");
    const globalActionRoot = path.join(tmp.path, "mux-home", "actions");
    await fs.mkdir(globalActionRoot, { recursive: true });
    await fs.writeFile(
      path.join(globalActionRoot, "broken.js"),
      `
        module.exports.metadata = { version: 1, description: "Missing effect" };
        module.exports.execute = async () => null;
      `,
      "utf-8"
    );

    const service = new WorkflowService({
      definitionStore: new WorkflowDefinitionStore({ projectRoot, globalRoot, builtIns: [] }),
      actionRegistry: new WorkflowActionRegistry({
        projectRoot: projectActionRoot,
        globalRoot: globalActionRoot,
      }),
      runStore: new WorkflowRunStore({ sessionDir: tmp.path }),
      runtimeFactory: new QuickJSRuntimeFactory(),
      taskAdapter: {
        async runAgent() {
          return { taskId: "task_1", reportMarkdown: "unused", structuredOutput: {} };
        },
      },
      runnerId: "runner-a",
    });

    const actions = await service.listActions({ projectTrusted: true });
    const action = actions.find((candidate) => candidate.name === "broken");

    expect(action).toMatchObject({
      name: "broken",
      scope: "global",
      sourcePath: path.join(globalActionRoot, "broken.js"),
      executable: false,
    });
    expect(action?.executable === false ? action.blockedReason : "").toContain("effect");
  });

  test("marks metadata-only workflow actions as blocked during discovery", async () => {
    using tmp = new DisposableTempDir("workflow-service-actions-missing-execute");
    const workspaceRoot = path.join(tmp.path, "project");
    const projectRoot = path.join(workspaceRoot, ".mux", "workflows");
    const globalRoot = path.join(tmp.path, "mux-home", "workflows");
    const projectActionRoot = path.join(workspaceRoot, ".mux", "actions");
    const globalActionRoot = path.join(tmp.path, "mux-home", "actions");
    await fs.mkdir(projectActionRoot, { recursive: true });
    await fs.writeFile(
      path.join(projectActionRoot, "metadataOnly.js"),
      `module.exports.metadata = { version: 1, description: "Metadata only", effect: "read" };`,
      "utf-8"
    );

    const service = new WorkflowService({
      definitionStore: new WorkflowDefinitionStore({ projectRoot, globalRoot, builtIns: [] }),
      actionRegistry: new WorkflowActionRegistry({
        projectRoot: projectActionRoot,
        globalRoot: globalActionRoot,
      }),
      runStore: new WorkflowRunStore({ sessionDir: tmp.path }),
      runtimeFactory: new QuickJSRuntimeFactory(),
      taskAdapter: {
        async runAgent() {
          return { taskId: "task_1", reportMarkdown: "unused", structuredOutput: {} };
        },
      },
      runnerId: "runner-a",
    });

    const actions = await service.listActions({ projectTrusted: true });
    const action = actions.find((candidate) => candidate.name === "metadataOnly");

    expect(action).toMatchObject({
      name: "metadataOnly",
      scope: "project",
      sourcePath: path.join(projectActionRoot, "metadataOnly.js"),
      executable: false,
    });
    expect(action?.executable === false ? action.blockedReason : "").toContain("execute");
  });

  test("starts a named workflow and persists the captured definition source", async () => {
    using tmp = new DisposableTempDir("workflow-service");
    const projectRoot = path.join(tmp.path, "project", ".mux", "workflows");
    const globalRoot = path.join(tmp.path, "mux-home", "workflows");
    const source = `export const metadata = { description: "Demo workflow" };
export default function workflow({ args, agent }) {
  const child = agent({ id: "summarize", prompt: "Summarize " + args.topic, outputSchema: {} });
  return { reportMarkdown: "Final " + child.reportMarkdown };
}
`;
    await writeWorkflow(globalRoot, "demo", source);

    const taskAdapter: WorkflowTaskAdapter = {
      async runAgent() {
        return { taskId: "task_1", reportMarkdown: "child summary", structuredOutput: {} };
      },
    };
    const statusEvents: Array<{ workspaceId: string; runId: string; status: string }> = [];
    const runStore = new WorkflowRunStore({ sessionDir: tmp.path });
    const service = new WorkflowService({
      definitionStore: new WorkflowDefinitionStore({ projectRoot, globalRoot, builtIns: [] }),
      runStore,
      onRunStatusChanged: (event) => {
        statusEvents.push(event);
      },
      runtimeFactory: new QuickJSRuntimeFactory(),
      taskAdapter,
      generateRunId: () => "wfr_demo",
      runnerId: "runner-a",
      clock: {
        nowIso: () => "2026-05-29T00:00:00.000Z",
        nowMs: () => 1_000,
      },
    });

    const result = await service.startNamedWorkflow({
      name: "demo",
      workspaceId: "workspace-1",
      projectTrusted: true,
      args: { topic: "workflow services" },
    });
    const run = await runStore.getRun("wfr_demo");

    expect(result).toEqual({
      runId: "wfr_demo",
      status: "completed",
      result: { reportMarkdown: "Final child summary" },
    });
    expect(statusEvents).toEqual([
      { workspaceId: "workspace-1", runId: "wfr_demo", status: "pending" },
      { workspaceId: "workspace-1", runId: "wfr_demo", status: "completed" },
    ]);
    expect(run.definitionSource).toBe(source);
    expect(run.definition.scope).toBe("global");
  });

  test("normalizes workflow args from static metadata and exposes mux helpers", async () => {
    using tmp = new DisposableTempDir("workflow-service-args-schema");
    const projectRoot = path.join(tmp.path, "project", ".mux", "workflows");
    const globalRoot = path.join(tmp.path, "mux-home", "workflows");
    const source = `const s = mux.schema;
export const metadata = {
  description: "Args schema workflow",
  argsSchema: s.object({
    target: s.string({ positional: true }),
    fix: s.optional(s.boolean({ default: true, negatedAliases: ["--review-only"] })),
    maxFindings: s.optional(
      s.integer({ default: 20, minimum: 1, maximum: 50, aliases: ["--max-findings"] })
    ),
    mode: s.optional(s.enum(["quick", "smart"], { default: "smart" })),
  }),
};
export default function workflow({ args }) {
  const schema = s.object(
    { summary: s.string(), optionalNote: s.optional(s.string()) },
    { additionalProperties: false }
  );
  return {
    reportMarkdown: mux.utils.fencedJson(args),
    structuredOutput: {
      args,
      schema,
      list: mux.utils.stringList([" a ", "", 2, "b"]),
      bounded: mux.utils.boundedInt("9", 0, 1, 5),
      compacted: mux.utils.compactText("abcdef", 3),
      patch: mux.patch.normalize({ success: true, taskId: "task_patch" }),
    },
  };
}
`;
    await writeWorkflow(globalRoot, "args-demo", source);
    const runStore = new WorkflowRunStore({ sessionDir: tmp.path });
    const service = new WorkflowService({
      definitionStore: new WorkflowDefinitionStore({ projectRoot, globalRoot, builtIns: [] }),
      runStore,
      runtimeFactory: new QuickJSRuntimeFactory(),
      taskAdapter: {
        async runAgent() {
          throw new Error("agent should not run");
        },
      },
      generateRunId: () => "wfr_args_demo",
      runnerId: "runner-a",
      clock: {
        nowIso: () => "2026-05-29T00:00:00.000Z",
        nowMs: () => 1_000,
      },
    });

    const result = await service.startNamedWorkflow({
      name: "args-demo",
      workspaceId: "workspace-1",
      projectTrusted: true,
      args: { input: '"src folder" --review-only --max-findings=3 --mode quick' },
    });
    const run = await runStore.getRun("wfr_args_demo");

    expect(run.args).toEqual({ target: "src folder", fix: false, maxFindings: 3, mode: "quick" });
    expect(result).toEqual({
      runId: "wfr_args_demo",
      status: "completed",
      result: {
        reportMarkdown:
          '```json\n{\n  "target": "src folder",\n  "fix": false,\n  "maxFindings": 3,\n  "mode": "quick"\n}\n```',
        structuredOutput: {
          args: { target: "src folder", fix: false, maxFindings: 3, mode: "quick" },
          schema: {
            type: "object",
            required: ["summary"],
            properties: { summary: { type: "string" }, optionalNote: { type: "string" } },
            additionalProperties: false,
          },
          list: ["a", "b"],
          bounded: 5,
          patch: {
            success: true,
            status: "applied",
            taskId: "task_patch",
          },
          compacted: "abc\n[truncated by mux.utils.compactText after 3 characters]",
        },
      },
    });
  });

  test("normalizes quoted Windows paths and nullable workflow args", () => {
    const source = `const s = mux.schema;
export const metadata = {
  argsSchema: s.object({
    target: s.string({ positional: true }),
    path: s.optional(s.string({ aliases: ["--path"] })),
    note: s.optional(s.nullable(s.string())),
  }),
};
export default function workflow() { return { reportMarkdown: "ok" }; }
`;

    const result = normalizeWorkflowArgsForSource(source, {
      input: `'C:\\Users\\Ada\\my repo' --path="D:\\Tools\\Mux Dir"`,
      note: null,
    });

    expect(result.args).toEqual({
      target: "C:\\Users\\Ada\\my repo",
      path: "D:\\Tools\\Mux Dir",
      note: null,
    });
  });

  test("uses a declared input args field as fallback positional text", () => {
    const source = `const s = mux.schema;
export const metadata = {
  argsSchema: s.object({
    input: s.string(),
    mode: s.optional(s.string({ default: "fast", aliases: ["--mode"] })),
  }),
};
export default function workflow() { return { reportMarkdown: "ok" }; }
`;

    expect(
      normalizeWorkflowArgsForSource(source, { input: "hello world --mode slow" }).args
    ).toEqual({
      input: "hello world",
      mode: "slow",
    });
    expect(normalizeWorkflowArgsForSource(source, { input: "compare foo --bar" }).args).toEqual({
      input: "compare foo --bar",
      mode: "fast",
    });
    expect(normalizeWorkflowArgsForSource(source, { input: "hello --mode=--help" }).args).toEqual({
      input: "hello",
      mode: "--help",
    });
    expect(normalizeWorkflowArgsForSource(source, { input: "compare --flag=" }).args).toEqual({
      input: "compare --flag=",
      mode: "fast",
    });
    expect(normalizeWorkflowArgsForSource(source, "hello world").args).toEqual({
      input: "hello world",
      mode: "fast",
    });
  });

  test("parses aliases when input accompanies an explicit positional field", () => {
    const source = `const s = mux.schema;
export const metadata = {
  argsSchema: s.object({
    topic: s.optional(s.string({ positional: true })),
    input: s.optional(s.string()),
    quick: s.optional(s.boolean({ default: false, aliases: ["--quick"] })),
  }),
};
export default function workflow() { return { reportMarkdown: "ok" }; }
`;

    expect(normalizeWorkflowArgsForSource(source, { input: "agents --quick" }).args).toEqual({
      topic: "agents",
      input: "agents --quick",
      quick: true,
    });
  });

  test("preserves structured args over parsed transport input", () => {
    const source = `const s = mux.schema;
export const metadata = {
  argsSchema: s.object({
    topic: s.optional(s.string()),
    input: s.optional(s.string()),
    query: s.optional(s.string()),
    quick: s.optional(s.boolean({ default: false, aliases: ["--quick"] })),
  }),
};
export default function workflow() { return { reportMarkdown: "ok" }; }
`;

    expect(
      normalizeWorkflowArgsForSource(source, { query: "parsed query", input: "raw topic --quick" })
        .args
    ).toEqual({
      query: "parsed query",
      input: "raw topic",
      quick: true,
    });
    expect(
      normalizeWorkflowArgsForSource(source, {
        topic: "explicit topic",
        input: "raw topic --quick",
      }).args
    ).toEqual({
      topic: "explicit topic",
      input: "raw topic",
      quick: true,
    });
  });

  test("applies invocation default args only for schema-declared missing fields", () => {
    const source = `const s = mux.schema;
export const metadata = {
  argsSchema: s.object({
    projectPath: s.string(),
    topic: s.optional(s.string({ default: "schema topic" })),
    input: s.optional(s.string()),
  }),
};
export default function workflow() { return { reportMarkdown: "ok" }; }
`;

    expect(
      normalizeWorkflowArgsForSource(
        source,
        { input: "hello" },
        {
          defaultArgs: { projectPath: "/repo", ignored: true },
        }
      ).args
    ).toEqual({ projectPath: "/repo", topic: "schema topic", input: "hello" });
    expect(
      normalizeWorkflowArgsForSource(
        source,
        { projectPath: "/explicit" },
        {
          defaultArgs: { projectPath: "/repo" },
        }
      ).args
    ).toEqual({ projectPath: "/explicit", topic: "schema topic" });
  });

  test("normalizes exact short flag aliases before positional args", () => {
    const source = `const s = mux.schema;
export const metadata = {
  argsSchema: s.object({
    target: s.optional(s.string({ positional: true })),
    help: s.optional(s.boolean({ default: false, aliases: ["--help", "-h"] })),
  }),
};
export default function workflow() { return { reportMarkdown: "ok" }; }
`;

    expect(normalizeWorkflowArgsForSource(source, { input: "-h" }).args).toEqual({
      help: true,
    });
  });

  test("runs workflows with metadata strings that contain declaration terminator text", async () => {
    using tmp = new DisposableTempDir("workflow-service-metadata-terminator");
    const projectRoot = path.join(tmp.path, "project", ".mux", "workflows");
    const globalRoot = path.join(tmp.path, "mux-home", "workflows");
    const source = `export const metadata = { description: "desc }; suffix" };
export default function workflow() { return { reportMarkdown: metadata.description }; }
`;
    await writeWorkflow(globalRoot, "terminator", source);
    const runStore = new WorkflowRunStore({ sessionDir: tmp.path });
    const service = new WorkflowService({
      definitionStore: new WorkflowDefinitionStore({ projectRoot, globalRoot, builtIns: [] }),
      runStore,
      runtimeFactory: new QuickJSRuntimeFactory(),
      taskAdapter: {
        async runAgent() {
          throw new Error("agent should not run");
        },
      },
      generateRunId: () => "wfr_terminator",
      runnerId: "runner-a",
      clock: {
        nowIso: () => "2026-05-29T00:00:00.000Z",
        nowMs: () => 1_000,
      },
    });

    await expect(service.listDefinitions({ projectTrusted: true })).resolves.toContainEqual(
      expect.objectContaining({ name: "terminator", description: "desc }; suffix" })
    );
    await expect(
      service.startNamedWorkflow({
        name: "terminator",
        workspaceId: "workspace-1",
        projectTrusted: true,
        args: {},
      })
    ).resolves.toEqual({
      runId: "wfr_terminator",
      status: "completed",
      result: { reportMarkdown: "desc }; suffix" },
    });
  });

  test("runs parallel agent maps through mux.parallelMap", async () => {
    using tmp = new DisposableTempDir("workflow-service-parallel-map");
    const projectRoot = path.join(tmp.path, "project", ".mux", "workflows");
    const globalRoot = path.join(tmp.path, "mux-home", "workflows");
    await writeWorkflow(
      globalRoot,
      "parallel-map",
      `export const metadata = { description: "Parallel map workflow" };
export default function workflow() {
  const results = mux.parallelMap({
    id: "lane",
    items: ["reuse", "quality"],
    stepId: function (item) { return "review-" + item; },
    title: function (item) { return "Review " + item; },
    agentId: "explore",
    prompt: function (item) { return "Review " + item; },
    outputSchema: mux.schema.object({ summary: mux.schema.string() }),
  });
  return { reportMarkdown: "done", structuredOutput: { summaries: results.map(function (result) { return result.structuredOutput.summary; }) } };
}
`
    );
    const runStore = new WorkflowRunStore({ sessionDir: tmp.path });
    const service = new WorkflowService({
      definitionStore: new WorkflowDefinitionStore({ projectRoot, globalRoot, builtIns: [] }),
      runStore,
      runtimeFactory: new QuickJSRuntimeFactory(),
      taskAdapter: {
        async runAgent(spec) {
          return {
            taskId: "task_" + spec.id,
            reportMarkdown: "ok",
            structuredOutput: { summary: spec.prompt },
          };
        },
      },
      generateRunId: () => "wfr_parallel_map",
      runnerId: "runner-a",
    });

    const result = await service.startNamedWorkflow({
      name: "parallel-map",
      workspaceId: "workspace-1",
      projectTrusted: true,
      args: {},
    });
    const run = await runStore.getRun("wfr_parallel_map");

    expect(result.result).toEqual({
      reportMarkdown: "done",
      structuredOutput: { summaries: ["Review reuse", "Review quality"] },
    });
    expect(run.steps.map((step) => step.stepId)).toEqual(["review-reuse", "review-quality"]);
  });

  test("rejects invalid workflow args before creating a run", async () => {
    using tmp = new DisposableTempDir("workflow-service-args-schema-invalid");
    const projectRoot = path.join(tmp.path, "project", ".mux", "workflows");
    const globalRoot = path.join(tmp.path, "mux-home", "workflows");
    await writeWorkflow(
      globalRoot,
      "args-invalid",
      `export const metadata = {
  description: "Args schema workflow",
  argsSchema: {
    type: "object",
    properties: { maxFindings: { type: "integer", minimum: 1, aliases: ["--max-findings"] } },
  },
};
export default function workflow() { return { reportMarkdown: "should not run" }; }
`
    );
    const runStore = new WorkflowRunStore({ sessionDir: tmp.path });
    const service = new WorkflowService({
      definitionStore: new WorkflowDefinitionStore({ projectRoot, globalRoot, builtIns: [] }),
      runStore,
      runtimeFactory: new QuickJSRuntimeFactory(),
      taskAdapter: {
        async runAgent() {
          throw new Error("agent should not run");
        },
      },
      generateRunId: () => "wfr_args_invalid",
      runnerId: "runner-a",
    });

    await expect(
      service.startNamedWorkflow({
        name: "args-invalid",
        workspaceId: "workspace-1",
        projectTrusted: true,
        args: { input: "--max-findings 0" },
      })
    ).rejects.toThrow("Workflow argument maxFindings must be >= 1");
    await expect(runStore.getRun("wfr_args_invalid")).rejects.toThrow(
      /ENOENT|Workflow run not found/
    );
  });

  test("runs a nested workflow through action.workflows.start and reuses the child on replay", async () => {
    using tmp = new DisposableTempDir("workflow-service-nested");
    const workspaceRoot = path.join(tmp.path, "project");
    const projectRoot = path.join(workspaceRoot, ".mux", "workflows");
    const globalRoot = path.join(tmp.path, "mux-home", "workflows");
    const actionProjectRoot = path.join(workspaceRoot, ".mux", "actions");
    const actionGlobalRoot = path.join(tmp.path, "mux-home", "actions");
    await writeWorkflow(
      globalRoot,
      "child-simple",
      "export const metadata = { description: \"Child workflow\" };\nexport default function workflow({ args }) { return { reportMarkdown: 'Child: ' + args.topic }; }\n"
    );
    await writeWorkflow(
      globalRoot,
      "parent-simple",
      `export const metadata = { description: "Parent workflow" };
      export default function workflow({ args, action }) {
        const child = action.workflows.start({
          id: "child-simple",
          input: { name: "child-simple", args: { topic: args.topic } },
        });
        return { reportMarkdown: "Parent saw " + child.reportMarkdown, structuredOutput: { childRunId: child.runId } };
      }\n`
    );

    const runStore = new WorkflowRunStore({ sessionDir: tmp.path });
    const service = new WorkflowService({
      definitionStore: new WorkflowDefinitionStore({ projectRoot, globalRoot, builtIns: [] }),
      actionRegistry: new WorkflowActionRegistry({
        projectRoot: actionProjectRoot,
        globalRoot: actionGlobalRoot,
      }),
      runStore,
      runtimeFactory: new QuickJSRuntimeFactory(),
      taskAdapter: {
        async runAgent() {
          throw new Error("agent should not run");
        },
      },
      generateRunId: () => "wfr_parent_simple",
      runnerId: "runner-a",
      clock: {
        nowIso: () => "2026-05-29T00:00:00.000Z",
        nowMs: () => 1_000,
      },
    });

    const result = await service.startNamedWorkflow({
      name: "parent-simple",
      workspaceId: "workspace-1",
      projectTrusted: true,
      args: { topic: "nested smoke" },
    });
    const parentRun = await runStore.getRun("wfr_parent_simple");
    const childStep = parentRun.steps.find((step) => step.stepId === "child-simple");
    expect(childStep?.taskId).toMatch(/^wfr_child_/);
    const childRunId = childStep?.taskId;
    if (childRunId == null) {
      throw new Error("Expected nested workflow step to record a child run id");
    }
    const childRun = await runStore.getRun(childRunId);

    expect(result).toEqual({
      runId: "wfr_parent_simple",
      status: "completed",
      result: {
        reportMarkdown: "Parent saw Child: nested smoke",
        structuredOutput: { childRunId },
      },
    });
    expect(childRun.id).toBe(childRunId);
    expect(childRun.workspaceId).toBe("workspace-1");
    expect(childRun.definition.name).toBe("child-simple");
    expect(childRun.parentWorkflow?.runId).toBe("wfr_parent_simple");
    expect(childRun.parentWorkflow?.stepId).toBe("child-simple");
    expect(childRun.status).toBe("completed");
    expect(parentRun.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "workflow",
          stepId: "child-simple",
          runId: childRunId,
          status: "started",
        }),
        expect.objectContaining({
          type: "workflow",
          stepId: "child-simple",
          runId: childRunId,
          status: "completed",
        }),
      ])
    );

    const runsAfterCompletion = await runStore.listRuns();
    expect(
      runsAfterCompletion.filter((run) => run.parentWorkflow?.runId === "wfr_parent_simple")
    ).toHaveLength(1);
  });

  test("snapshots parent action cwd when replay creates a nested child run", async () => {
    using tmp = new DisposableTempDir("workflow-service-nested-cwd");
    const workspaceRoot = path.join(tmp.path, "project");
    const projectRoot = path.join(workspaceRoot, ".mux", "workflows");
    const globalRoot = path.join(tmp.path, "mux-home", "workflows");
    const actionProjectRoot = path.join(workspaceRoot, ".mux", "actions");
    const actionGlobalRoot = path.join(tmp.path, "mux-home", "actions");
    await writeWorkflow(
      globalRoot,
      "child-cwd",
      "export const metadata = { description: \"Child cwd\" };\nexport default function workflow() { return { reportMarkdown: 'child' }; }\n"
    );
    const parentSource = `export const metadata = { description: "Parent cwd" };
export default function workflow({ action }) {
  return action.workflows.start({
    id: "child-cwd",
    input: { name: "child-cwd", args: {} },
  });
}\n`;
    const runStore = new WorkflowRunStore({ sessionDir: tmp.path });
    const parentCwd = path.join(tmp.path, "parent-cwd");
    await runStore.createRun({
      id: "wfr_parent_cwd",
      workspaceId: "workspace-1",
      definition: {
        name: "parent-cwd",
        description: "Parent cwd",
        scope: "global",
        executable: true,
      },
      definitionSource: parentSource,
      args: {},
      defaultActionCwd: parentCwd,
      now: "2026-05-29T00:00:00.000Z",
    });
    const service = new WorkflowService({
      definitionStore: new WorkflowDefinitionStore({ projectRoot, globalRoot, builtIns: [] }),
      actionRegistry: new WorkflowActionRegistry({
        projectRoot: actionProjectRoot,
        globalRoot: actionGlobalRoot,
      }),
      runStore,
      runtimeFactory: new QuickJSRuntimeFactory(),
      taskAdapter: {
        async runAgent() {
          throw new Error("agent should not run");
        },
      },
      defaultActionCwd: path.join(tmp.path, "service-cwd"),
      runnerId: "runner-a",
    });

    await service.resumeRun({
      workspaceId: "workspace-1",
      runId: "wfr_parent_cwd",
      projectTrusted: true,
    });
    const parentRun = await runStore.getRun("wfr_parent_cwd");
    const childRunId = parentRun.steps.find((step) => step.stepId === "child-cwd")?.taskId;
    if (childRunId == null) {
      throw new Error("Expected nested cwd workflow to record a child run id");
    }
    const childRun = await runStore.getRun(childRunId);

    expect(childRun.defaultActionCwd).toBe(parentCwd);
  });

  test("preserves explicit null args for nested child workflows", async () => {
    using tmp = new DisposableTempDir("workflow-service-nested-null-args");
    const workspaceRoot = path.join(tmp.path, "project");
    const projectRoot = path.join(workspaceRoot, ".mux", "workflows");
    const globalRoot = path.join(tmp.path, "mux-home", "workflows");
    const actionProjectRoot = path.join(workspaceRoot, ".mux", "actions");
    const actionGlobalRoot = path.join(tmp.path, "mux-home", "actions");
    await writeWorkflow(
      globalRoot,
      "child-null-args",
      'export const metadata = { description: "Child null args" };\nexport default function workflow({ args }) { return { reportMarkdown: String(args === null) }; }\n'
    );
    await writeWorkflow(
      globalRoot,
      "parent-null-args",
      `export const metadata = { description: "Parent null args" };
export default function workflow({ action }) {
  return action.workflows.start({
    id: "child-null-args",
    input: { name: "child-null-args", args: null },
  });
}\n`
    );
    const service = new WorkflowService({
      definitionStore: new WorkflowDefinitionStore({ projectRoot, globalRoot, builtIns: [] }),
      actionRegistry: new WorkflowActionRegistry({
        projectRoot: actionProjectRoot,
        globalRoot: actionGlobalRoot,
      }),
      runStore: new WorkflowRunStore({ sessionDir: tmp.path }),
      runtimeFactory: new QuickJSRuntimeFactory(),
      taskAdapter: {
        async runAgent() {
          throw new Error("agent should not run");
        },
      },
      generateRunId: () => "wfr_parent_null_args",
      runnerId: "runner-a",
    });

    const result = await service.startNamedWorkflow({
      name: "parent-null-args",
      workspaceId: "workspace-1",
      projectTrusted: true,
      args: {},
    });

    expect(result.result).toMatchObject({ reportMarkdown: "true" });
  });

  test("records terminal parent step state when a nested child workflow fails", async () => {
    using tmp = new DisposableTempDir("workflow-service-nested-failure");
    const workspaceRoot = path.join(tmp.path, "project");
    const projectRoot = path.join(workspaceRoot, ".mux", "workflows");
    const globalRoot = path.join(tmp.path, "mux-home", "workflows");
    const actionProjectRoot = path.join(workspaceRoot, ".mux", "actions");
    const actionGlobalRoot = path.join(tmp.path, "mux-home", "actions");
    await writeWorkflow(
      globalRoot,
      "child-fails",
      "export const metadata = { description: \"Child fails\" };\nexport default function workflow() { throw new Error('child boom'); }\n"
    );
    await writeWorkflow(
      globalRoot,
      "parent-catches-child-failure",
      `export const metadata = { description: "Parent catches child failure" };
export default function workflow({ action }) {
  try {
    action.workflows.start({
      id: "child-fails",
      input: { name: "child-fails", args: {} },
    });
  } catch (error) {
    return { reportMarkdown: "caught " + error.message };
  }
  return { reportMarkdown: "unexpected" };
}\n`
    );
    const runStore = new WorkflowRunStore({ sessionDir: tmp.path });
    const service = new WorkflowService({
      definitionStore: new WorkflowDefinitionStore({ projectRoot, globalRoot, builtIns: [] }),
      actionRegistry: new WorkflowActionRegistry({
        projectRoot: actionProjectRoot,
        globalRoot: actionGlobalRoot,
      }),
      runStore,
      runtimeFactory: new QuickJSRuntimeFactory(),
      taskAdapter: {
        async runAgent() {
          throw new Error("agent should not run");
        },
      },
      generateRunId: () => "wfr_parent_catches_child_failure",
      runnerId: "runner-a",
    });

    const result = await service.startNamedWorkflow({
      name: "parent-catches-child-failure",
      workspaceId: "workspace-1",
      projectTrusted: true,
      args: {},
    });
    const parentRun = await runStore.getRun("wfr_parent_catches_child_failure");
    const childStep = parentRun.steps.find((step) => step.stepId === "child-fails");

    expect(result.status).toBe("completed");
    expect(childStep?.status).toBe("failed");
    expect(parentRun.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "workflow",
          stepId: "child-fails",
          status: "failed",
        }),
      ])
    );
  });

  test("applies current project trust before starting nested project workflows", async () => {
    using tmp = new DisposableTempDir("workflow-service-nested-trust");
    const workspaceRoot = path.join(tmp.path, "project");
    const projectRoot = path.join(workspaceRoot, ".mux", "workflows");
    const globalRoot = path.join(tmp.path, "mux-home", "workflows");
    const actionProjectRoot = path.join(workspaceRoot, ".mux", "actions");
    const actionGlobalRoot = path.join(tmp.path, "mux-home", "actions");
    await writeWorkflow(
      projectRoot,
      "child-project",
      "export const metadata = { description: \"Project child\" };\nexport default function workflow() { return { reportMarkdown: 'project child' }; }\n"
    );
    await writeWorkflow(
      globalRoot,
      "parent-project-child",
      `export const metadata = { description: "Parent project child" };
export default function workflow({ action }) {
  return action.workflows.start({
    id: "child-project",
    input: { name: "child-project", args: {} },
  });
}\n`
    );
    const runStore = new WorkflowRunStore({ sessionDir: tmp.path });
    const service = new WorkflowService({
      definitionStore: new WorkflowDefinitionStore({ projectRoot, globalRoot, builtIns: [] }),
      actionRegistry: new WorkflowActionRegistry({
        projectRoot: actionProjectRoot,
        globalRoot: actionGlobalRoot,
      }),
      runStore,
      runtimeFactory: new QuickJSRuntimeFactory(),
      taskAdapter: {
        async runAgent() {
          throw new Error("agent should not run");
        },
      },
      getCurrentProjectTrusted: () => false,
      generateRunId: () => "wfr_parent_project_child",
      runnerId: "runner-a",
    });

    await expect(
      service.startNamedWorkflow({
        name: "parent-project-child",
        workspaceId: "workspace-1",
        projectTrusted: true,
        args: {},
      })
    ).rejects.toThrow(/Project trust|Workflow definition not found/);
    const parentRun = await runStore.getRun("wfr_parent_project_child");

    expect(parentRun.steps.find((step) => step.stepId === "child-project")?.status).toBe("failed");
  });

  test("notifies foreground run creation before the first workflow step blocks", async () => {
    using tmp = new DisposableTempDir("workflow-service-created-callback");
    const projectRoot = path.join(tmp.path, "project", ".mux", "workflows");
    const globalRoot = path.join(tmp.path, "mux-home", "workflows");
    await writeWorkflow(
      globalRoot,
      "scheduled-scan",
      "export const metadata = { description: \"Scheduled scan\" };\nexport default function workflow({ agent }) { return agent({ id: 'scope', prompt: 'scope security surface', outputSchema: {} }); }\n"
    );

    let releaseAgent:
      | ((value: { taskId: string; reportMarkdown: string; structuredOutput: unknown }) => void)
      | undefined;
    const runCreatedGate = Promise.withResolvers<void>();
    const lifecycleEvents: string[] = [];
    const runStore = new WorkflowRunStore({ sessionDir: tmp.path });
    const service = new WorkflowService({
      definitionStore: new WorkflowDefinitionStore({ projectRoot, globalRoot, builtIns: [] }),
      runStore,
      runtimeFactory: new QuickJSRuntimeFactory(),
      taskAdapter: {
        async runAgent() {
          lifecycleEvents.push("agent-started");
          return await new Promise<{
            taskId: string;
            reportMarkdown: string;
            structuredOutput: unknown;
          }>((resolve) => {
            releaseAgent = resolve;
          });
        },
      },
      generateRunId: () => "wfr_scheduled_scan",
      runnerId: "runner-a",
    });

    // Hold the callback open so this assertion checks WorkflowService's ordering instead of
    // racing the runner after a synchronous onRunCreated callback returns.
    const resultPromise = service.startNamedWorkflow({
      name: "scheduled-scan",
      workspaceId: "workspace-1",
      projectTrusted: true,
      args: { severity: "high" },
      onRunCreated(event) {
        lifecycleEvents.push("run-created");
        expect(event).toMatchObject({
          runId: "wfr_scheduled_scan",
          status: "pending",
          result: null,
          run: {
            id: "wfr_scheduled_scan",
            workspaceId: "workspace-1",
            status: "pending",
            args: { severity: "high" },
          },
        });
        return runCreatedGate.promise;
      },
    });

    await waitForCondition("foreground run creation callback", () =>
      lifecycleEvents.includes("run-created")
    );
    expect(lifecycleEvents).toEqual(["run-created"]);
    expect(releaseAgent).toBeUndefined();
    runCreatedGate.resolve();
    await waitForCondition("foreground agent to start", () => releaseAgent != null);
    expect(lifecycleEvents).toEqual(["run-created", "agent-started"]);

    releaseAgent?.({ taskId: "task_scope", reportMarkdown: "scoped", structuredOutput: {} });
    await expect(resultPromise).resolves.toEqual({
      runId: "wfr_scheduled_scan",
      status: "completed",
      result: { reportMarkdown: "scoped", structuredOutput: {} },
    });
    await expect(runStore.getRun("wfr_scheduled_scan")).resolves.toMatchObject({
      status: "completed",
    });
  });

  test("runs workspace scratch workflow definitions authored as files", async () => {
    using tmp = new DisposableTempDir("workflow-service");
    const workspaceRoot = path.join(tmp.path, "project");
    const scratchRoot = path.join(workspaceRoot, ".mux", "workflows", ".scratch");
    const projectRoot = path.join(workspaceRoot, ".mux", "workflows");
    const globalRoot = path.join(tmp.path, "mux-home", "workflows");
    const runStore = new WorkflowRunStore({ sessionDir: tmp.path });
    const service = new WorkflowService({
      definitionStore: new WorkflowDefinitionStore({
        projectRoot,
        globalRoot,
        scratchRoot,
        builtIns: [],
      }),
      runStore,
      runtimeFactory: new QuickJSRuntimeFactory(),
      taskAdapter: {
        async runAgent() {
          throw new Error("agent should not run");
        },
      },
      generateRunId: () => "wfr_scratch_run",
      runnerId: "runner-a",
    });

    await writeWorkflow(
      scratchRoot,
      "scratch-research",
      "export const metadata = { description: \"Scratch research\" };\nexport default function workflow({ args }) { return { reportMarkdown: 'Topic: ' + args.topic }; }\n"
    );
    const result = await service.startNamedWorkflow({
      name: "scratch-research",
      workspaceId: "workspace-1",
      projectTrusted: true,
      args: { topic: "drafts" },
    });
    const run = await runStore.getRun("wfr_scratch_run");

    expect(result).toEqual({
      runId: "wfr_scratch_run",
      status: "completed",
      result: { reportMarkdown: "Topic: drafts" },
    });
    expect(run.definition.scope).toBe("scratch");
    await expect(
      fs.readFile(path.join(scratchRoot, "scratch-research.js"), "utf-8")
    ).resolves.toContain('description: "Scratch research"');
    await expect(fs.readFile(path.join(scratchRoot, ".gitignore"), "utf-8")).rejects.toThrow();
  });

  test("lists definitions through the definition store trust gate", async () => {
    using tmp = new DisposableTempDir("workflow-service");
    const projectRoot = path.join(tmp.path, "project", ".mux", "workflows");
    const globalRoot = path.join(tmp.path, "mux-home", "workflows");
    await writeWorkflow(
      projectRoot,
      "demo",
      'export const metadata = { description: "Project workflow" };\nexport default function workflow() { return null; }\n'
    );
    await writeWorkflow(
      globalRoot,
      "demo",
      'export const metadata = { description: "Global workflow" };\nexport default function workflow() { return null; }\n'
    );

    const service = new WorkflowService({
      definitionStore: new WorkflowDefinitionStore({ projectRoot, globalRoot, builtIns: [] }),
      runStore: new WorkflowRunStore({ sessionDir: tmp.path }),
      runtimeFactory: new QuickJSRuntimeFactory(),
      taskAdapter: {
        async runAgent() {
          return { taskId: "task_1", reportMarkdown: "unused", structuredOutput: {} };
        },
      },
      generateRunId: () => "wfr_demo",
      runnerId: "runner-a",
    });

    await expect(service.listDefinitions({ projectTrusted: false })).resolves.toEqual([
      expect.objectContaining({ name: "demo", scope: "global" }),
    ]);
    await expect(service.listDefinitions({ projectTrusted: true })).resolves.toEqual([
      expect.objectContaining({ name: "demo", scope: "project" }),
    ]);
  });

  test("interrupts a run without deleting completed step state", async () => {
    using tmp = new DisposableTempDir("workflow-service");
    const runStore = new WorkflowRunStore({ sessionDir: tmp.path });
    await runStore.createRun({
      id: "wfr_interrupt",
      workspaceId: "workspace-1",
      definition: { name: "demo", description: "Demo", scope: "built-in", executable: true },
      definitionSource:
        "export default function workflow() { return { reportMarkdown: 'unused' }; }\n",
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    await runStore.recordStepCompleted("wfr_interrupt", {
      stepId: "done",
      inputHash: "hash:done",
      taskId: "task_done",
      result: { reportMarkdown: "done" },
      startedAt: "2026-05-29T00:00:01.000Z",
      completedAt: "2026-05-29T00:00:02.000Z",
    });

    let interruptCalls = 0;
    let statusDuringInterrupt: string | undefined;
    const service = new WorkflowService({
      definitionStore: new WorkflowDefinitionStore({
        projectRoot: path.join(tmp.path, "project"),
        globalRoot: path.join(tmp.path, "global"),
        builtIns: [],
      }),
      runStore,
      runtimeFactory: new QuickJSRuntimeFactory(),
      taskAdapter: {
        async runAgent() {
          throw new Error("unused");
        },
        async interruptRun() {
          statusDuringInterrupt = (await runStore.getRun("wfr_interrupt")).status;
          interruptCalls += 1;
        },
      },
      runnerId: "runner-a",
      clock: {
        nowIso: () => "2026-05-29T00:00:03.000Z",
        nowMs: () => 1_000,
      },
    });

    const interrupted = await service.interruptRun({
      workspaceId: "workspace-1",
      runId: "wfr_interrupt",
    });
    const completedStep = await runStore.getCompletedStep("wfr_interrupt", "done", "hash:done");

    expect(interrupted.status).toBe("interrupted");
    expect(interruptCalls).toBe(1);
    expect(statusDuringInterrupt).toBe("interrupted");
    expect(completedStep?.result).toEqual({ reportMarkdown: "done" });
  });

  test("interrupts foreground workflow runs when the caller aborts", async () => {
    using tmp = new DisposableTempDir("workflow-service");
    const projectRoot = path.join(tmp.path, "project", ".mux", "workflows");
    const globalRoot = path.join(tmp.path, "mux-home", "workflows");
    await writeWorkflow(
      globalRoot,
      "abortable",
      "export const metadata = { description: \"Abortable workflow\" };\nexport default function workflow({ agent }) { return agent({ id: 'slow-step', prompt: 'slow', outputSchema: {} }); }\n"
    );
    const runStore = new WorkflowRunStore({ sessionDir: tmp.path });
    let agentWaitStarted = false;
    let interruptCalls = 0;
    let agentAbortObserved = false;
    let abortObservedDuringInterrupt: boolean | undefined;
    let statusDuringAbortInterrupt: string | undefined;
    const service = new WorkflowService({
      definitionStore: new WorkflowDefinitionStore({ projectRoot, globalRoot, builtIns: [] }),
      runStore,
      runtimeFactory: new QuickJSRuntimeFactory(),
      taskAdapter: {
        async runAgent(_spec, _lifecycle, waitOptions) {
          agentWaitStarted = true;
          return await new Promise((_, reject) => {
            waitOptions?.abortSignal?.addEventListener(
              "abort",
              () => {
                agentAbortObserved = true;
                reject(new Error("Task interrupted"));
              },
              { once: true }
            );
          });
        },
        async interruptRun() {
          abortObservedDuringInterrupt = agentAbortObserved;
          statusDuringAbortInterrupt = (await runStore.getRun("wfr_abort")).status;
          interruptCalls += 1;
        },
      },
      generateRunId: () => "wfr_abort",
      runnerId: "runner-a",
    });
    const abortController = new AbortController();

    const runPromise = service.startNamedWorkflow({
      name: "abortable",
      workspaceId: "workspace-1",
      projectTrusted: false,
      args: {},
      abortSignal: abortController.signal,
    });
    await waitForCondition("foreground agent to start", () => agentWaitStarted);
    abortController.abort();

    await expect(runPromise).rejects.toThrow(/interrupted|aborted/i);
    await expect(runStore.getRun("wfr_abort")).resolves.toMatchObject({ status: "interrupted" });
    expect(interruptCalls).toBe(1);
    expect(abortObservedDuringInterrupt).toBe(true);
    expect(statusDuringAbortInterrupt).toBe("interrupted");
  });

  test("does not abort a running workflow from another workspace", async () => {
    using tmp = new DisposableTempDir("workflow-service");
    const projectRoot = path.join(tmp.path, "project", ".mux", "workflows");
    const globalRoot = path.join(tmp.path, "mux-home", "workflows");
    await writeWorkflow(
      globalRoot,
      "workspace-owned",
      "export const metadata = { description: \"Workspace-owned workflow\" };\nexport default function workflow({ agent }) { return agent({ id: 'slow-step', prompt: 'slow', outputSchema: {} }); }\n"
    );
    const runStore = new WorkflowRunStore({ sessionDir: tmp.path });
    let releaseAgent:
      | ((value: { taskId: string; reportMarkdown: string; structuredOutput: unknown }) => void)
      | undefined;
    let agentAbortObserved = false;
    const service = new WorkflowService({
      definitionStore: new WorkflowDefinitionStore({ projectRoot, globalRoot, builtIns: [] }),
      runStore,
      runtimeFactory: new QuickJSRuntimeFactory(),
      taskAdapter: {
        async runAgent(_spec, _lifecycle, waitOptions) {
          return await new Promise<{
            taskId: string;
            reportMarkdown: string;
            structuredOutput: unknown;
          }>((resolve, reject) => {
            releaseAgent = resolve;
            waitOptions?.abortSignal?.addEventListener(
              "abort",
              () => {
                agentAbortObserved = true;
                reject(new Error("Task interrupted"));
              },
              { once: true }
            );
          });
        },
      },
      generateRunId: () => "wfr_workspace_owned",
      runnerId: "runner-a",
    });
    const runPromise = service.startNamedWorkflow({
      name: "workspace-owned",
      workspaceId: "workspace-1",
      projectTrusted: false,
      args: {},
    });
    await waitForCondition("foreground agent to start", () => releaseAgent != null);

    await expect(
      service.interruptRun({ workspaceId: "workspace-2", runId: "wfr_workspace_owned" })
    ).rejects.toThrow("Workflow run not found: wfr_workspace_owned");

    expect(agentAbortObserved).toBe(false);
    releaseAgent?.({ taskId: "task_slow", reportMarkdown: "done", structuredOutput: {} });
    await expect(runPromise).resolves.toMatchObject({
      runId: "wfr_workspace_owned",
      status: "completed",
    });
  });

  test("interruptRun aborts an active foreground runner from another service instance", async () => {
    using tmp = new DisposableTempDir("workflow-service");
    const projectRoot = path.join(tmp.path, "project", ".mux", "workflows");
    const globalRoot = path.join(tmp.path, "mux-home", "workflows");
    await writeWorkflow(
      globalRoot,
      "interrupt-active",
      "export const metadata = { description: \"Interrupt active\" };\nexport default function workflow({ agent }) { return agent({ id: 'slow-step', prompt: 'slow', outputSchema: {} }); }\n"
    );
    const runStore = new WorkflowRunStore({ sessionDir: tmp.path });
    let agentWaitStarted = false;
    let agentAbortObserved = false;
    let interruptCalls = 0;
    const service = new WorkflowService({
      definitionStore: new WorkflowDefinitionStore({ projectRoot, globalRoot, builtIns: [] }),
      runStore,
      runtimeFactory: new QuickJSRuntimeFactory(),
      taskAdapter: {
        async runAgent(_spec, _lifecycle, waitOptions) {
          agentWaitStarted = true;
          return await new Promise((_, reject) => {
            waitOptions?.abortSignal?.addEventListener(
              "abort",
              () => {
                agentAbortObserved = true;
                reject(new Error("Task interrupted"));
              },
              { once: true }
            );
          });
        },
        async interruptRun() {
          throw new Error("starter service interruptRun should not be called");
        },
      },
      generateRunId: () => "wfr_interrupt_active",
      runnerId: "runner-a",
    });
    const interruptService = new WorkflowService({
      definitionStore: new WorkflowDefinitionStore({ projectRoot, globalRoot, builtIns: [] }),
      runStore,
      runtimeFactory: new QuickJSRuntimeFactory(),
      taskAdapter: {
        async runAgent() {
          throw new Error("interrupt service runAgent should not be called");
        },
        async interruptRun() {
          interruptCalls += 1;
        },
      },
      runnerId: "runner-b",
    });

    const runPromise = service.startNamedWorkflow({
      name: "interrupt-active",
      workspaceId: "workspace-1",
      projectTrusted: false,
      args: {},
    });
    const runErrorPromise = runPromise.then(
      () => null,
      (error: unknown) => error
    );
    await waitForCondition("foreground agent to start", () => agentWaitStarted);

    const interrupted = await interruptService.interruptRun({
      workspaceId: "workspace-1",
      runId: "wfr_interrupt_active",
    });

    expect(interrupted.status).toBe("interrupted");
    expect(agentAbortObserved).toBe(true);
    expect(interruptCalls).toBe(1);
    const runError = await runErrorPromise;
    expect(runError).toBeInstanceOf(Error);
    expect(runError instanceof Error ? runError.message : "").toMatch(/interrupted|aborted/i);
  });

  test("interruptRun cascades to an active nested child workflow", async () => {
    using tmp = new DisposableTempDir("workflow-service-nested-interrupt");
    const workspaceRoot = path.join(tmp.path, "project");
    const projectRoot = path.join(workspaceRoot, ".mux", "workflows");
    const globalRoot = path.join(tmp.path, "mux-home", "workflows");
    const actionProjectRoot = path.join(workspaceRoot, ".mux", "actions");
    const actionGlobalRoot = path.join(tmp.path, "mux-home", "actions");
    await writeWorkflow(
      globalRoot,
      "child-interruptible",
      "export const metadata = { description: \"Child interruptible\" };\nexport default function workflow({ agent }) { return agent({ id: 'slow-child', prompt: 'slow', outputSchema: {} }); }\n"
    );
    await writeWorkflow(
      globalRoot,
      "parent-interruptible",
      `export const metadata = { description: "Parent interruptible" };
export default function workflow({ action }) {
  return action.workflows.start({
    id: "child-interruptible",
    input: { name: "child-interruptible", args: {} },
  });
}\n`
    );
    const runStore = new WorkflowRunStore({ sessionDir: tmp.path });
    let agentWaitStarted = false;
    let agentAbortObserved = false;
    const starterService = new WorkflowService({
      definitionStore: new WorkflowDefinitionStore({ projectRoot, globalRoot, builtIns: [] }),
      actionRegistry: new WorkflowActionRegistry({
        projectRoot: actionProjectRoot,
        globalRoot: actionGlobalRoot,
      }),
      runStore,
      runtimeFactory: new QuickJSRuntimeFactory(),
      taskAdapter: {
        async runAgent(_spec, _lifecycle, waitOptions) {
          agentWaitStarted = true;
          return await new Promise((_, reject) => {
            waitOptions?.abortSignal?.addEventListener(
              "abort",
              () => {
                agentAbortObserved = true;
                reject(new Error("Task interrupted"));
              },
              { once: true }
            );
          });
        },
      },
      generateRunId: () => "wfr_nested_interrupt_parent",
      runnerId: "runner-a",
    });
    let interruptCalls = 0;
    const interruptService = new WorkflowService({
      definitionStore: new WorkflowDefinitionStore({ projectRoot, globalRoot, builtIns: [] }),
      actionRegistry: new WorkflowActionRegistry({
        projectRoot: actionProjectRoot,
        globalRoot: actionGlobalRoot,
      }),
      runStore,
      runtimeFactory: new QuickJSRuntimeFactory(),
      taskAdapter: {
        async runAgent() {
          throw new Error("interrupt service runAgent should not be called");
        },
        async interruptRun() {
          interruptCalls += 1;
        },
      },
      runnerId: "runner-b",
    });

    const runPromise = starterService.startNamedWorkflow({
      name: "parent-interruptible",
      workspaceId: "workspace-1",
      projectTrusted: true,
      args: {},
    });
    const runErrorPromise = runPromise.then(
      () => null,
      (error: unknown) => error
    );
    await waitForCondition("nested child agent to start", () => agentWaitStarted);

    const interrupted = await interruptService.interruptRun({
      workspaceId: "workspace-1",
      runId: "wfr_nested_interrupt_parent",
    });
    const parentRun = await runStore.getRun("wfr_nested_interrupt_parent");
    const childRunId = parentRun.steps.find(
      (step) => step.stepId === "child-interruptible"
    )?.taskId;
    if (childRunId == null) {
      throw new Error("Expected nested interrupt workflow to record a child run id");
    }
    const childRun = await runStore.getRun(childRunId);
    const runError = await runErrorPromise;

    expect(interrupted.status).toBe("interrupted");
    expect(childRun.status).toBe("interrupted");
    expect(agentAbortObserved).toBe(true);
    expect(interruptCalls).toBeGreaterThanOrEqual(1);
    expect(runError).toBeInstanceOf(Error);
    expect(runError instanceof Error ? runError.message : "").toMatch(/interrupted|aborted/i);
  });

  test("interruptRun still interrupts tasks for already-interrupted nested children", async () => {
    using tmp = new DisposableTempDir("workflow-service-nested-interrupted-task-cascade");
    const runStore = new WorkflowRunStore({ sessionDir: tmp.path });
    await runStore.createRun({
      id: "wfr_parent_interrupted_child_task",
      workspaceId: "workspace-1",
      definition: { name: "parent", description: "Parent", scope: "built-in", executable: true },
      definitionSource:
        "export default function workflow() { return { reportMarkdown: 'parent' }; }\n",
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    await runStore.appendStatus(
      "wfr_parent_interrupted_child_task",
      "running",
      "2026-05-29T00:00:01.000Z"
    );
    await runStore.createRun({
      id: "wfr_child_already_interrupted",
      workspaceId: "workspace-1",
      definition: { name: "child", description: "Child", scope: "built-in", executable: true },
      definitionSource:
        "export default function workflow() { return { reportMarkdown: 'child' }; }\n",
      args: {},
      parentWorkflow: {
        runId: "wfr_parent_interrupted_child_task",
        stepId: "child",
        inputHash: "hash:child",
        depth: 0,
      },
      now: "2026-05-29T00:00:00.000Z",
    });
    await runStore.appendStatus(
      "wfr_child_already_interrupted",
      "running",
      "2026-05-29T00:00:01.000Z"
    );
    await runStore.appendStatus(
      "wfr_child_already_interrupted",
      "interrupted",
      "2026-05-29T00:00:02.000Z"
    );
    const interruptedTaskAdapters: string[] = [];
    const service = new WorkflowService({
      definitionStore: new WorkflowDefinitionStore({
        projectRoot: path.join(tmp.path, "project"),
        globalRoot: path.join(tmp.path, "global"),
        builtIns: [],
      }),
      runStore,
      runtimeFactory: new QuickJSRuntimeFactory(),
      taskAdapterFactory: (runId) => ({
        async runAgent() {
          throw new Error("agent should not run");
        },
        async interruptRun() {
          interruptedTaskAdapters.push(runId);
        },
      }),
      runnerId: "runner-a",
    });

    await service.interruptRun({
      workspaceId: "workspace-1",
      runId: "wfr_parent_interrupted_child_task",
    });

    expect(interruptedTaskAdapters).toContain("wfr_child_already_interrupted");
  });

  test("interruptRun aborts an active nested child workflow by child run id", async () => {
    using tmp = new DisposableTempDir("workflow-service-nested-direct-interrupt");
    const workspaceRoot = path.join(tmp.path, "project");
    const projectRoot = path.join(workspaceRoot, ".mux", "workflows");
    const globalRoot = path.join(tmp.path, "mux-home", "workflows");
    const actionProjectRoot = path.join(workspaceRoot, ".mux", "actions");
    const actionGlobalRoot = path.join(tmp.path, "mux-home", "actions");
    await writeWorkflow(
      globalRoot,
      "child-direct-interruptible",
      "export const metadata = { description: \"Child direct interruptible\" };\nexport default function workflow({ agent }) { return agent({ id: 'slow-child', prompt: 'slow', outputSchema: {} }); }\n"
    );
    await writeWorkflow(
      globalRoot,
      "parent-direct-interruptible",
      `export const metadata = { description: "Parent direct interruptible" };
export default function workflow({ action }) {
  return action.workflows.start({
    id: "child-direct-interruptible",
    input: { name: "child-direct-interruptible", args: {} },
  });
}\n`
    );
    const runStore = new WorkflowRunStore({ sessionDir: tmp.path });
    let agentWaitStarted = false;
    let agentAbortObserved = false;
    const starterService = new WorkflowService({
      definitionStore: new WorkflowDefinitionStore({ projectRoot, globalRoot, builtIns: [] }),
      actionRegistry: new WorkflowActionRegistry({
        projectRoot: actionProjectRoot,
        globalRoot: actionGlobalRoot,
      }),
      runStore,
      runtimeFactory: new QuickJSRuntimeFactory(),
      taskAdapter: {
        async runAgent(_spec, _lifecycle, waitOptions) {
          agentWaitStarted = true;
          return await new Promise((_, reject) => {
            waitOptions?.abortSignal?.addEventListener(
              "abort",
              () => {
                agentAbortObserved = true;
                reject(new Error("Task interrupted"));
              },
              { once: true }
            );
          });
        },
      },
      generateRunId: () => "wfr_nested_direct_interrupt_parent",
      runnerId: "runner-a",
    });
    const interruptService = new WorkflowService({
      definitionStore: new WorkflowDefinitionStore({ projectRoot, globalRoot, builtIns: [] }),
      actionRegistry: new WorkflowActionRegistry({
        projectRoot: actionProjectRoot,
        globalRoot: actionGlobalRoot,
      }),
      runStore,
      runtimeFactory: new QuickJSRuntimeFactory(),
      taskAdapter: {
        async runAgent() {
          throw new Error("interrupt service runAgent should not be called");
        },
        async interruptRun() {
          // child task adapter interrupt is supplementary; the child workflow runtime must
          // also abort through the active child runner controller.
        },
      },
      runnerId: "runner-b",
    });

    const runPromise = starterService.startNamedWorkflow({
      name: "parent-direct-interruptible",
      workspaceId: "workspace-1",
      projectTrusted: true,
      args: {},
    });
    const runErrorPromise = runPromise.then(
      () => null,
      (error: unknown) => error
    );
    await waitForCondition("nested child agent to start", () => agentWaitStarted);
    const parentRun = await runStore.getRun("wfr_nested_direct_interrupt_parent");
    const childRunId = parentRun.steps.find(
      (step) => step.stepId === "child-direct-interruptible"
    )?.taskId;
    if (childRunId == null) {
      throw new Error("Expected direct interrupt workflow to record a child run id");
    }

    const interrupted = await interruptService.interruptRun({
      workspaceId: "workspace-1",
      runId: childRunId,
    });
    const runError = await runErrorPromise;

    expect(interrupted.status).toBe("interrupted");
    expect(agentAbortObserved).toBe(true);
    expect(runError).toBeInstanceOf(Error);
  });

  test("backgrounds and resumes parent workflows when a nested child workflow backgrounds", async () => {
    using tmp = new DisposableTempDir("workflow-service-nested-background");
    const workspaceRoot = path.join(tmp.path, "project");
    const projectRoot = path.join(workspaceRoot, ".mux", "workflows");
    const globalRoot = path.join(tmp.path, "mux-home", "workflows");
    const actionProjectRoot = path.join(workspaceRoot, ".mux", "actions");
    const actionGlobalRoot = path.join(tmp.path, "mux-home", "actions");
    await writeWorkflow(
      globalRoot,
      "child-backgroundable",
      "export const metadata = { description: \"Child backgroundable\" };\nexport default function workflow({ agent }) { const result = agent({ id: 'slow-child', prompt: 'slow', outputSchema: {} }); return { reportMarkdown: 'Child ' + result.reportMarkdown }; }\n"
    );
    await writeWorkflow(
      globalRoot,
      "parent-backgroundable",
      `export const metadata = { description: "Parent backgroundable" };
export default function workflow({ action }) {
  const child = action.workflows.start({
    id: "child-backgroundable",
    input: { name: "child-backgroundable", args: {} },
  });
  return { reportMarkdown: "Parent " + child.reportMarkdown };
}\n`
    );
    const runStore = new WorkflowRunStore({ sessionDir: tmp.path });
    let calls = 0;
    const backgroundFlags: Array<boolean | undefined> = [];
    const service = new WorkflowService({
      definitionStore: new WorkflowDefinitionStore({ projectRoot, globalRoot, builtIns: [] }),
      actionRegistry: new WorkflowActionRegistry({
        projectRoot: actionProjectRoot,
        globalRoot: actionGlobalRoot,
      }),
      runStore,
      runtimeFactory: new QuickJSRuntimeFactory(),
      taskAdapter: {
        async runAgent(_spec, _lifecycle, waitOptions) {
          calls += 1;
          backgroundFlags.push(waitOptions?.backgroundOnMessageQueued);
          if (calls === 1) {
            throw new ForegroundWaitBackgroundedError();
          }
          return { taskId: "task_slow_child", reportMarkdown: "done", structuredOutput: {} };
        },
      },
      generateRunId: () => "wfr_nested_background_parent",
      runnerId: "runner-a",
    });

    const result = await service.startNamedWorkflow({
      name: "parent-backgroundable",
      workspaceId: "workspace-1",
      projectTrusted: true,
      args: {},
    });

    expect(result).toEqual({
      runId: "wfr_nested_background_parent",
      status: "backgrounded",
      result: null,
    });
    await waitForWorkflowStatus(runStore, "wfr_nested_background_parent", "completed");
    const parentRun = await runStore.getRun("wfr_nested_background_parent");
    const childRunId = parentRun.steps.find(
      (step) => step.stepId === "child-backgroundable"
    )?.taskId;
    if (childRunId == null) {
      throw new Error("Expected nested background workflow to record a child run id");
    }
    const childRun = await runStore.getRun(childRunId);

    expect(childRun.status).toBe("completed");
    expect(parentRun.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "workflow", status: "backgrounded", runId: childRunId }),
        expect.objectContaining({ type: "workflow", status: "completed", runId: childRunId }),
      ])
    );
    expect(backgroundFlags).toEqual([true, false]);
  });

  test("moves foreground workflow runs to background when child waits are backgrounded", async () => {
    using tmp = new DisposableTempDir("workflow-service");
    const projectRoot = path.join(tmp.path, "project", ".mux", "workflows");
    const globalRoot = path.join(tmp.path, "mux-home", "workflows");
    await writeWorkflow(
      globalRoot,
      "backgroundable",
      "export const metadata = { description: \"Backgroundable workflow\" };\nexport default function workflow({ agent }) { return agent({ id: 'slow-step', prompt: 'slow', outputSchema: {} }); }\n"
    );
    const runStore = new WorkflowRunStore({ sessionDir: tmp.path });
    let calls = 0;
    const backgroundFlags: Array<boolean | undefined> = [];
    const statusEvents: Array<{ workspaceId: string; runId: string; status: string }> = [];
    const service = new WorkflowService({
      definitionStore: new WorkflowDefinitionStore({ projectRoot, globalRoot, builtIns: [] }),
      runStore,
      onRunStatusChanged: (event) => {
        statusEvents.push(event);
      },
      runtimeFactory: new QuickJSRuntimeFactory(),
      taskAdapter: {
        async runAgent(_spec, _lifecycle, waitOptions) {
          calls += 1;
          backgroundFlags.push(waitOptions?.backgroundOnMessageQueued);
          if (calls === 1) {
            throw new ForegroundWaitBackgroundedError();
          }
          return { taskId: "task_slow", reportMarkdown: "done", structuredOutput: {} };
        },
      },
      generateRunId: () => "wfr_backgrounded",
      runnerId: "runner-a",
    });

    const result = await service.startNamedWorkflow({
      name: "backgroundable",
      workspaceId: "workspace-1",
      projectTrusted: false,
      args: {},
    });

    expect(result).toEqual({ runId: "wfr_backgrounded", status: "backgrounded", result: null });
    await waitForWorkflowStatus(runStore, "wfr_backgrounded", "completed");
    await waitForWorkflowRunFileStatus(tmp.path, "wfr_backgrounded", "completed");
    expect(calls).toBe(2);
    expect(backgroundFlags).toEqual([true, false]);
    await waitForCondition("backgrounded workflow status events", () => statusEvents.length === 3);
    expect(statusEvents).toEqual([
      { workspaceId: "workspace-1", runId: "wfr_backgrounded", status: "pending" },
      { workspaceId: "workspace-1", runId: "wfr_backgrounded", status: "backgrounded" },
      { workspaceId: "workspace-1", runId: "wfr_backgrounded", status: "completed" },
    ]);
  });

  test("can keep foreground workflow waits in the foreground", async () => {
    using tmp = new DisposableTempDir("workflow-service");
    const projectRoot = path.join(tmp.path, "project", ".mux", "workflows");
    const globalRoot = path.join(tmp.path, "mux-home", "workflows");
    await writeWorkflow(
      globalRoot,
      "foreground-only",
      "export const metadata = { description: \"Foreground-only workflow\" };\nexport default function workflow({ agent }) { return agent({ id: 'slow-step', prompt: 'slow', outputSchema: {} }); }\n"
    );
    const backgroundFlags: Array<boolean | undefined> = [];
    const service = new WorkflowService({
      definitionStore: new WorkflowDefinitionStore({ projectRoot, globalRoot, builtIns: [] }),
      runStore: new WorkflowRunStore({ sessionDir: tmp.path }),
      runtimeFactory: new QuickJSRuntimeFactory(),
      taskAdapter: {
        async runAgent(_spec, _lifecycle, waitOptions) {
          backgroundFlags.push(waitOptions?.backgroundOnMessageQueued);
          return { taskId: "task_slow", reportMarkdown: "done", structuredOutput: {} };
        },
      },
      generateRunId: () => "wfr_foreground_only",
      runnerId: "runner-a",
    });

    const result = await service.startNamedWorkflow({
      name: "foreground-only",
      workspaceId: "workspace-1",
      projectTrusted: false,
      args: {},
      backgroundOnMessageQueued: false,
    });

    expect(result).toMatchObject({
      runId: "wfr_foreground_only",
      status: "completed",
      result: { reportMarkdown: "done" },
    });
    expect(backgroundFlags).toEqual([false]);
  });

  test("resumes the same run id and reuses completed steps", async () => {
    using tmp = new DisposableTempDir("workflow-service");
    const runStore = new WorkflowRunStore({ sessionDir: tmp.path });
    const source = `export default function workflow({ agent }) {
  const first = agent({ id: "first", prompt: "first", outputSchema: {} });
  const second = agent({ id: "second", prompt: "second", outputSchema: {} });
  return { reportMarkdown: first.reportMarkdown + " + " + second.reportMarkdown };
}
`;
    await runStore.createRun({
      id: "wfr_resume",
      workspaceId: "workspace-1",
      definition: { name: "demo", description: "Demo", scope: "built-in", executable: true },
      definitionSource: source,
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    await runStore.recordStepCompleted("wfr_resume", {
      stepId: "first",
      inputHash: hashWorkflowStepInput("first", { id: "first", prompt: "first", outputSchema: {} }),
      taskId: "task_first",
      result: { reportMarkdown: "first done" },
      startedAt: "2026-05-29T00:00:01.000Z",
      completedAt: "2026-05-29T00:00:02.000Z",
    });
    await runStore.appendEvent("wfr_resume", {
      sequence: 1,
      type: "status",
      at: "2026-05-29T00:00:03.000Z",
      status: "interrupted",
    });

    const taskCalls: string[] = [];
    const service = new WorkflowService({
      definitionStore: new WorkflowDefinitionStore({
        projectRoot: path.join(tmp.path, "project"),
        globalRoot: path.join(tmp.path, "global"),
        builtIns: [],
      }),
      runStore,
      runtimeFactory: new QuickJSRuntimeFactory(),
      taskAdapter: {
        async runAgent(spec) {
          taskCalls.push(spec.id);
          return {
            taskId: `task_${spec.id}`,
            reportMarkdown: `${spec.id} done`,
            structuredOutput: {},
          };
        },
      },
      runnerId: "runner-a",
      clock: {
        nowIso: () => "2026-05-29T00:00:04.000Z",
        nowMs: () => 1_000,
      },
    });

    const result = await service.resumeRun({
      workspaceId: "workspace-1",
      runId: "wfr_resume",
      projectTrusted: true,
    });

    expect(result).toEqual({
      runId: "wfr_resume",
      status: "completed",
      result: { reportMarkdown: "first done + second done" },
    });
    expect(taskCalls).toEqual(["second"]);
  });

  test("resumes crash-orphaned running workflow runs", async () => {
    using tmp = new DisposableTempDir("workflow-service");
    const runStore = new WorkflowRunStore({ sessionDir: tmp.path });
    await runStore.createRun({
      id: "wfr_resume_running_orphan",
      workspaceId: "workspace-1",
      definition: { name: "demo", description: "Demo", scope: "built-in", executable: true },
      definitionSource:
        "export default function workflow({ agent }) { return agent({ id: 'orphaned-step', prompt: 'resume', outputSchema: {} }); }\n",
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    await runStore.appendStatus("wfr_resume_running_orphan", "running", "2026-05-29T00:00:01.000Z");

    const taskCalls: string[] = [];
    const service = new WorkflowService({
      definitionStore: new WorkflowDefinitionStore({
        projectRoot: path.join(tmp.path, "project"),
        globalRoot: path.join(tmp.path, "global"),
        builtIns: [],
      }),
      runStore,
      runtimeFactory: new QuickJSRuntimeFactory(),
      taskAdapter: {
        async runAgent(spec) {
          taskCalls.push(spec.id);
          return { taskId: `task_${spec.id}`, reportMarkdown: "resumed", structuredOutput: {} };
        },
      },
      runnerId: "runner-a",
    });

    await expect(
      service.resumeRun({
        workspaceId: "workspace-1",
        runId: "wfr_resume_running_orphan",
        projectTrusted: true,
      })
    ).resolves.toEqual({
      runId: "wfr_resume_running_orphan",
      status: "completed",
      result: { reportMarkdown: "resumed", structuredOutput: {} },
    });
    expect(taskCalls).toEqual(["orphaned-step"]);
  });

  test("resumes crash-orphaned backgrounded workflow runs in the background", async () => {
    using tmp = new DisposableTempDir("workflow-service");
    const runStore = new WorkflowRunStore({ sessionDir: tmp.path });
    await runStore.createRun({
      id: "wfr_resume_backgrounded_orphan",
      workspaceId: "workspace-1",
      definition: { name: "demo", description: "Demo", scope: "built-in", executable: true },
      definitionSource:
        "export default function workflow({ agent }) { return agent({ id: 'backgrounded-step', prompt: 'resume', outputSchema: {} }); }\n",
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    await runStore.appendStatus(
      "wfr_resume_backgrounded_orphan",
      "backgrounded",
      "2026-05-29T00:00:01.000Z"
    );

    const taskCalls: string[] = [];
    const service = new WorkflowService({
      definitionStore: new WorkflowDefinitionStore({
        projectRoot: path.join(tmp.path, "project"),
        globalRoot: path.join(tmp.path, "global"),
        builtIns: [],
      }),
      runStore,
      runtimeFactory: new QuickJSRuntimeFactory(),
      taskAdapter: {
        async runAgent(spec) {
          taskCalls.push(spec.id);
          return { taskId: `task_${spec.id}`, reportMarkdown: "resumed", structuredOutput: {} };
        },
      },
      runnerId: "runner-a",
    });

    await expect(
      service.resumeRunInBackground({
        workspaceId: "workspace-1",
        runId: "wfr_resume_backgrounded_orphan",
        projectTrusted: true,
      })
    ).resolves.toEqual({
      runId: "wfr_resume_backgrounded_orphan",
      status: "running",
      result: null,
    });
    await waitForWorkflowStatus(runStore, "wfr_resume_backgrounded_orphan", "completed");
    expect(taskCalls).toEqual(["backgrounded-step"]);
  });

  test("keeps resumed workflow running when foreground wait backgrounds", async () => {
    using tmp = new DisposableTempDir("workflow-service");
    const runStore = new WorkflowRunStore({ sessionDir: tmp.path });
    await runStore.createRun({
      id: "wfr_resume_backgrounded",
      workspaceId: "workspace-1",
      definition: { name: "demo", description: "Demo", scope: "built-in", executable: true },
      definitionSource:
        "export default function workflow({ agent }) { return agent({ id: 'slow-step', prompt: 'slow', outputSchema: {} }); }\n",
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    await runStore.appendStatus(
      "wfr_resume_backgrounded",
      "interrupted",
      "2026-05-29T00:00:01.000Z"
    );

    let calls = 0;
    const backgroundFlags: Array<boolean | undefined> = [];
    const service = new WorkflowService({
      definitionStore: new WorkflowDefinitionStore({
        projectRoot: path.join(tmp.path, "project"),
        globalRoot: path.join(tmp.path, "global"),
        builtIns: [],
      }),
      runStore,
      runtimeFactory: new QuickJSRuntimeFactory(),
      taskAdapter: {
        async runAgent(_spec, _lifecycle, waitOptions) {
          calls += 1;
          backgroundFlags.push(waitOptions?.backgroundOnMessageQueued);
          if (calls === 1) {
            throw new ForegroundWaitBackgroundedError();
          }
          return { taskId: "task_slow", reportMarkdown: "done", structuredOutput: {} };
        },
      },
      runnerId: "runner-a",
    });

    const result = await service.resumeRun({
      workspaceId: "workspace-1",
      runId: "wfr_resume_backgrounded",
      projectTrusted: true,
    });

    expect(result).toEqual({
      runId: "wfr_resume_backgrounded",
      status: "backgrounded",
      result: null,
    });
    await waitForWorkflowStatus(runStore, "wfr_resume_backgrounded", "completed");
    expect(calls).toBe(2);
    expect(backgroundFlags).toEqual([true, false]);
  });

  test("does not revert a concurrent interrupt when a self-backgrounded resume continuation starts", async () => {
    using tmp = new DisposableTempDir("workflow-service");
    const runStore = new WorkflowRunStore({ sessionDir: tmp.path });
    await runStore.createRun({
      id: "wfr_resume_interrupt_race",
      workspaceId: "workspace-1",
      definition: { name: "demo", description: "Demo", scope: "built-in", executable: true },
      definitionSource:
        "export default function workflow({ agent }) { return agent({ id: 'slow-step', prompt: 'slow', outputSchema: {} }); }\n",
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    await runStore.appendStatus(
      "wfr_resume_interrupt_race",
      "interrupted",
      "2026-05-29T00:00:01.000Z"
    );

    // Hold the self-backgrounding continuation at its lease acquisition (the second acquire;
    // the first is the foreground resume) so interruptRun deterministically lands before the
    // continuation reads the run status. Forwarding allowResumeFromInterrupted to the
    // continuation used to let it silently revert that interrupt back to "running".
    let leaseCalls = 0;
    let continuationDone = false;
    const continuationGate = Promise.withResolvers<void>();
    const acquireLease = runStore.acquireLease.bind(runStore);
    runStore.acquireLease = async (runId, ownerId, nowMs) => {
      leaseCalls += 1;
      if (leaseCalls > 1) {
        await continuationGate.promise;
      }
      return await acquireLease(runId, ownerId, nowMs);
    };
    const releaseLease = runStore.releaseLease.bind(runStore);
    runStore.releaseLease = async (runId, ownerId) => {
      await releaseLease(runId, ownerId);
      if (leaseCalls > 1) {
        continuationDone = true;
      }
    };

    let agentCalls = 0;
    const service = new WorkflowService({
      definitionStore: new WorkflowDefinitionStore({
        projectRoot: path.join(tmp.path, "project"),
        globalRoot: path.join(tmp.path, "global"),
        builtIns: [],
      }),
      runStore,
      runtimeFactory: new QuickJSRuntimeFactory(),
      taskAdapter: {
        async runAgent() {
          agentCalls += 1;
          if (agentCalls === 1) {
            throw new ForegroundWaitBackgroundedError();
          }
          return { taskId: "task_slow", reportMarkdown: "done", structuredOutput: {} };
        },
      },
      runnerId: "runner-a",
    });

    const result = await service.resumeRun({
      workspaceId: "workspace-1",
      runId: "wfr_resume_interrupt_race",
      projectTrusted: true,
    });
    expect(result).toEqual({
      runId: "wfr_resume_interrupt_race",
      status: "backgrounded",
      result: null,
    });

    await service.interruptRun({
      workspaceId: "workspace-1",
      runId: "wfr_resume_interrupt_race",
    });
    continuationGate.resolve();

    await waitForCondition("self-backgrounded continuation to settle", () => continuationDone);
    // The interrupt must win: the continuation has no resume permission, so it must refuse to
    // re-run the workflow instead of transitioning the run back to "running".
    await expect(runStore.getRun("wfr_resume_interrupt_race")).resolves.toMatchObject({
      status: "interrupted",
    });
    expect(agentCalls).toBe(1);
  });

  test("rejects resume when the caller is already aborted without touching run state", async () => {
    using tmp = new DisposableTempDir("workflow-service");
    const runStore = new WorkflowRunStore({ sessionDir: tmp.path });
    await runStore.createRun({
      id: "wfr_resume_preaborted",
      workspaceId: "workspace-1",
      definition: { name: "demo", description: "Demo", scope: "built-in", executable: true },
      definitionSource:
        "export default function workflow({ agent }) { return agent({ id: 'step', prompt: 'p', outputSchema: {} }); }\n",
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    await runStore.appendStatus("wfr_resume_preaborted", "interrupted", "2026-05-29T00:00:01.000Z");

    const service = new WorkflowService({
      definitionStore: new WorkflowDefinitionStore({
        projectRoot: path.join(tmp.path, "project"),
        globalRoot: path.join(tmp.path, "global"),
        builtIns: [],
      }),
      runStore,
      runtimeFactory: new QuickJSRuntimeFactory(),
      taskAdapter: {
        async runAgent() {
          throw new Error("runner must not start for a pre-aborted resume");
        },
      },
      runnerId: "runner-a",
    });
    const abortController = new AbortController();
    abortController.abort();

    await expect(
      service.resumeRun({
        workspaceId: "workspace-1",
        runId: "wfr_resume_preaborted",
        projectTrusted: true,
        abortSignal: abortController.signal,
      })
    ).rejects.toThrow("Workflow run interrupted: wfr_resume_preaborted");
    // The run must stay resumable: no status churn from the rejected resume.
    await expect(runStore.getRun("wfr_resume_preaborted")).resolves.toMatchObject({
      status: "interrupted",
    });
  });

  test("keeps aborted resumes interrupted when abort wins before running status append", async () => {
    using tmp = new DisposableTempDir("workflow-service");
    const runStore = new WorkflowRunStore({ sessionDir: tmp.path });
    const runId = "wfr_resume_abort_before_running";
    await runStore.createRun({
      id: runId,
      workspaceId: "workspace-1",
      definition: { name: "demo", description: "Demo", scope: "built-in", executable: true },
      definitionSource:
        "export default function workflow() { return { reportMarkdown: 'done' }; }\n",
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    await runStore.appendStatus(runId, "interrupted", "2026-05-29T00:00:01.000Z");

    const abortController = new AbortController();
    const appendNextEvent = runStore.appendNextEvent.bind(runStore);
    let abortedBeforeRunningAppend = false;
    runStore.appendNextEvent = async (...args: Parameters<WorkflowRunStore["appendNextEvent"]>) => {
      const [eventRunId, event] = args;
      if (
        !abortedBeforeRunningAppend &&
        eventRunId === runId &&
        event.type === "status" &&
        event.status === "running"
      ) {
        abortedBeforeRunningAppend = true;
        abortController.abort();
        await waitForWorkflowStatus(runStore, runId, "interrupted");
      }
      return await appendNextEvent(...args);
    };

    const service = new WorkflowService({
      definitionStore: new WorkflowDefinitionStore({
        projectRoot: path.join(tmp.path, "project"),
        globalRoot: path.join(tmp.path, "global"),
        builtIns: [],
      }),
      runStore,
      runtimeFactory: new QuickJSRuntimeFactory(),
      taskAdapter: {
        async runAgent() {
          throw new Error("aborted workflow must not start child agents");
        },
      },
      runnerId: "runner-a",
    });

    await expect(
      service.resumeRun({
        workspaceId: "workspace-1",
        runId,
        projectTrusted: true,
        abortSignal: abortController.signal,
      })
    ).rejects.toThrow(/interrupted|aborted/i);
    expect(abortedBeforeRunningAppend).toBe(true);
    await expect(runStore.getRun(runId)).resolves.toMatchObject({ status: "interrupted" });
  });

  test("interrupts resumed foreground workflow runs when the caller aborts", async () => {
    using tmp = new DisposableTempDir("workflow-service");
    const runStore = new WorkflowRunStore({ sessionDir: tmp.path });
    await runStore.createRun({
      id: "wfr_resume_abort",
      workspaceId: "workspace-1",
      definition: { name: "demo", description: "Demo", scope: "built-in", executable: true },
      definitionSource:
        "export default function workflow({ agent }) { return agent({ id: 'slow-step', prompt: 'slow', outputSchema: {} }); }\n",
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    await runStore.appendStatus("wfr_resume_abort", "interrupted", "2026-05-29T00:00:01.000Z");

    let agentWaitStarted = false;
    let interruptCalls = 0;
    const service = new WorkflowService({
      definitionStore: new WorkflowDefinitionStore({
        projectRoot: path.join(tmp.path, "project"),
        globalRoot: path.join(tmp.path, "global"),
        builtIns: [],
      }),
      runStore,
      runtimeFactory: new QuickJSRuntimeFactory(),
      taskAdapter: {
        async runAgent(_spec, _lifecycle, waitOptions) {
          agentWaitStarted = true;
          return await new Promise((_, reject) => {
            waitOptions?.abortSignal?.addEventListener(
              "abort",
              () => reject(new Error("Task interrupted")),
              { once: true }
            );
          });
        },
        async interruptRun() {
          interruptCalls += 1;
        },
      },
      runnerId: "runner-a",
    });
    const abortController = new AbortController();

    const resumePromise = service.resumeRun({
      workspaceId: "workspace-1",
      runId: "wfr_resume_abort",
      projectTrusted: true,
      abortSignal: abortController.signal,
    });
    await waitForCondition("resumed foreground agent to start", () => agentWaitStarted);
    abortController.abort();

    await expect(resumePromise).rejects.toThrow(/interrupted|aborted/i);
    await expect(runStore.getRun("wfr_resume_abort")).resolves.toMatchObject({
      status: "interrupted",
    });
    expect(interruptCalls).toBe(1);
  });

  test("retries recoverable failed workflows from their checkpoint in the foreground", async () => {
    using tmp = new DisposableTempDir("workflow-service");
    const runStore = new WorkflowRunStore({ sessionDir: tmp.path });
    await runStore.createRun({
      id: "wfr_retry_checkpoint_fg",
      workspaceId: "workspace-1",
      definition: {
        name: "deep-research",
        description: "Deep research",
        scope: "built-in",
        executable: true,
      },
      definitionSource:
        "export default function workflow({ agent }) { const child = agent({ id: 'summarize-topic', prompt: 'Summarize durable workflows', outputSchema: {} }); return { reportMarkdown: 'Final: ' + child.reportMarkdown }; }\n",
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    const spec = { id: "summarize-topic", prompt: "Summarize durable workflows", outputSchema: {} };
    await runStore.recordStepStarted("wfr_retry_checkpoint_fg", {
      stepId: spec.id,
      inputHash: hashWorkflowStepInput(spec.id, spec),
      taskId: "task_existing",
      startedAt: "2026-05-29T00:00:00.500Z",
    });
    await runStore.appendEvent("wfr_retry_checkpoint_fg", {
      sequence: 1,
      type: "error",
      at: "2026-05-29T00:00:00.750Z",
      message: "Execution interrupted",
    });
    await runStore.appendStatus("wfr_retry_checkpoint_fg", "failed", "2026-05-29T00:00:00.751Z");

    const waitedFor: string[] = [];
    const service = new WorkflowService({
      definitionStore: new WorkflowDefinitionStore({
        projectRoot: path.join(tmp.path, "project"),
        globalRoot: path.join(tmp.path, "global"),
        builtIns: [],
      }),
      runStore,
      runtimeFactory: new QuickJSRuntimeFactory(),
      taskAdapter: {
        async runAgent() {
          throw new Error("retry should harvest existing task before spawning replacement");
        },
        async waitForAgentTask(taskId) {
          waitedFor.push(taskId);
          return { taskId, reportMarkdown: "summary", structuredOutput: {} };
        },
      },
      runnerId: "runner-a",
      clock: {
        nowIso: () => "2026-05-29T00:00:01.000Z",
        nowMs: () => 1_000,
      },
    });

    await expect(
      service.retryRunFromCheckpoint({
        workspaceId: "workspace-1",
        runId: "wfr_retry_checkpoint_fg",
        projectTrusted: true,
      })
    ).resolves.toEqual({
      runId: "wfr_retry_checkpoint_fg",
      status: "completed",
      result: { reportMarkdown: "Final: summary" },
    });
    expect(waitedFor).toEqual(["task_existing"]);
    await expect(runStore.getRun("wfr_retry_checkpoint_fg")).resolves.toMatchObject({
      status: "completed",
    });
  });

  test("foreground checkpoint retry rejects non-recoverable failed workflows", async () => {
    using tmp = new DisposableTempDir("workflow-service");
    const runStore = new WorkflowRunStore({ sessionDir: tmp.path });
    await runStore.createRun({
      id: "wfr_retry_unsafe_fg",
      workspaceId: "workspace-1",
      definition: { name: "demo", description: "Demo", scope: "built-in", executable: true },
      definitionSource:
        "export default function workflow({ applyPatch }) { return applyPatch({ id: 'patch', taskId: 't' }); }\n",
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    // An unfinished patch event makes checkpoint retry unsafe (side effects may have landed).
    await runStore.appendEvent("wfr_retry_unsafe_fg", {
      sequence: 1,
      type: "patch",
      at: "2026-05-29T00:00:00.400Z",
      stepId: "patch",
      sourceTaskId: "t",
      status: "started",
    });
    await runStore.appendStatus("wfr_retry_unsafe_fg", "failed", "2026-05-29T00:00:00.500Z");

    const service = new WorkflowService({
      definitionStore: new WorkflowDefinitionStore({
        projectRoot: path.join(tmp.path, "project"),
        globalRoot: path.join(tmp.path, "global"),
        builtIns: [],
      }),
      runStore,
      runtimeFactory: new QuickJSRuntimeFactory(),
      taskAdapter: {
        async runAgent() {
          throw new Error("unsafe retry must not start a runner");
        },
      },
      runnerId: "runner-a",
    });

    await expect(
      service.retryRunFromCheckpoint({
        workspaceId: "workspace-1",
        runId: "wfr_retry_unsafe_fg",
        projectTrusted: true,
      })
    ).rejects.toThrow(/cannot be retried from checkpoint/i);
    await expect(runStore.getRun("wfr_retry_unsafe_fg")).resolves.toMatchObject({
      status: "failed",
    });
  });

  test("retries recoverable failed workflows from their checkpoint in the background", async () => {
    using tmp = new DisposableTempDir("workflow-service");
    const runStore = new WorkflowRunStore({ sessionDir: tmp.path });
    await runStore.createRun({
      id: "wfr_retry_checkpoint",
      workspaceId: "workspace-1",
      definition: {
        name: "deep-research",
        description: "Deep research",
        scope: "built-in",
        executable: true,
      },
      definitionSource:
        "export default function workflow({ agent }) { const child = agent({ id: 'summarize-topic', prompt: 'Summarize durable workflows', outputSchema: {} }); return { reportMarkdown: 'Final: ' + child.reportMarkdown }; }\n",
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    const spec = { id: "summarize-topic", prompt: "Summarize durable workflows", outputSchema: {} };
    await runStore.recordStepStarted("wfr_retry_checkpoint", {
      stepId: spec.id,
      inputHash: hashWorkflowStepInput(spec.id, spec),
      taskId: "task_existing",
      startedAt: "2026-05-29T00:00:00.500Z",
    });
    await runStore.appendEvent("wfr_retry_checkpoint", {
      sequence: 1,
      type: "error",
      at: "2026-05-29T00:00:00.750Z",
      message: "Execution interrupted",
    });
    await runStore.appendStatus("wfr_retry_checkpoint", "failed", "2026-05-29T00:00:00.751Z");

    let releaseExistingTask!: () => void;
    const existingTaskReleased = new Promise<void>((resolve) => {
      releaseExistingTask = resolve;
    });
    const waitedFor: string[] = [];
    const service = new WorkflowService({
      definitionStore: new WorkflowDefinitionStore({
        projectRoot: path.join(tmp.path, "project"),
        globalRoot: path.join(tmp.path, "global"),
        builtIns: [],
      }),
      runStore,
      runtimeFactory: new QuickJSRuntimeFactory(),
      taskAdapter: {
        async runAgent() {
          throw new Error("retry should harvest existing task before spawning replacement");
        },
        async waitForAgentTask(taskId) {
          waitedFor.push(taskId);
          await existingTaskReleased;
          return { taskId, reportMarkdown: "summary", structuredOutput: {} };
        },
      },
      runnerId: "runner-a",
      clock: {
        nowIso: () => "2026-05-29T00:00:01.000Z",
        nowMs: () => 1_000,
      },
    });

    await expect(
      service.retryRunFromCheckpointInBackground({
        workspaceId: "workspace-1",
        runId: "wfr_retry_checkpoint",
        projectTrusted: true,
      })
    ).resolves.toEqual({ runId: "wfr_retry_checkpoint", status: "running", result: null });
    await waitForWorkflowStatus(runStore, "wfr_retry_checkpoint", "running");

    releaseExistingTask();
    await waitForWorkflowStatus(runStore, "wfr_retry_checkpoint", "completed");
    expect(waitedFor).toEqual(["task_existing"]);
  });

  test("retries failed workflows with completed patch checkpoints without reapplying", async () => {
    using tmp = new DisposableTempDir("workflow-service");
    const runStore = new WorkflowRunStore({ sessionDir: tmp.path });
    await runStore.createRun({
      id: "wfr_retry_completed_patch",
      workspaceId: "workspace-1",
      definition: {
        name: "patch-demo",
        description: "Patch demo",
        scope: "built-in",
        executable: true,
      },
      definitionSource:
        "export default function workflow({ agent, applyPatch }) { const child = agent({ id: 'implement', prompt: 'Implement change', outputSchema: {} }); const patch = applyPatch({ id: 'apply-implement', source: child, target: 'parent' }); return { reportMarkdown: 'Patch ' + patch.status }; }\n",
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    const agentSpec = { id: "implement", prompt: "Implement change", outputSchema: {} };
    await runStore.recordStepCompleted("wfr_retry_completed_patch", {
      stepId: agentSpec.id,
      inputHash: hashWorkflowStepInput(agentSpec.id, agentSpec),
      taskId: "task_impl",
      result: { taskId: "task_impl", reportMarkdown: "implemented", structuredOutput: {} },
      startedAt: "2026-05-29T00:00:00.100Z",
      completedAt: "2026-05-29T00:00:00.200Z",
    });
    const patchSpec = {
      id: "apply-implement",
      sourceTaskId: "task_impl",
      target: "parent" as const,
      threeWay: true,
      force: false,
    };
    const patchResult = { success: true, status: "applied" as const, taskId: "task_impl" };
    await runStore.recordStepCompleted("wfr_retry_completed_patch", {
      stepId: patchSpec.id,
      inputHash: hashWorkflowStepInput(patchSpec.id, patchSpec),
      taskId: "task_impl",
      result: {
        reportMarkdown: "Patch applied from task task_impl.",
        structuredOutput: patchResult,
      },
      startedAt: "2026-05-29T00:00:00.300Z",
      completedAt: "2026-05-29T00:00:00.400Z",
    });
    await runStore.appendEvent("wfr_retry_completed_patch", {
      sequence: 1,
      type: "patch",
      at: "2026-05-29T00:00:00.300Z",
      stepId: patchSpec.id,
      sourceTaskId: "task_impl",
      status: "started",
    });
    await runStore.appendEvent("wfr_retry_completed_patch", {
      sequence: 2,
      type: "patch",
      at: "2026-05-29T00:00:00.400Z",
      stepId: patchSpec.id,
      sourceTaskId: "task_impl",
      status: "applied",
      details: patchResult,
    });
    await runStore.appendEvent("wfr_retry_completed_patch", {
      sequence: 3,
      type: "error",
      at: "2026-05-29T00:00:00.750Z",
      message: "Execution interrupted",
    });
    await runStore.appendStatus("wfr_retry_completed_patch", "failed", "2026-05-29T00:00:00.751Z");
    let applyPatchCalls = 0;
    let runAgentCalls = 0;
    const service = new WorkflowService({
      definitionStore: new WorkflowDefinitionStore({
        projectRoot: path.join(tmp.path, "project"),
        globalRoot: path.join(tmp.path, "global"),
        builtIns: [],
      }),
      runStore,
      runtimeFactory: new QuickJSRuntimeFactory(),
      taskAdapter: {
        async runAgent() {
          runAgentCalls += 1;
          throw new Error("completed agent checkpoint should replay");
        },
        async applyPatch() {
          applyPatchCalls += 1;
          throw new Error("completed patch checkpoint should replay");
        },
      },
      runnerId: "runner-a",
      clock: {
        nowIso: () => "2026-05-29T00:00:01.000Z",
        nowMs: () => 1_000,
      },
    });

    await expect(
      service.retryRunFromCheckpointInBackground({
        workspaceId: "workspace-1",
        runId: "wfr_retry_completed_patch",
        projectTrusted: true,
      })
    ).resolves.toEqual({ runId: "wfr_retry_completed_patch", status: "running", result: null });
    await waitForWorkflowStatus(runStore, "wfr_retry_completed_patch", "completed");
    await expect(runStore.getRun("wfr_retry_completed_patch")).resolves.toMatchObject({
      status: "completed",
    });
    expect(runAgentCalls).toBe(0);
    expect(applyPatchCalls).toBe(0);
  });

  test("rejects checkpoint retry for non-recoverable failed workflows", async () => {
    using tmp = new DisposableTempDir("workflow-service");
    const runStore = new WorkflowRunStore({ sessionDir: tmp.path });
    await runStore.createRun({
      id: "wfr_retry_rejected",
      workspaceId: "workspace-1",
      definition: { name: "demo", description: "Demo", scope: "built-in", executable: true },
      definitionSource: "export default function workflow() { return null; }\n",
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    await runStore.appendEvent("wfr_retry_rejected", {
      sequence: 1,
      type: "error",
      at: "2026-05-29T00:00:00.750Z",
      message: "SyntaxError: Unexpected token",
    });
    await runStore.appendStatus("wfr_retry_rejected", "failed", "2026-05-29T00:00:00.751Z");
    const service = new WorkflowService({
      definitionStore: new WorkflowDefinitionStore({
        projectRoot: path.join(tmp.path, "project"),
        globalRoot: path.join(tmp.path, "global"),
        builtIns: [],
      }),
      runStore,
      runtimeFactory: new QuickJSRuntimeFactory(),
      taskAdapter: {
        async runAgent() {
          throw new Error("non-recoverable retry must not run");
        },
      },
      runnerId: "runner-a",
    });

    await expect(
      service.retryRunFromCheckpointInBackground({
        workspaceId: "workspace-1",
        runId: "wfr_retry_rejected",
        projectTrusted: true,
      })
    ).rejects.toThrow(/cannot be retried from checkpoint/);
    await expect(runStore.getRun("wfr_retry_rejected")).resolves.toMatchObject({
      status: "failed",
    });
  });

  test("does not mark resume running before the runner acquires the lease", async () => {
    using tmp = new DisposableTempDir("workflow-service");
    const runStore = new WorkflowRunStore({ sessionDir: tmp.path });
    await runStore.createRun({
      id: "wfr_busy_resume",
      workspaceId: "workspace-1",
      definition: { name: "demo", description: "Demo", scope: "built-in", executable: true },
      definitionSource:
        "export default function workflow() { return { reportMarkdown: 'done' }; }\n",
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    await runStore.appendStatus("wfr_busy_resume", "interrupted", "2026-05-29T00:00:01.000Z");
    await runStore.acquireLease("wfr_busy_resume", "old-runner", Date.now());
    const originalConsoleError = console.error;
    console.error = () => undefined;
    try {
      const service = new WorkflowService({
        definitionStore: new WorkflowDefinitionStore({
          projectRoot: path.join(tmp.path, "project"),
          globalRoot: path.join(tmp.path, "global"),
          builtIns: [],
        }),
        runStore,
        runtimeFactory: new QuickJSRuntimeFactory(),
        taskAdapter: {
          async runAgent() {
            return { taskId: "task_1", reportMarkdown: "unused", structuredOutput: {} };
          },
        },
        runnerId: "runner-a",
      });

      await expect(
        service.resumeRunInBackground({
          workspaceId: "workspace-1",
          runId: "wfr_busy_resume",
          projectTrusted: true,
        })
      ).rejects.toThrow(/already active/);

      await expect(runStore.getRun("wfr_busy_resume")).resolves.toMatchObject({
        status: "interrupted",
      });
    } finally {
      console.error = originalConsoleError;
      await runStore.releaseLease("wfr_busy_resume", "old-runner");
    }
  });

  test("promotes a scratch workflow run to a reusable global definition", async () => {
    using tmp = new DisposableTempDir("workflow-service");
    const projectRoot = path.join(tmp.path, "project", ".mux", "workflows");
    const globalRoot = path.join(tmp.path, "mux-home", "workflows");
    const runStore = new WorkflowRunStore({ sessionDir: tmp.path });
    await runStore.createRun({
      id: "wfr_scratch",
      workspaceId: "workspace-1",
      definition: { name: "scratch", description: "Scratch", scope: "scratch", executable: true },
      definitionSource:
        "export default function workflow() { return { reportMarkdown: 'scratch' }; }\n",
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    const service = new WorkflowService({
      definitionStore: new WorkflowDefinitionStore({ projectRoot, globalRoot, builtIns: [] }),
      runStore,
      runtimeFactory: new QuickJSRuntimeFactory(),
      taskAdapter: {
        async runAgent() {
          return { taskId: "task_1", reportMarkdown: "unused", structuredOutput: {} };
        },
      },
      runnerId: "runner-a",
    });

    const descriptor = await service.promoteScratchWorkflow({
      workspaceId: "workspace-1",
      runId: "wfr_scratch",
      name: "promoted-research",
      description: "Promoted research workflow",
      location: "global",
      overwrite: false,
      projectTrusted: true,
    });
    const promotedSource = await fs.readFile(
      path.join(globalRoot, "promoted-research.js"),
      "utf-8"
    );

    expect(descriptor).toMatchObject({
      name: "promoted-research",
      description: "Promoted research workflow",
      scope: "global",
      executable: true,
    });
    expect(promotedSource).toContain('description: "Promoted research workflow"');
    expect(promotedSource).toContain("reportMarkdown: 'scratch'");
    await expect(service.listDefinitions({ projectTrusted: false })).resolves.toEqual([
      expect.objectContaining({ name: "promoted-research", scope: "global" }),
    ]);
  });

  test("promotes a scratch workflow definition to a reusable project definition without running it", async () => {
    using tmp = new DisposableTempDir("workflow-service");
    const workspaceRoot = path.join(tmp.path, "project");
    const scratchRoot = path.join(workspaceRoot, ".mux", "workflows", ".scratch");
    const projectRoot = path.join(workspaceRoot, ".mux", "workflows");
    const globalRoot = path.join(tmp.path, "mux-home", "workflows");
    const service = new WorkflowService({
      definitionStore: new WorkflowDefinitionStore({
        projectRoot,
        globalRoot,
        scratchRoot,
        builtIns: [],
      }),
      runStore: new WorkflowRunStore({ sessionDir: tmp.path }),
      runtimeFactory: new QuickJSRuntimeFactory(),
      taskAdapter: {
        async runAgent() {
          throw new Error("agent should not run");
        },
      },
      runnerId: "runner-a",
    });

    await writeWorkflow(
      scratchRoot,
      "scratch-draft",
      "export const metadata = { description: \"Scratch draft\" };\nexport default function workflow() { return { reportMarkdown: 'draft' }; }\n"
    );

    const descriptor = await service.promoteScratchDefinition({
      workspaceId: "workspace-1",
      name: "scratch-draft",
      description: "Reusable scratch draft",
      location: "project",
      overwrite: false,
      projectTrusted: true,
    });
    const promotedSource = await fs.readFile(path.join(projectRoot, "scratch-draft.js"), "utf-8");

    expect(descriptor).toMatchObject({
      name: "scratch-draft",
      description: "Reusable scratch draft",
      scope: "project",
      executable: true,
    });
    expect(promotedSource).toContain('description: "Reusable scratch draft"');
    expect(promotedSource).toContain("reportMarkdown: 'draft'");
  });

  test("can start a workflow in the background and persist a running run immediately", async () => {
    using tmp = new DisposableTempDir("workflow-service");
    const projectRoot = path.join(tmp.path, "project", ".mux", "workflows");
    const globalRoot = path.join(tmp.path, "mux-home", "workflows");
    await writeWorkflow(
      globalRoot,
      "background-research",
      "export const metadata = { description: \"Background workflow\" };\nexport default function workflow({ agent }) { return agent({ id: 'slow-step', prompt: 'slow', outputSchema: {} }); }\n"
    );
    const runStore = new WorkflowRunStore({ sessionDir: tmp.path });
    let releaseAgent:
      | ((value: { taskId: string; reportMarkdown: string; structuredOutput: unknown }) => void)
      | undefined;
    const terminalEvents: Array<{ runId: string; status: string; result: unknown }> = [];
    const lifecycleEvents: string[] = [];
    const service = new WorkflowService({
      definitionStore: new WorkflowDefinitionStore({ projectRoot, globalRoot, builtIns: [] }),
      runStore,
      runtimeFactory: new QuickJSRuntimeFactory(),
      taskAdapter: {
        async runAgent() {
          lifecycleEvents.push("agent-started");
          return await new Promise<{
            taskId: string;
            reportMarkdown: string;
            structuredOutput: unknown;
          }>((resolve) => {
            releaseAgent = resolve;
          });
        },
      },
      onBackgroundRunTerminal(event) {
        terminalEvents.push({ runId: event.runId, status: event.status, result: event.result });
      },
      generateRunId: () => "wfr_background",
      runnerId: "runner-a",
    });

    const started = await service.startNamedWorkflowInBackground({
      name: "background-research",
      workspaceId: "workspace-1",
      projectTrusted: false,
      args: {},
      onBackgroundRunCreated(event) {
        lifecycleEvents.push("run-created");
        expect(event).toMatchObject({
          runId: "wfr_background",
          status: "running",
          result: null,
          run: { id: "wfr_background", status: "running" },
        });
      },
    });

    expect(started).toMatchObject({ runId: "wfr_background", status: "running", result: null });
    await expect(runStore.getRun("wfr_background")).resolves.toMatchObject({
      id: "wfr_background",
      status: "running",
    });

    expect(lifecycleEvents).toEqual(["run-created"]);
    await waitForCondition("background agent to start", () => releaseAgent != null);
    expect(lifecycleEvents).toEqual(["run-created", "agent-started"]);
    releaseAgent?.({ taskId: "task_slow", reportMarkdown: "done", structuredOutput: {} });
    await waitForWorkflowStatus(runStore, "wfr_background", "completed");
    await waitForCondition("background terminal callback", () => terminalEvents.length === 1);
    await expect(runStore.getRun("wfr_background")).resolves.toMatchObject({ status: "completed" });
    expect(terminalEvents).toEqual([
      {
        runId: "wfr_background",
        status: "completed",
        result: { reportMarkdown: "done", structuredOutput: {} },
      },
    ]);
  });

  test("does not notify background continuation for interrupted runs", async () => {
    using tmp = new DisposableTempDir("workflow-service");
    const projectRoot = path.join(tmp.path, "project", ".mux", "workflows");
    const globalRoot = path.join(tmp.path, "mux-home", "workflows");
    await writeWorkflow(
      globalRoot,
      "interruptable-background",
      "export const metadata = { description: \"Interruptable background workflow\" };\nexport default function workflow({ agent }) { return agent({ id: 'slow-step', prompt: 'slow', outputSchema: {} }); }\n"
    );
    const runStore = new WorkflowRunStore({ sessionDir: tmp.path });
    let agentStarted = false;
    let agentAbortObserved = false;
    let interruptCalls = 0;
    const terminalEvents: Array<{ runId: string; status: string; result: unknown }> = [];
    const service = new WorkflowService({
      definitionStore: new WorkflowDefinitionStore({ projectRoot, globalRoot, builtIns: [] }),
      runStore,
      runtimeFactory: new QuickJSRuntimeFactory(),
      taskAdapter: {
        async runAgent(_spec, _lifecycle, waitOptions) {
          agentStarted = true;
          return await new Promise((_, reject) => {
            waitOptions?.abortSignal?.addEventListener(
              "abort",
              () => {
                agentAbortObserved = true;
                reject(new Error("Task interrupted"));
              },
              { once: true }
            );
          });
        },
        async interruptRun() {
          interruptCalls += 1;
        },
      },
      onBackgroundRunTerminal(event) {
        terminalEvents.push({ runId: event.runId, status: event.status, result: event.result });
      },
      generateRunId: () => "wfr_background_interrupt",
      runnerId: "runner-a",
    });

    await service.startNamedWorkflowInBackground({
      name: "interruptable-background",
      workspaceId: "workspace-1",
      projectTrusted: false,
      args: {},
    });
    await waitForCondition("background agent to start", () => agentStarted);

    const interrupted = await service.interruptRun({
      workspaceId: "workspace-1",
      runId: "wfr_background_interrupt",
    });

    expect(interrupted.status).toBe("interrupted");
    await waitForWorkflowStatus(runStore, "wfr_background_interrupt", "interrupted");
    await waitForCondition("background agent abort", () => agentAbortObserved);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(interruptCalls).toBe(1);
    expect(terminalEvents).toEqual([]);
  });

  test("notifies requested interrupted background runs without logging a failure", async () => {
    using tmp = new DisposableTempDir("workflow-service");
    const projectRoot = path.join(tmp.path, "project", ".mux", "workflows");
    const globalRoot = path.join(tmp.path, "mux-home", "workflows");
    await writeWorkflow(
      globalRoot,
      "logged-interrupt-background",
      "export const metadata = { description: \"Logged interrupt background workflow\" };\nexport default function workflow({ agent }) { return agent({ id: 'slow-step', prompt: 'slow', outputSchema: {} }); }\n"
    );
    const runStore = new WorkflowRunStore({ sessionDir: tmp.path });
    let agentStarted = false;
    const terminalEvents: Array<{ runId: string; status: string; result: unknown }> = [];
    const consoleErrors: Array<Parameters<typeof console.error>> = [];
    const originalConsoleError = console.error;
    console.error = (...args: Parameters<typeof console.error>) => {
      consoleErrors.push(args);
    };
    try {
      const service = new WorkflowService({
        definitionStore: new WorkflowDefinitionStore({ projectRoot, globalRoot, builtIns: [] }),
        runStore,
        runtimeFactory: new QuickJSRuntimeFactory(),
        taskAdapter: {
          async runAgent(_spec, _lifecycle, waitOptions) {
            agentStarted = true;
            const abortSignal = waitOptions?.abortSignal;
            if (abortSignal == null) {
              throw new Error("expected a background run abort signal");
            }
            return await new Promise<{ taskId: string; reportMarkdown: string }>((_, reject) => {
              abortSignal.addEventListener("abort", () => reject(new Error("Task interrupted")), {
                once: true,
              });
            });
          },
        },
        onBackgroundRunTerminal(event) {
          terminalEvents.push({ runId: event.runId, status: event.status, result: event.result });
        },
        notifyInterruptedBackgroundRunTerminal: true,
        generateRunId: () => "wfr_background_interrupt_logged",
        runnerId: "runner-a",
      });

      await service.startNamedWorkflowInBackground({
        name: "logged-interrupt-background",
        workspaceId: "workspace-1",
        projectTrusted: false,
        args: {},
      });
      await waitForCondition("background agent to start", () => agentStarted);

      const interrupted = await service.interruptRun({
        workspaceId: "workspace-1",
        runId: "wfr_background_interrupt_logged",
      });

      expect(interrupted.status).toBe("interrupted");
      await waitForCondition(
        "interrupted background terminal callback",
        () => terminalEvents.length === 1
      );
      expect(terminalEvents).toEqual([
        {
          runId: "wfr_background_interrupt_logged",
          status: "interrupted",
          result: null,
        },
      ]);
      expect(consoleErrors).toEqual([]);
    } finally {
      console.error = originalConsoleError;
    }
  });

  test("auto-resumes crash-recovered running runs without resuming user-interrupted runs", async () => {
    using tmp = new DisposableTempDir("workflow-service");
    const runStore = new WorkflowRunStore({ sessionDir: tmp.path });
    await runStore.createRun({
      id: "wfr_crash_running",
      workspaceId: "workspace-1",
      definition: { name: "demo", description: "Demo", scope: "built-in", executable: true },
      definitionSource:
        "export default function workflow({ agent }) { return agent({ id: 'after-crash', prompt: 'resume', outputSchema: {} }); }\n",
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    await runStore.appendStatus("wfr_crash_running", "running", "2026-05-29T00:00:01.000Z");
    await runStore.createRun({
      id: "wfr_user_interrupted",
      workspaceId: "workspace-1",
      definition: { name: "demo", description: "Demo", scope: "built-in", executable: true },
      definitionSource:
        "export default function workflow({ agent }) { return agent({ id: 'should-not-run', prompt: 'blocked', outputSchema: {} }); }\n",
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    await runStore.appendStatus("wfr_user_interrupted", "interrupted", "2026-05-29T00:00:01.000Z");
    const taskCalls: string[] = [];
    const service = new WorkflowService({
      definitionStore: new WorkflowDefinitionStore({
        projectRoot: path.join(tmp.path, "project"),
        globalRoot: path.join(tmp.path, "global"),
        builtIns: [],
      }),
      runStore,
      runtimeFactory: new QuickJSRuntimeFactory(),
      taskAdapter: {
        async runAgent(spec) {
          taskCalls.push(spec.id);
          return { taskId: `task_${spec.id}`, reportMarkdown: "resumed", structuredOutput: {} };
        },
      },
      runnerId: "runner-a",
    });

    await expect(
      service.resumeCrashedRuns({ workspaceId: "workspace-1", projectTrusted: true })
    ).resolves.toEqual(["wfr_crash_running"]);
    await waitForWorkflowStatus(runStore, "wfr_crash_running", "completed");
    await waitForWorkflowRunFileStatus(tmp.path, "wfr_crash_running", "completed");

    expect(taskCalls).toEqual(["after-crash"]);
    await expect(runStore.getRun("wfr_user_interrupted")).resolves.toMatchObject({
      status: "interrupted",
    });
  });

  test("retries crash recovery after a fresh persisted lease becomes stale", async () => {
    using tmp = new DisposableTempDir("workflow-service");
    const runStore = new WorkflowRunStore({ sessionDir: tmp.path, staleLeaseMs: 10 });
    await runStore.createRun({
      id: "wfr_fresh_crash_lease",
      workspaceId: "workspace-1",
      definition: { name: "demo", description: "Demo", scope: "built-in", executable: true },
      definitionSource:
        "export default function workflow({ agent }) { return agent({ id: 'after-lease', prompt: 'resume', outputSchema: {} }); }\n",
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    await runStore.appendStatus("wfr_fresh_crash_lease", "running", "2026-05-29T00:00:01.000Z");
    await runStore.acquireLease("wfr_fresh_crash_lease", "crashed-runner", Date.now());
    const taskCalls: string[] = [];
    const service = new WorkflowService({
      definitionStore: new WorkflowDefinitionStore({
        projectRoot: path.join(tmp.path, "project"),
        globalRoot: path.join(tmp.path, "global"),
        builtIns: [],
      }),
      runStore,
      runtimeFactory: new QuickJSRuntimeFactory(),
      taskAdapter: {
        async runAgent(spec) {
          taskCalls.push(spec.id);
          return { taskId: `task_${spec.id}`, reportMarkdown: "resumed", structuredOutput: {} };
        },
      },
      runnerId: "runner-a",
    });

    await expect(
      service.resumeCrashedRuns({ workspaceId: "workspace-1", projectTrusted: true })
    ).resolves.toEqual(["wfr_fresh_crash_lease"]);
    expect(taskCalls).toEqual([]);

    await waitForCondition("crash recovery retry to acquire stale lease", () =>
      taskCalls.includes("after-lease")
    );
    await waitForWorkflowStatus(runStore, "wfr_fresh_crash_lease", "completed");
  });

  test("re-checks project trust before delayed crash recovery retry", async () => {
    using tmp = new DisposableTempDir("workflow-service");
    const runStore = new WorkflowRunStore({ sessionDir: tmp.path, staleLeaseMs: 25 });
    await runStore.createRun({
      id: "wfr_project_trust_retry",
      workspaceId: "workspace-1",
      definition: {
        name: "project-flow",
        description: "Project",
        scope: "project",
        executable: true,
      },
      definitionSource:
        "export default function workflow({ agent }) { return agent({ id: 'after-trust-revoked', prompt: 'blocked', outputSchema: {} }); }\n",
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    await runStore.appendStatus("wfr_project_trust_retry", "running", "2026-05-29T00:00:01.000Z");
    // Use an injectable clock so the lease is deterministically still fresh when
    // resumeCrashedRuns checks it. With real time, the 25ms freshness window can
    // elapse between acquireLease and the service's getLeaseRetryDelayMs check on a
    // loaded CI machine, making the service resume immediately (with the already
    // resolved trusted=true) instead of scheduling the delayed retry under test.
    let fakeNowMs = 1_000_000;
    await runStore.acquireLease("wfr_project_trust_retry", "crashed-runner", fakeNowMs);
    const taskCalls: string[] = [];
    let currentProjectTrusted = true;
    let trustChecks = 0;
    const service = new WorkflowService({
      definitionStore: new WorkflowDefinitionStore({
        projectRoot: path.join(tmp.path, "project"),
        globalRoot: path.join(tmp.path, "global"),
        builtIns: [],
      }),
      runStore,
      runtimeFactory: new QuickJSRuntimeFactory(),
      taskAdapter: {
        async runAgent(spec) {
          taskCalls.push(spec.id);
          return {
            taskId: `task_${spec.id}`,
            reportMarkdown: "should not run",
            structuredOutput: {},
          };
        },
      },
      getCurrentProjectTrusted: () => {
        trustChecks += 1;
        return currentProjectTrusted;
      },
      runnerId: "runner-a",
      clock: {
        nowIso: () => "2026-05-29T00:00:02.000Z",
        nowMs: () => fakeNowMs,
      },
    });

    await expect(
      service.resumeCrashedRuns({ workspaceId: "workspace-1", projectTrusted: true })
    ).resolves.toEqual(["wfr_project_trust_retry"]);
    currentProjectTrusted = false;
    // Make the lease stale for the delayed retry so it proceeds to the trust gate.
    fakeNowMs += 10_000;

    await waitForCondition(
      "delayed crash recovery retry to re-check project trust",
      () => trustChecks >= 2,
      20_000
    );
    expect(taskCalls).toEqual([]);
    await expect(runStore.getRun("wfr_project_trust_retry")).resolves.toMatchObject({
      status: "running",
    });
  }, 25_000);

  test("uses a fresh lease owner for each runner", async () => {
    using tmp = new DisposableTempDir("workflow-service");
    const projectRoot = path.join(tmp.path, "project", ".mux", "workflows");
    const globalRoot = path.join(tmp.path, "mux-home", "workflows");
    const source = `export const metadata = { description: "Demo workflow" };
export default function workflow() {
  return { reportMarkdown: "ok" };
}
`;
    await writeWorkflow(globalRoot, "demo", source);
    const runStore = new WorkflowRunStore({ sessionDir: tmp.path });
    const ownerIds: string[] = [];
    const acquireLease = runStore.acquireLease.bind(runStore);
    runStore.acquireLease = async (runId, ownerId, nowMs) => {
      ownerIds.push(ownerId);
      return await acquireLease(runId, ownerId, nowMs);
    };
    let nextRunId = 0;
    const service = new WorkflowService({
      definitionStore: new WorkflowDefinitionStore({ projectRoot, globalRoot, builtIns: [] }),
      runStore,
      runtimeFactory: new QuickJSRuntimeFactory(),
      taskAdapter: {
        async runAgent() {
          throw new Error("workflow should not spawn tasks");
        },
      },
      generateRunId: () => `wfr_owner_${++nextRunId}`,
      runnerId: "runner-a",
      clock: {
        nowIso: () => "2026-05-29T00:00:00.000Z",
        nowMs: () => 1_000,
      },
    });

    await service.startNamedWorkflow({
      name: "demo",
      workspaceId: "workspace-1",
      projectTrusted: true,
      args: {},
    });
    await service.startNamedWorkflow({
      name: "demo",
      workspaceId: "workspace-1",
      projectTrusted: true,
      args: {},
    });

    expect(ownerIds).toHaveLength(2);
    expect(new Set(ownerIds).size).toBe(2);
    expect(ownerIds.every((ownerId) => ownerId.startsWith("runner-a:"))).toBe(true);
  });

  test("requires current project trust before resuming project-local workflow runs", async () => {
    using tmp = new DisposableTempDir("workflow-service");
    const runStore = new WorkflowRunStore({ sessionDir: tmp.path });
    await runStore.createRun({
      id: "wfr_project_resume",
      workspaceId: "workspace-1",
      definition: {
        name: "project-flow",
        description: "Project",
        scope: "project",
        executable: true,
      },
      definitionSource:
        "export default function workflow({ agent }) { return agent({ id: 'trusted-step', prompt: 'run', outputSchema: {} }); }\n",
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    await runStore.appendStatus("wfr_project_resume", "interrupted", "2026-05-29T00:00:01.000Z");
    let taskCalls = 0;
    const service = new WorkflowService({
      definitionStore: new WorkflowDefinitionStore({
        projectRoot: path.join(tmp.path, "project"),
        globalRoot: path.join(tmp.path, "global"),
        builtIns: [],
      }),
      runStore,
      runtimeFactory: new QuickJSRuntimeFactory(),
      taskAdapter: {
        async runAgent() {
          taskCalls += 1;
          return { taskId: "task_trusted", reportMarkdown: "should not run", structuredOutput: {} };
        },
      },
      runnerId: "runner-a",
    });

    await expect(
      service.resumeRunInBackground({
        workspaceId: "workspace-1",
        runId: "wfr_project_resume",
        projectTrusted: false,
      })
    ).rejects.toThrow(/Project trust/);
    await runStore.appendStatus("wfr_project_resume", "running", "2026-05-29T00:00:02.000Z", {
      allowInterruptedResume: true,
    });

    await expect(
      service.resumeCrashedRuns({ workspaceId: "workspace-1", projectTrusted: false })
    ).resolves.toEqual([]);
    expect(taskCalls).toBe(0);
  });

  test("requires current project trust before resuming scratch workflow runs", async () => {
    using tmp = new DisposableTempDir("workflow-service");
    const runStore = new WorkflowRunStore({ sessionDir: tmp.path });
    await runStore.createRun({
      id: "wfr_scratch_resume",
      workspaceId: "workspace-1",
      definition: {
        name: "scratch-flow",
        description: "Scratch",
        scope: "scratch",
        executable: true,
      },
      definitionSource:
        "export default function workflow({ agent }) { return agent({ id: 'scratch-step', prompt: 'run', outputSchema: {} }); }\n",
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    await runStore.appendStatus("wfr_scratch_resume", "interrupted", "2026-05-29T00:00:01.000Z");
    let taskCalls = 0;
    const service = new WorkflowService({
      definitionStore: new WorkflowDefinitionStore({
        projectRoot: path.join(tmp.path, "project"),
        globalRoot: path.join(tmp.path, "global"),
        builtIns: [],
      }),
      runStore,
      runtimeFactory: new QuickJSRuntimeFactory(),
      taskAdapter: {
        async runAgent() {
          taskCalls += 1;
          return { taskId: "task_scratch", reportMarkdown: "should not run", structuredOutput: {} };
        },
      },
      runnerId: "runner-a",
    });

    await expect(
      service.resumeRunInBackground({
        workspaceId: "workspace-1",
        runId: "wfr_scratch_resume",
        projectTrusted: false,
      })
    ).rejects.toThrow(/Project trust/);
    await runStore.appendStatus("wfr_scratch_resume", "running", "2026-05-29T00:00:02.000Z", {
      allowInterruptedResume: true,
    });

    await expect(
      service.resumeCrashedRuns({ workspaceId: "workspace-1", projectTrusted: false })
    ).resolves.toEqual([]);
    expect(taskCalls).toBe(0);
  });

  test("requires project trust before promoting scratch workflow runs", async () => {
    using tmp = new DisposableTempDir("workflow-service");
    const projectRoot = path.join(tmp.path, "project", ".mux", "workflows");
    const globalRoot = path.join(tmp.path, "mux-home", "workflows");
    const runStore = new WorkflowRunStore({ sessionDir: tmp.path });
    await runStore.createRun({
      id: "wfr_scratch",
      workspaceId: "workspace-1",
      definition: { name: "scratch", description: "Scratch", scope: "scratch", executable: true },
      definitionSource: "export default function workflow() { return null; }\n",
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    const service = new WorkflowService({
      definitionStore: new WorkflowDefinitionStore({ projectRoot, globalRoot, builtIns: [] }),
      runStore,
      runtimeFactory: new QuickJSRuntimeFactory(),
      taskAdapter: {
        async runAgent() {
          return { taskId: "task_1", reportMarkdown: "unused", structuredOutput: {} };
        },
      },
      runnerId: "runner-a",
    });

    await expect(
      service.promoteScratchWorkflow({
        workspaceId: "workspace-1",
        runId: "wfr_scratch",
        name: "global-research",
        description: "Global research workflow",
        location: "global",
        overwrite: false,
        projectTrusted: false,
      })
    ).rejects.toThrow(/Project trust/);
  });
});
