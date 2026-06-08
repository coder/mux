import { afterEach, describe, expect, mock, test } from "bun:test";

import type { APIClient } from "@/browser/contexts/API";
import type { WorkflowDefinitionDescriptor, WorkflowRunRecord } from "@/common/types/workflow";

import { WorkflowStore } from "./WorkflowStore";

function definition(
  name: string,
  scope: WorkflowDefinitionDescriptor["scope"]
): WorkflowDefinitionDescriptor {
  return { name, scope, description: `${name} workflow`, executable: true };
}

function run(overrides: Partial<WorkflowRunRecord>): WorkflowRunRecord {
  return {
    id: "wfr_test",
    workspaceId: "workspace-1",
    definition: definition("demo", "project"),
    definitionSource: "/repo/.mux/workflows/demo.js",
    definitionHash: "hash",
    args: {},
    status: "running",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    events: [],
    steps: [],
    ...overrides,
  };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function createClient(input: {
  definitions?: WorkflowDefinitionDescriptor[];
  runs?: WorkflowRunRecord[];
  runDetails?: Array<WorkflowRunRecord | null | Error>;
  listDefinitions?: () => Promise<WorkflowDefinitionDescriptor[]>;
  listRuns?: () => Promise<WorkflowRunRecord[]>;
}) {
  const calls = {
    listDefinitions: mock(
      input.listDefinitions ?? (() => Promise.resolve(input.definitions ?? []))
    ),
    listRuns: mock(input.listRuns ?? (() => Promise.resolve(input.runs ?? []))),
    getRun: mock(() => {
      const next = input.runDetails?.shift();
      if (next instanceof Error) return Promise.reject(next);
      return Promise.resolve(next ?? input.runs?.[0] ?? null);
    }),
  };
  const client = {
    workflows: {
      listDefinitions: calls.listDefinitions,
      listRuns: calls.listRuns,
      getRun: calls.getRun,
    },
  } as unknown as APIClient;
  return { client, calls };
}

function createFastStore(options: { workspaceRefreshIntervalMs?: number } = {}) {
  return new WorkflowStore({
    runPollIntervalMs: 1,
    workspaceRefreshIntervalMs: options.workspaceRefreshIntervalMs ?? 1_000,
  });
}

async function waitForStoreSnapshot(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt++) {
    if (predicate()) return;
    await Bun.sleep(2);
  }
  throw new Error("Timed out waiting for workflow store snapshot");
}

describe("WorkflowStore", () => {
  afterEach(() => {
    mock.restore();
  });

  test("deduplicates workspace snapshot loading for duplicate subscribers", async () => {
    const { client, calls } = createClient({
      definitions: [definition("project-flow", "project"), definition("scratch-flow", "scratch")],
      runs: [run({ id: "wfr_running", status: "running" })],
    });
    const store = createFastStore();
    store.setClient(client);

    const unsubscribeA = store.subscribeWorkspace("workspace-1", () => undefined);
    const unsubscribeB = store.subscribeWorkspace("workspace-1", () => undefined);
    await waitForStoreSnapshot(
      () => store.getWorkspaceSnapshot("workspace-1").definitionGroups.scratch.length === 1
    );

    expect(calls.listDefinitions).toHaveBeenCalledTimes(1);
    expect(calls.listRuns).toHaveBeenCalledTimes(1);
    expect(store.getWorkspaceSnapshot("workspace-1").definitionGroups.scratch).toHaveLength(1);

    unsubscribeA();
    unsubscribeB();
    store.dispose();
  });

  test("polls active run details while subscribed and stops after the last subscriber leaves", async () => {
    const { client, calls } = createClient({
      definitions: [],
      runs: [run({ id: "wfr_running", status: "running" })],
      runDetails: [run({ id: "wfr_running", status: "completed" })],
    });
    const store = createFastStore();
    store.setClient(client);

    const unsubscribe = store.subscribeWorkspace("workspace-1", () => undefined);
    await waitForStoreSnapshot(
      () => store.getWorkspaceSnapshot("workspace-1").runs[0]?.status === "completed"
    );

    expect(calls.getRun).toHaveBeenCalledTimes(1);
    expect(store.getWorkspaceSnapshot("workspace-1").runs[0]?.status).toBe("completed");

    unsubscribe();
    await Bun.sleep(5);

    expect(calls.getRun).toHaveBeenCalledTimes(1);
    store.dispose();
  });

  test("restarts active-run polling when a cached workspace is resubscribed", async () => {
    const { client, calls } = createClient({
      definitions: [],
      runs: [run({ id: "wfr_running", status: "running" })],
      runDetails: [run({ id: "wfr_running", status: "completed" })],
    });
    const store = new WorkflowStore({ runPollIntervalMs: 20, workspaceRefreshIntervalMs: 1_000 });
    store.setClient(client);

    const unsubscribeFirst = store.subscribeWorkspace("workspace-1", () => undefined);
    await waitForStoreSnapshot(() => store.getWorkspaceSnapshot("workspace-1").runs.length === 1);
    unsubscribeFirst();
    await Bun.sleep(5);
    expect(calls.getRun).toHaveBeenCalledTimes(0);

    const unsubscribeSecond = store.subscribeWorkspace("workspace-1", () => undefined);
    await waitForStoreSnapshot(
      () => store.getWorkspaceSnapshot("workspace-1").runs[0]?.status === "completed"
    );

    expect(calls.getRun).toHaveBeenCalledTimes(1);
    unsubscribeSecond();
    store.dispose();
  });

  test("keeps summary snapshots stable for event-only active run updates", async () => {
    const running = run({ id: "wfr_running", status: "running" });
    const { client } = createClient({
      definitions: [],
      runs: [running],
      runDetails: [
        run({
          id: "wfr_running",
          status: "running",
          events: [{ type: "log", at: "2026-01-01T00:00:01.000Z", sequence: 1, message: "tick" }],
          updatedAt: "2026-01-01T00:00:01.000Z",
        }),
      ],
    });
    const store = createFastStore();
    store.setClient(client);

    const unsubscribe = store.subscribeWorkspace("workspace-1", () => undefined);
    await waitForStoreSnapshot(() => store.getWorkspaceSnapshot("workspace-1").runs.length === 1);
    const initialSummary = store.getWorkspaceSummary("workspace-1");

    await waitForStoreSnapshot(
      () => store.getWorkspaceSnapshot("workspace-1").runs[0]?.events.length === 1
    );

    expect(store.getWorkspaceSummary("workspace-1")).toBe(initialSummary);

    unsubscribe();
    store.dispose();
  });

  test("discovers externally-created runs from periodic workspace refreshes", async () => {
    let listRunsCallCount = 0;
    const externalRun = run({ id: "wfr_external", status: "running" });
    const { client, calls } = createClient({
      definitions: [],
      listRuns: () => Promise.resolve(listRunsCallCount++ === 0 ? [] : [externalRun]),
    });
    const store = createFastStore({ workspaceRefreshIntervalMs: 1 });
    store.setClient(client);

    const unsubscribe = store.subscribeWorkspace("workspace-1", () => undefined);
    await waitForStoreSnapshot(() => store.getWorkspaceSnapshot("workspace-1").runs.length === 1);

    expect(calls.listRuns.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(store.getWorkspaceSnapshot("workspace-1").runs[0]?.id).toBe("wfr_external");

    unsubscribe();
    store.dispose();
  });

  test("queues invalidation requests that arrive during an in-flight snapshot load", async () => {
    const firstRuns = createDeferred<WorkflowRunRecord[]>();
    let listRunsCallCount = 0;
    const afterActionRun = run({ id: "wfr_after_action", status: "running" });
    const { client, calls } = createClient({
      definitions: [],
      listRuns: () => {
        listRunsCallCount++;
        return listRunsCallCount === 1 ? firstRuns.promise : Promise.resolve([afterActionRun]);
      },
    });
    const store = createFastStore();
    store.setClient(client);

    const unsubscribe = store.subscribeWorkspace("workspace-1", () => undefined);
    await waitForStoreSnapshot(() => calls.listRuns.mock.calls.length === 1);
    store.invalidateWorkspace("workspace-1");
    firstRuns.resolve([]);

    await waitForStoreSnapshot(() => store.getWorkspaceSnapshot("workspace-1").runs.length === 1);

    expect(calls.listRuns).toHaveBeenCalledTimes(2);
    expect(store.getWorkspaceSnapshot("workspace-1").runs[0]?.id).toBe("wfr_after_action");

    unsubscribe();
    store.dispose();
  });

  test("preserves cached data and surfaces an error when list refreshes fail", async () => {
    let listDefinitionsCallCount = 0;
    let listRunsCallCount = 0;
    const cachedDefinition = definition("project-flow", "project");
    const cachedRun = run({ id: "wfr_cached", status: "running" });
    const { client } = createClient({
      listDefinitions: () => {
        listDefinitionsCallCount++;
        return listDefinitionsCallCount === 1
          ? Promise.resolve([cachedDefinition])
          : Promise.reject(new Error("definitions unavailable"));
      },
      listRuns: () => {
        listRunsCallCount++;
        return listRunsCallCount === 1
          ? Promise.resolve([cachedRun])
          : Promise.reject(new Error("runs unavailable"));
      },
    });
    const store = createFastStore();
    store.setClient(client);

    const unsubscribe = store.subscribeWorkspace("workspace-1", () => undefined);
    await waitForStoreSnapshot(() => store.getWorkspaceSnapshot("workspace-1").runs.length === 1);
    store.invalidateWorkspace("workspace-1");

    await waitForStoreSnapshot(() => store.getWorkspaceSnapshot("workspace-1").error != null);
    const failedRefreshSnapshot = store.getWorkspaceSnapshot("workspace-1");

    expect(failedRefreshSnapshot.definitions).toEqual([cachedDefinition]);
    expect(failedRefreshSnapshot.runs.map((candidate) => candidate.id)).toContain("wfr_cached");
    expect(failedRefreshSnapshot.error).toContain("definitions unavailable");
    expect(failedRefreshSnapshot.error).toContain("runs unavailable");

    unsubscribe();
    store.dispose();
  });

  test("keeps polling active runs after null or rejected getRun responses", async () => {
    const { client, calls } = createClient({
      definitions: [],
      runs: [run({ id: "wfr_running", status: "running" })],
      runDetails: [
        null,
        new Error("transient transport failure"),
        run({ id: "wfr_running", status: "completed" }),
      ],
    });
    const store = createFastStore();
    store.setClient(client);

    const unsubscribe = store.subscribeWorkspace("workspace-1", () => undefined);
    await waitForStoreSnapshot(
      () => store.getWorkspaceSnapshot("workspace-1").runs[0]?.status === "completed"
    );

    expect(calls.getRun).toHaveBeenCalledTimes(3);
    expect(store.getWorkspaceSnapshot("workspace-1").error).toBeNull();

    unsubscribe();
    store.dispose();
  });
});
