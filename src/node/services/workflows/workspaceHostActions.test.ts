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
}

function fakeServices(options: FakeServiceOptions = {}) {
  const calls = {
    create: mock(
      (
        _projectPath: string,
        branchName: string | undefined,
        _trunkBranch: string | undefined,
        _title?: string,
        _runtimeConfig?: unknown,
        _subProjectPath?: string,
        _pendingAutoTitle?: boolean,
        tags?: Record<string, string>
      ) =>
        Promise.resolve(
          Ok({ metadata: workspaceMeta({ id: "created-ws", name: branchName ?? "x", tags }) })
        )
    ),
    sendMessage: mock(() => Promise.resolve(Ok(undefined))),
    archive: mock(() => Promise.resolve(Ok({ archived: true }))),
  };
  const services: WorkspaceHostActionServices = {
    workspaceService: {
      list: () => Promise.resolve(options.workspaces ?? []),
      create: calls.create as unknown as WorkspaceHostActionServices["workspaceService"]["create"],
      sendMessage:
        calls.sendMessage as unknown as WorkspaceHostActionServices["workspaceService"]["sendMessage"],
      archive:
        calls.archive as unknown as WorkspaceHostActionServices["workspaceService"]["archive"],
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
        projects: new Map(),
        defaultModel: "test:default-model",
      }),
      findWorkspace: (workspaceId: string) =>
        (options.workspaces ?? []).some((w) => w.id === workspaceId)
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
    )) as { created: boolean; workspaceId: string };
    expect(output.created).toBe(true);
    expect(output.workspaceId).toBe("created-ws");
    expect(calls.create).toHaveBeenCalledTimes(1);
    const tags = calls.create.mock.calls[0][7];
    expect(tags).toEqual({ [WORK_ITEM_TAG_KEY]: "issue-1-investigate" });
  });

  test("is idempotent: an existing tagged workspace (even archived) blocks creation", async () => {
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
    const output = (await ensure.execute(
      { projectPath: "/proj", key: "issue-1-investigate", trunkBranch: "main" },
      ctx
    )) as { created: boolean; workspaceId: string; archived: boolean };
    expect(output).toEqual({ created: false, workspaceId: "existing", archived: true });
    expect(calls.create).not.toHaveBeenCalled();
  });

  test("reconcile re-runs the idempotent ensure", () => {
    const { services } = fakeServices();
    const ensure = getAction(createWorkspaceHostActions(services), "workspace.ensure");
    expect(ensure.reconcile).toBe(ensure.execute);
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
    const output = (await awaitIdle.execute({ workspaceId: "ws-1", timeoutMs: 700 }, ctx)) as {
      idle: boolean;
      waitedMs: number;
    };
    expect(output.idle).toBe(false);
    expect(output.waitedMs).toBeGreaterThanOrEqual(700);
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
