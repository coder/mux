import { afterEach, describe, expect, mock, test } from "bun:test";

import type { APIClient } from "@/browser/contexts/API";
import type { WorkflowDefinitionDescriptor, WorkflowRunRecord } from "@/common/types/workflow";

import { WORKFLOW_RUN_POLL_INTERVAL_MS, WorkflowStore } from "./WorkflowStore";

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

function createClient(input: {
  definitions?: WorkflowDefinitionDescriptor[];
  runs?: WorkflowRunRecord[];
  runDetails?: WorkflowRunRecord[];
}) {
  const calls = {
    listDefinitions: mock(() => Promise.resolve(input.definitions ?? [])),
    listRuns: mock(() => Promise.resolve(input.runs ?? [])),
    getRun: mock(() => Promise.resolve(input.runDetails?.shift() ?? input.runs?.[0] ?? null)),
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

async function waitForStoreSnapshot(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (predicate()) return;
    await Bun.sleep(1);
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
    const store = new WorkflowStore();
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
    const store = new WorkflowStore();
    store.setClient(client);

    const unsubscribe = store.subscribeWorkspace("workspace-1", () => undefined);
    await waitForStoreSnapshot(() => store.getWorkspaceSnapshot("workspace-1").runs.length === 1);
    await Bun.sleep(WORKFLOW_RUN_POLL_INTERVAL_MS + 20);
    await waitForStoreSnapshot(
      () => store.getWorkspaceSnapshot("workspace-1").runs[0]?.status === "completed"
    );

    expect(calls.getRun).toHaveBeenCalledTimes(1);
    expect(store.getWorkspaceSnapshot("workspace-1").runs[0]?.status).toBe("completed");

    unsubscribe();
    await Bun.sleep(WORKFLOW_RUN_POLL_INTERVAL_MS + 20);

    expect(calls.getRun).toHaveBeenCalledTimes(1);
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
    const store = new WorkflowStore();
    store.setClient(client);

    const unsubscribe = store.subscribeWorkspace("workspace-1", () => undefined);
    await waitForStoreSnapshot(() => store.getWorkspaceSnapshot("workspace-1").runs.length === 1);
    const initialSummary = store.getWorkspaceSummary("workspace-1");

    await Bun.sleep(WORKFLOW_RUN_POLL_INTERVAL_MS + 20);
    await waitForStoreSnapshot(
      () => store.getWorkspaceSnapshot("workspace-1").runs[0]?.events.length === 1
    );

    expect(store.getWorkspaceSummary("workspace-1")).toBe(initialSummary);

    unsubscribe();
    store.dispose();
  });
});
