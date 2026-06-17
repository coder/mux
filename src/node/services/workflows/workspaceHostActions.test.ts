import { describe, expect, mock, test } from "bun:test";
import { DisposableTempDir } from "@/node/services/tempDir";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import type { MuxMessage } from "@/common/types/message";
import { Ok, Err } from "@/common/types/result";
import { WorkflowActionRunner, type HostWorkflowAction } from "./WorkflowActionRunner";
import { hashWorkflowActionSource, WorkflowActionRegistry } from "./WorkflowActionRegistry";
import {
  buildWorkspaceHostActionStubSources,
  createWorkspaceHostActions,
  deriveEnsureBranchName,
  WORK_ITEM_TAG_KEY,
  type WorkspaceHostActionServices,
} from "./workspaceHostActions";

function workspaceMeta(overrides: Partial<FrontendWorkspaceMetadata>): FrontendWorkspaceMetadata {
  return {
    id: "ws-1",
    name: "ws-1",
    projectName: "proj",
    projectPath: "/proj",
    runtimeConfig: { type: "local" },
    namedWorkspacePath: "/proj/ws-1",
    ...overrides,
  } as unknown as FrontendWorkspaceMetadata;
}

async function expectRejects(promise: Promise<unknown>, pattern: RegExp) {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect(error instanceof Error ? error.message : "").toMatch(pattern);
    return;
  }
  throw new Error("Expected promise to reject");
}

interface FakeServiceOptions {
  workspaces?: FrontendWorkspaceMetadata[];
  history?: MuxMessage[];
  runtimeState?: { isBusy: boolean; hasQueuedMessages: boolean; isInitializing: boolean };
  /** Project trust for "/proj" (default true; ensure refuses untrusted projects). */
  projectTrusted?: boolean;
  /** Artificial delay inside create() to widen race windows in tests. */
  createDelayMs?: number;
}

function fakeServices(options: FakeServiceOptions = {}) {
  // Stateful: create() appends, so concurrent-ensure tests observe the
  // workspace created by an earlier (serialized) ensure.
  const knownWorkspaces: FrontendWorkspaceMetadata[] = [...(options.workspaces ?? [])];
  let createSequence = 0;
  const calls = {
    create: mock(
      async (
        _projectPath: string,
        branchName: string | undefined,
        _trunkBranch: string | undefined,
        _title?: string,
        _runtimeConfig?: unknown,
        _subProjectPath?: string,
        _pendingAutoTitle?: boolean,
        tags?: Record<string, string>
      ) => {
        if (options.createDelayMs != null) {
          await new Promise((resolve) => setTimeout(resolve, options.createDelayMs));
        }
        createSequence += 1;
        const metadata = workspaceMeta({
          id: `created-ws${createSequence > 1 ? `-${createSequence}` : ""}`,
          name: branchName ?? "x",
          tags,
        });
        knownWorkspaces.push(metadata);
        return Ok({ metadata });
      }
    ),
    sendMessage: mock(() => Promise.resolve(Ok(undefined))),
    archive: mock(() => Promise.resolve(Ok({ archived: true }))),
    unarchive: mock((workspaceId: string) => {
      const metadata = knownWorkspaces.find((workspace) => workspace.id === workspaceId);
      if (metadata) {
        metadata.unarchivedAt = new Date().toISOString();
      }
      return Promise.resolve(Ok(undefined));
    }),
  };
  const services: WorkspaceHostActionServices = {
    workspaceService: {
      list: () => Promise.resolve(knownWorkspaces),
      create: calls.create as unknown as WorkspaceHostActionServices["workspaceService"]["create"],
      sendMessage:
        calls.sendMessage as unknown as WorkspaceHostActionServices["workspaceService"]["sendMessage"],
      archive:
        calls.archive as unknown as WorkspaceHostActionServices["workspaceService"]["archive"],
      unarchive:
        calls.unarchive as unknown as WorkspaceHostActionServices["workspaceService"]["unarchive"],
      getGoalContinuationRuntimeState: () => ({
        isInitializing: false,
        isRuntimeCompatible: true,
        isBusy: false,
        hasQueuedMessages: false,
        hasPendingFollowUp: false,
        ...options.runtimeState,
      }),
    },
    historyService: {
      getHistoryFromLatestBoundary: () => Promise.resolve(Ok(options.history ?? [])),
    },
    config: {
      loadConfigOrDefault: () => ({
        projects: new Map([["/proj", { workspaces: [], trusted: options.projectTrusted ?? true }]]),
        defaultModel: "test:default-model",
      }),
      getAllWorkspaceMetadata: () => Promise.resolve(knownWorkspaces),
      findWorkspace: (workspaceId: string) =>
        knownWorkspaces.some((w) => w.id === workspaceId)
          ? {
              workspacePath: "/x",
              projectPath: "/proj",
              attributionProjectPath: "/proj",
              workspaceName: workspaceId,
              parentWorkspaceId: undefined,
              pendingAutoTitle: undefined,
            }
          : null,
    },
    awaitIdlePollMs: 10,
  };
  return { services, calls };
}

function getAction(
  actions: ReadonlyMap<string, HostWorkflowAction>,
  name: string
): HostWorkflowAction {
  const action = actions.get(name);
  if (!action) throw new Error(`host action not registered: ${name}`);
  return action;
}

const ctx = { cwd: "/tmp" };

describe("workspace host action stub sources", () => {
  test("stubs are statically parseable: describe() round-trips metadata and reconcile presence", async () => {
    const sources = buildWorkspaceHostActionStubSources();
    const { services } = fakeServices();
    const hostActions = createWorkspaceHostActions(services);
    const runner = new WorkflowActionRunner();

    expect(Object.keys(sources).sort()).toEqual([...hostActions.keys()].sort());

    for (const [name, source] of Object.entries(sources)) {
      const described = await runner.describe({
        name,
        scope: "built-in",
        sourcePath: `/virtual/${name}.js`,
        source,
        sourceHash: hashWorkflowActionSource(source),
      });
      const hostAction = getAction(hostActions, name);
      expect(described.metadata).toEqual(hostAction.metadata);
      expect(described.hasReconcile).toBe(hostAction.reconcile != null);
    }
  });

  test("registry resolves workspace.* as built-in actions", async () => {
    using projectDir = new DisposableTempDir("wha-project");
    using globalDir = new DisposableTempDir("wha-global");
    const registry = new WorkflowActionRegistry({
      projectRoot: projectDir.path,
      globalRoot: globalDir.path,
    });
    const resolved = await registry.resolveAction("workspace.ensure", { projectTrusted: false });
    expect(resolved.scope).toBe("built-in");
    expect(resolved.source).toContain("workItemKey");
  });
});

describe("WorkflowActionRunner host dispatch", () => {
  function stubResolvedAction(name: string, scope: "built-in" | "project") {
    const source = buildWorkspaceHostActionStubSources()[name];
    if (!source) throw new Error(`no stub for ${name}`);
    return {
      name,
      scope,
      sourcePath: `/virtual/${name}.js`,
      source,
      sourceHash: hashWorkflowActionSource(source),
    } as const;
  }

  test("built-in scope dispatches in-process to the host implementation", async () => {
    using artifactDir = new DisposableTempDir("wha-artifacts");
    const { services } = fakeServices({ workspaces: [workspaceMeta({ id: "a" })] });
    const runner = new WorkflowActionRunner({ hostActions: createWorkspaceHostActions(services) });
    const result = await runner.execute(stubResolvedAction("workspace.list", "built-in"), {
      artifactDir: artifactDir.path,
      cwd: "/tmp",
      input: {},
      timeoutMs: 5000,
    });
    const output = result.output as { workspaces: Array<{ workspaceId: string }> };
    expect(output.workspaces.map((w) => w.workspaceId)).toEqual(["a"]);
    expect(result.exitCode).toBe(0);
  });

  test("without a host map, the stub fails fast with a host-process error", async () => {
    using artifactDir = new DisposableTempDir("wha-artifacts");
    const runner = new WorkflowActionRunner();
    await expectRejects(
      runner.execute(stubResolvedAction("workspace.list", "built-in"), {
        artifactDir: artifactDir.path,
        cwd: "/tmp",
        input: {},
        timeoutMs: 30_000,
      }),
      /requires the mux host process/
    );
  });

  /** Host map with workspace.list's metadata but a custom execute, for lifecycle tests. */
  function customHostMap(execute: HostWorkflowAction["execute"]) {
    const { services } = fakeServices();
    const real = getAction(createWorkspaceHostActions(services), "workspace.list");
    return new Map<string, HostWorkflowAction>([
      ["workspace.list", { metadata: real.metadata, execute }],
    ]);
  }

  async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
    const startedAt = Date.now();
    while (!predicate()) {
      if (Date.now() - startedAt > timeoutMs) throw new Error("waitFor timed out");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  test("step timeout fails the step and the composed signal stops in-action loops", async () => {
    using artifactDir = new DisposableTempDir("wha-artifacts");
    let sawAbort = false;
    const runner = new WorkflowActionRunner({
      hostActions: customHostMap(async (_input, hostCtx) => {
        while (hostCtx.abortSignal?.aborted !== true) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        sawAbort = true;
        return {};
      }),
    });
    await expectRejects(
      runner.execute(stubResolvedAction("workspace.list", "built-in"), {
        artifactDir: artifactDir.path,
        cwd: "/tmp",
        input: {},
        timeoutMs: 40,
      }),
      /timed out after 40ms/
    );
    // Without composing the timeout into ctx.abortSignal, this loop would
    // keep polling long after the step was recorded as failed.
    await waitFor(() => sawAbort);
  });

  test("aborting the run fails the step instead of recording a durable success", async () => {
    using artifactDir = new DisposableTempDir("wha-artifacts");
    const controller = new AbortController();
    const runner = new WorkflowActionRunner({
      hostActions: customHostMap(async (_input, hostCtx) => {
        while (hostCtx.abortSignal?.aborted !== true) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        return { idle: false };
      }),
    });
    setTimeout(() => controller.abort(), 20);
    await expectRejects(
      runner.execute(stubResolvedAction("workspace.list", "built-in"), {
        artifactDir: artifactDir.path,
        cwd: "/tmp",
        input: {},
        timeoutMs: 30_000,
        abortSignal: controller.signal,
      }),
      /aborted/
    );
  });

  test("on abort the runner waits for cooperative settlement before failing the step", async () => {
    using artifactDir = new DisposableTempDir("wha-artifacts");
    const controller = new AbortController();
    // Simulates a mutating action mid-flight: it notices the abort, finishes
    // its in-flight side effect, then settles. The step failure must not be
    // recorded until that side effect has landed.
    let sideEffectLanded = false;
    const runner = new WorkflowActionRunner({
      hostActions: customHostMap(async (_input, hostCtx) => {
        while (hostCtx.abortSignal?.aborted !== true) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        await new Promise((resolve) => setTimeout(resolve, 30));
        sideEffectLanded = true;
        return {};
      }),
    });
    setTimeout(() => controller.abort(), 10);
    await expectRejects(
      runner.execute(stubResolvedAction("workspace.list", "built-in"), {
        artifactDir: artifactDir.path,
        cwd: "/tmp",
        input: {},
        timeoutMs: 30_000,
        abortSignal: controller.signal,
      }),
      /aborted/
    );
    // The reject above must have waited for the action's settlement.
    expect(sideEffectLanded).toBe(true);
  });

  test("a pre-aborted signal fails fast without invoking the action", async () => {
    using artifactDir = new DisposableTempDir("wha-artifacts");
    const execute = mock(() => Promise.resolve({}));
    const runner = new WorkflowActionRunner({ hostActions: customHostMap(execute) });
    const controller = new AbortController();
    controller.abort();
    await expectRejects(
      runner.execute(stubResolvedAction("workspace.list", "built-in"), {
        artifactDir: artifactDir.path,
        cwd: "/tmp",
        input: {},
        timeoutMs: 30_000,
        abortSignal: controller.signal,
      }),
      /aborted/
    );
    expect(execute).not.toHaveBeenCalled();
  });

  test("oversized output is measured in bytes, not UTF-16 code units", async () => {
    using artifactDir = new DisposableTempDir("wha-artifacts");
    // 700k chars < 1Mi UTF-16 units, but ~1.4MB utf8 — must exceed the limit.
    const runner = new WorkflowActionRunner({
      hostActions: customHostMap(() => Promise.resolve({ s: "é".repeat(700_000) })),
    });
    await expectRejects(
      runner.execute(stubResolvedAction("workspace.list", "built-in"), {
        artifactDir: artifactDir.path,
        cwd: "/tmp",
        input: {},
        timeoutMs: 30_000,
      }),
      /result size limit/
    );
  });

  test("non-built-in scope is not intercepted even when names collide", async () => {
    using artifactDir = new DisposableTempDir("wha-artifacts");
    const { services } = fakeServices({ workspaces: [workspaceMeta({ id: "a" })] });
    const runner = new WorkflowActionRunner({ hostActions: createWorkspaceHostActions(services) });
    // A project action shadowing workspace.list keeps child semantics: the
    // stub source executes in the child and throws its host-process error.
    await expectRejects(
      runner.execute(stubResolvedAction("workspace.list", "project"), {
        artifactDir: artifactDir.path,
        cwd: "/tmp",
        input: {},
        timeoutMs: 30_000,
      }),
      /requires the mux host process/
    );
  });
});

describe("workspace.ensure", () => {
  test("creates a tagged workspace when the key has no match", async () => {
    const { services, calls } = fakeServices();
    const ensure = getAction(createWorkspaceHostActions(services), "workspace.ensure");
    const output = (await ensure.execute(
      { projectPath: "/proj", key: "issue-1-investigate", trunkBranch: "main" },
      ctx
    )) as { action: string; created: boolean; workspaceId: string; archived: boolean };
    expect(output).toMatchObject({
      action: "created",
      created: true,
      workspaceId: "created-ws",
      archived: false,
      unarchived: false,
    });
    expect(calls.create).toHaveBeenCalledTimes(1);
    const tags = calls.create.mock.calls[0][7];
    expect(tags).toEqual({ [WORK_ITEM_TAG_KEY]: "issue-1-investigate" });
  });

  test("reuses an active tagged workspace without creating or unarchiving", async () => {
    const { services, calls } = fakeServices({
      workspaces: [
        workspaceMeta({
          id: "existing",
          tags: { [WORK_ITEM_TAG_KEY]: "issue-1-investigate" },
        }),
      ],
    });
    const ensure = getAction(createWorkspaceHostActions(services), "workspace.ensure");
    const output = await ensure.execute(
      { projectPath: "/proj", key: "issue-1-investigate", trunkBranch: "main" },
      ctx
    );
    expect(output).toEqual({
      action: "reused",
      created: false,
      workspaceId: "existing",
      archived: false,
      unarchived: false,
    });
    expect(calls.create).not.toHaveBeenCalled();
    expect(calls.unarchive).not.toHaveBeenCalled();
  });

  test("unarchives a tagged workspace instead of returning it archived", async () => {
    const { services, calls } = fakeServices({
      workspaces: [
        workspaceMeta({
          id: "existing",
          tags: { [WORK_ITEM_TAG_KEY]: "issue-1-investigate" },
          archivedAt: new Date().toISOString(),
        }),
      ],
    });
    const ensure = getAction(createWorkspaceHostActions(services), "workspace.ensure");
    const output = await ensure.execute(
      { projectPath: "/proj", key: "issue-1-investigate", trunkBranch: "main" },
      ctx
    );
    expect(output).toEqual({
      action: "unarchived",
      created: false,
      workspaceId: "existing",
      archived: false,
      unarchived: true,
    });
    const second = await ensure.execute(
      { projectPath: "/proj", key: "issue-1-investigate", trunkBranch: "main" },
      ctx
    );
    expect(second).toEqual({
      action: "reused",
      created: false,
      workspaceId: "existing",
      archived: false,
      unarchived: false,
    });
    expect(calls.create).not.toHaveBeenCalled();
    expect(calls.unarchive).toHaveBeenCalledTimes(1);
  });

  test("reconcile re-runs the idempotent ensure", () => {
    const { services } = fakeServices();
    const ensure = getAction(createWorkspaceHostActions(services), "workspace.ensure");
    expect(ensure.reconcile).toBe(ensure.execute);
  });

  test("serializes concurrent ensures for the same key: exactly one create", async () => {
    // Without the keyed mutex, both ensures miss the predicate during the slow
    // create and produce duplicate workspaces tagged with the same key.
    const { services, calls } = fakeServices({ createDelayMs: 25 });
    const ensure = getAction(createWorkspaceHostActions(services), "workspace.ensure");
    const input = { projectPath: "/proj", key: "issue-9-implement", trunkBranch: "main" };
    const [first, second] = (await Promise.all([
      ensure.execute(input, ctx),
      ensure.execute(input, ctx),
    ])) as Array<{ created: boolean; workspaceId: string }>;
    expect(calls.create).toHaveBeenCalledTimes(1);
    expect(first.workspaceId).toBe(second.workspaceId);
    expect([first.created, second.created].sort()).toEqual([false, true]);
  });

  test("refuses untrusted projects before touching git", async () => {
    const { services, calls } = fakeServices({ projectTrusted: false });
    const ensure = getAction(createWorkspaceHostActions(services), "workspace.ensure");
    await expectRejects(
      ensure.execute({ projectPath: "/proj", key: "issue-1", trunkBranch: "main" }, ctx),
      /not registered and trusted/
    );
    expect(calls.create).not.toHaveBeenCalled();
  });

  test("sanitizes work-item keys into valid workspace branch names", async () => {
    const { services, calls } = fakeServices();
    const ensure = getAction(createWorkspaceHostActions(services), "workspace.ensure");
    await ensure.execute({ projectPath: "/proj", key: "PROJ-123.v2", trunkBranch: "main" }, ctx);
    expect(calls.create.mock.calls[0]?.[1]).toBe("proj-123-v2");
  });

  test("rejects when aborted before any mutation", async () => {
    const { services, calls } = fakeServices();
    const ensure = getAction(createWorkspaceHostActions(services), "workspace.ensure");
    const controller = new AbortController();
    controller.abort();
    await expectRejects(
      ensure.execute(
        { projectPath: "/proj", key: "issue-1", trunkBranch: "main" },
        { cwd: "/tmp", abortSignal: controller.signal }
      ),
      /aborted/
    );
    expect(calls.create).not.toHaveBeenCalled();
  });

  test("idempotency is scoped per project: the same key in another project does not match", async () => {
    // Work-item keys are only unique per source; a tagged workspace in a
    // DIFFERENT project must not satisfy this project's ensure.
    const { services, calls } = fakeServices({
      workspaces: [
        workspaceMeta({
          id: "other-project-ws",
          projectPath: "/other",
          tags: { [WORK_ITEM_TAG_KEY]: "issue-1" },
        }),
      ],
    });
    const ensure = getAction(createWorkspaceHostActions(services), "workspace.ensure");

    const output = (await ensure.execute(
      { projectPath: "/proj", key: "issue-1", trunkBranch: "main" },
      ctx
    )) as { created: boolean; workspaceId: string };
    expect(output.created).toBe(true);
    expect(output.workspaceId).not.toBe("other-project-ws");
    expect(calls.create).toHaveBeenCalledTimes(1);

    // Same project + same key now matches the newly created workspace.
    const second = (await ensure.execute(
      { projectPath: "/proj", key: "issue-1", trunkBranch: "main" },
      ctx
    )) as { created: boolean };
    expect(second.created).toBe(false);
    expect(calls.create).toHaveBeenCalledTimes(1);
  });
});

describe("deriveEnsureBranchName", () => {
  test("normalizes to validateWorkspaceName's charset", () => {
    expect(deriveEnsureBranchName("PROJ-123")).toBe("proj-123");
    expect(deriveEnsureBranchName("release/v1.2")).toBe("release-v1-2");
    expect(deriveEnsureBranchName("fix: crash -- on   save")).toBe("fix-crash-on-save");
  });

  test("truncates long keys to 64 chars with a stable disambiguating hash", () => {
    const long = `issue-${"a".repeat(80)}`;
    const branch = deriveEnsureBranchName(long);
    expect(branch.length).toBeLessThanOrEqual(64);
    expect(branch).toMatch(/^[a-z0-9_-]+$/);
    expect(branch).toBe(deriveEnsureBranchName(long));
    // Distinct long keys sharing a 55-char prefix must not collide.
    expect(branch).not.toBe(deriveEnsureBranchName(`${long}-different`));
  });

  test("falls back to a hash-only name when nothing survives sanitizing", () => {
    expect(deriveEnsureBranchName("###")).toMatch(/^work-item-[0-9a-f]{8}$/);
  });
});

describe("workspace.list", () => {
  const workspaces = [
    workspaceMeta({ id: "live", tags: { team: "a" } }),
    workspaceMeta({ id: "archived", tags: { team: "a" }, archivedAt: new Date().toISOString() }),
    workspaceMeta({ id: "other-tag", tags: { team: "b" } }),
    workspaceMeta({ id: "untagged" }),
  ];

  test("filters archived by default and supports tag key/value filters", async () => {
    const { services } = fakeServices({ workspaces });
    const list = getAction(createWorkspaceHostActions(services), "workspace.list");

    const all = (await list.execute({}, ctx)) as { workspaces: Array<{ workspaceId: string }> };
    expect(all.workspaces.map((w) => w.workspaceId)).toEqual(["live", "other-tag", "untagged"]);

    const withArchived = (await list.execute({ includeArchived: true, tagKey: "team" }, ctx)) as {
      workspaces: Array<{ workspaceId: string }>;
    };
    expect(withArchived.workspaces.map((w) => w.workspaceId)).toEqual([
      "live",
      "archived",
      "other-tag",
    ]);

    const exact = (await list.execute({ tagKey: "team", tagValue: "b" }, ctx)) as {
      workspaces: Array<{ workspaceId: string }>;
    };
    expect(exact.workspaces.map((w) => w.workspaceId)).toEqual(["other-tag"]);
  });

  test("rejects tagValue without tagKey instead of silently returning everything", async () => {
    const { services } = fakeServices({ workspaces });
    const list = getAction(createWorkspaceHostActions(services), "workspace.list");
    await expectRejects(list.execute({ tagValue: "a" }, ctx), /tagValue requires tagKey/);
  });
});

describe("workspace.sendMessage", () => {
  test("falls back to workspace agent settings, then the global default model", async () => {
    const { services, calls } = fakeServices({
      workspaces: [
        workspaceMeta({
          id: "with-settings",
          aiSettingsByAgent: { exec: { model: "ws:model", thinkingLevel: "off" } },
        }),
        workspaceMeta({ id: "bare" }),
      ],
    });
    const send = getAction(createWorkspaceHostActions(services), "workspace.sendMessage");

    const fromWorkspace = (await send.execute(
      { workspaceId: "with-settings", message: "hi" },
      ctx
    )) as { model: string };
    expect(fromWorkspace.model).toBe("ws:model");

    const fromGlobal = (await send.execute({ workspaceId: "bare", message: "hi" }, ctx)) as {
      model: string;
    };
    expect(fromGlobal.model).toBe("test:default-model");
    expect(calls.sendMessage).toHaveBeenCalledTimes(2);
  });

  test("surfaces sendMessage failures as errors", async () => {
    const { services, calls } = fakeServices({ workspaces: [workspaceMeta({ id: "bare" })] });
    calls.sendMessage.mockResolvedValueOnce(Err({ kind: "unknown", message: "boom" }) as never);
    const send = getAction(createWorkspaceHostActions(services), "workspace.sendMessage");
    await expectRejects(
      send.execute({ workspaceId: "bare", message: "hi" }, ctx),
      /workspace.sendMessage failed/
    );
  });

  test("defaults to the workspace's persisted agent instead of overwriting it with exec", async () => {
    const { services } = fakeServices({
      workspaces: [
        workspaceMeta({ id: "explorer", agentId: "explore" }),
        workspaceMeta({ id: "planner", agentId: "plan" }),
      ],
    });
    const send = getAction(createWorkspaceHostActions(services), "workspace.sendMessage");

    // Persisted agent wins over the exec default…
    const persisted = (await send.execute({ workspaceId: "explorer", message: "hi" }, ctx)) as {
      agentId: string;
    };
    expect(persisted.agentId).toBe("explore");

    // …but plan/compact are UI modes, not send targets: normalize to exec.
    const planFallback = (await send.execute({ workspaceId: "planner", message: "hi" }, ctx)) as {
      agentId: string;
    };
    expect(planFallback.agentId).toBe("exec");

    // Explicit input always wins.
    const explicit = (await send.execute(
      { workspaceId: "explorer", message: "hi", agentId: "exec" },
      ctx
    )) as { agentId: string };
    expect(explicit.agentId).toBe("exec");
  });
});

describe("workspace.awaitIdle", () => {
  test("returns immediately when the workspace is idle", async () => {
    const { services } = fakeServices({ workspaces: [workspaceMeta({ id: "ws-1" })] });
    const awaitIdle = getAction(createWorkspaceHostActions(services), "workspace.awaitIdle");
    const output = (await awaitIdle.execute({ workspaceId: "ws-1" }, ctx)) as { idle: boolean };
    expect(output.idle).toBe(true);
  });

  test("reports idle=false when the timeout elapses while busy", async () => {
    const { services } = fakeServices({
      workspaces: [workspaceMeta({ id: "ws-1" })],
      runtimeState: { isBusy: true, hasQueuedMessages: false, isInitializing: false },
    });
    const awaitIdle = getAction(createWorkspaceHostActions(services), "workspace.awaitIdle");
    const output = (await awaitIdle.execute({ workspaceId: "ws-1", timeoutMs: 200 }, ctx)) as {
      idle: boolean;
      waitedMs: number;
    };
    expect(output.idle).toBe(false);
    expect(output.waitedMs).toBeGreaterThanOrEqual(200);
  });

  test("throws on abort instead of returning a durable idle=false result", async () => {
    const { services } = fakeServices({
      workspaces: [workspaceMeta({ id: "ws-1" })],
      runtimeState: { isBusy: true, hasQueuedMessages: false, isInitializing: false },
    });
    const awaitIdle = getAction(createWorkspaceHostActions(services), "workspace.awaitIdle");
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30);
    await expectRejects(
      awaitIdle.execute(
        { workspaceId: "ws-1", timeoutMs: 60_000 },
        { cwd: "/tmp", abortSignal: controller.signal }
      ),
      /aborted/
    );
  });
});

describe("workspace.getLatestAssistantMessage", () => {
  test("returns the newest assistant text, skipping trailing non-assistant turns", async () => {
    const { services } = fakeServices({
      history: [
        {
          id: "m1",
          role: "assistant",
          parts: [{ type: "text", text: "old answer" }],
          metadata: { timestamp: 1 },
        },
        {
          id: "m2",
          role: "assistant",
          parts: [{ type: "text", text: "final answer" }],
          metadata: { timestamp: 2 },
        },
        { id: "m3", role: "user", parts: [{ type: "text", text: "thanks" }], metadata: {} },
      ] as unknown as MuxMessage[],
    });
    const action = getAction(
      createWorkspaceHostActions(services),
      "workspace.getLatestAssistantMessage"
    );
    const output = (await action.execute({ workspaceId: "ws-1" }, ctx)) as {
      found: boolean;
      messageId: string;
      text: string;
    };
    expect(output).toEqual({ found: true, messageId: "m2", text: "final answer" });
  });

  test("reports found=false when no assistant text exists", async () => {
    const { services } = fakeServices({ history: [] });
    const action = getAction(
      createWorkspaceHostActions(services),
      "workspace.getLatestAssistantMessage"
    );
    expect(await action.execute({ workspaceId: "ws-1" }, ctx)).toEqual({ found: false });
  });
});

describe("workspace.archive", () => {
  test("short-circuits when the workspace is already archived", async () => {
    const { services, calls } = fakeServices({
      workspaces: [workspaceMeta({ id: "ws-1", archivedAt: new Date().toISOString() })],
    });
    const archive = getAction(createWorkspaceHostActions(services), "workspace.archive");
    const output = await archive.execute({ workspaceId: "ws-1" }, ctx);
    expect(output).toEqual({ archived: true, alreadyArchived: true });
    expect(calls.archive).not.toHaveBeenCalled();
  });

  test("archives live workspaces and errors on unknown ids", async () => {
    const { services, calls } = fakeServices({ workspaces: [workspaceMeta({ id: "ws-1" })] });
    const archive = getAction(createWorkspaceHostActions(services), "workspace.archive");
    expect(await archive.execute({ workspaceId: "ws-1" }, ctx)).toEqual({
      archived: true,
      alreadyArchived: false,
    });
    expect(calls.archive).toHaveBeenCalledTimes(1);
    await expectRejects(archive.execute({ workspaceId: "missing" }, ctx), /not found/);
  });
});

describe("workspace.unarchive", () => {
  test("short-circuits when the workspace is already unarchived", async () => {
    const { services, calls } = fakeServices({ workspaces: [workspaceMeta({ id: "ws-1" })] });
    const unarchive = getAction(createWorkspaceHostActions(services), "workspace.unarchive");
    const output = await unarchive.execute({ workspaceId: "ws-1" }, ctx);
    expect(output).toEqual({ unarchived: true, alreadyUnarchived: true });
    expect(calls.unarchive).not.toHaveBeenCalled();
  });

  test("unarchives archived workspaces and errors on unknown ids", async () => {
    const { services, calls } = fakeServices({
      workspaces: [workspaceMeta({ id: "ws-1", archivedAt: new Date().toISOString() })],
    });
    const unarchive = getAction(createWorkspaceHostActions(services), "workspace.unarchive");
    expect(await unarchive.execute({ workspaceId: "ws-1" }, ctx)).toEqual({
      unarchived: true,
      alreadyUnarchived: false,
    });
    expect(calls.unarchive).toHaveBeenCalledTimes(1);
    await expectRejects(unarchive.execute({ workspaceId: "missing" }, ctx), /not found/);
  });
});
