import { describe, expect, it } from "bun:test";
import * as fsPromises from "fs/promises";
import * as os from "os";
import * as path from "path";

import { Config } from "@/node/config";
import { TaskHandleStore, WORKSPACE_TURN_TASK_ID_PREFIX } from "@/node/services/taskHandleStore";

async function createTempConfig(testName: string): Promise<{ config: Config; rootDir: string }> {
  const rootDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), `${testName}-`));
  const config = new Config(rootDir);
  await fsPromises.mkdir(config.srcDir, { recursive: true });
  return { config, rootDir };
}

describe("TaskHandleStore", () => {
  it("persists and lists owner-scoped workspace turn handles", async () => {
    const { config } = await createTempConfig("task-handle-store-persist");
    const store = new TaskHandleStore(config);

    await store.upsertWorkspaceTurn({
      kind: "workspace_turn",
      handleId: `${WORKSPACE_TURN_TASK_ID_PREFIX}abc`,
      ownerWorkspaceId: "owner",
      workspaceId: "child",
      turnId: "turn-1",
      status: "running",
      createdAt: "2026-06-19T00:00:00.000Z",
      updatedAt: "2026-06-19T00:00:00.000Z",
      createdWorkspace: true,
      disposableWorkspace: false,
      title: "Summary",
      prompt: "Summarize",
    });

    const record = await store.getWorkspaceTurn("owner", `${WORKSPACE_TURN_TASK_ID_PREFIX}abc`);
    expect(record?.workspaceId).toBe("child");

    expect(await store.getWorkspaceTurn("other", `${WORKSPACE_TURN_TASK_ID_PREFIX}abc`)).toBeNull();
    expect(await store.isWorkspaceOwnedBy("owner", "child")).toBe(true);
    expect(await store.isWorkspaceOwnedBy("other", "child")).toBe(false);

    const listed = await store.listWorkspaceTurns("owner", { statuses: ["running"] });
    expect(listed.map((item) => item.handleId)).toEqual([`${WORKSPACE_TURN_TASK_ID_PREFIX}abc`]);
  });

  it("scans ordinary and Project Chat session roots for restart handles", async () => {
    const { config } = await createTempConfig("task-handle-store-dual-root");
    const store = new TaskHandleStore(config);
    const records = [
      {
        kind: "workspace_turn" as const,
        handleId: `${WORKSPACE_TURN_TASK_ID_PREFIX}ordinary`,
        ownerWorkspaceId: "ordinary-owner",
        workspaceId: "ordinary-child",
        turnId: "ordinary-turn",
        status: "completed" as const,
        createdAt: "2026-06-19T00:00:00.000Z",
        updatedAt: "2026-06-19T00:00:00.000Z",
        createdWorkspace: true,
        disposableWorkspace: false,
      },
      {
        kind: "workspace_turn" as const,
        handleId: `${WORKSPACE_TURN_TASK_ID_PREFIX}project`,
        ownerWorkspaceId: "project-session_aaaaaaaaaa",
        workspaceId: "project-child",
        turnId: "project-turn",
        status: "completed" as const,
        createdAt: "2026-06-19T00:00:01.000Z",
        updatedAt: "2026-06-19T00:00:01.000Z",
        createdWorkspace: true,
        disposableWorkspace: false,
      },
    ];
    for (const record of records) {
      await store.upsertWorkspaceTurn(record);
    }

    expect((await store.listAllWorkspaceTurns()).map((record) => record.handleId)).toEqual([
      `${WORKSPACE_TURN_TASK_ID_PREFIX}ordinary`,
      `${WORKSPACE_TURN_TASK_ID_PREFIX}project`,
    ]);
  });

  it("persists workspace-turn attach_file descriptors across store restart", async () => {
    const { config } = await createTempConfig("task-handle-store-artifacts");
    const artifactPath = path.join(
      config.getSessionDir("owner"),
      "task-artifacts",
      `${WORKSPACE_TURN_TASK_ID_PREFIX}artifacts`,
      "chart.png"
    );
    const record = {
      kind: "workspace_turn" as const,
      handleId: `${WORKSPACE_TURN_TASK_ID_PREFIX}artifacts`,
      ownerWorkspaceId: "owner",
      workspaceId: "child",
      turnId: "turn-artifacts",
      status: "completed" as const,
      createdAt: "2026-06-19T00:00:00.000Z",
      updatedAt: "2026-06-19T00:00:01.000Z",
      createdWorkspace: true,
      disposableWorkspace: true,
      reportMarkdown: "Done",
      artifacts: {
        attachFiles: [
          {
            path: artifactPath,
            filename: "chart.png",
            mediaType: "image/png",
            sourceToolCallId: "attach-chart",
          },
        ],
      },
    };

    await new TaskHandleStore(config).upsertWorkspaceTurn(record);
    expect(await new TaskHandleStore(config).getWorkspaceTurn("owner", record.handleId)).toEqual(
      record
    );
  });

  it("rejects unsafe handle IDs before composing paths", async () => {
    const { config } = await createTempConfig("task-handle-store-unsafe-id");
    const store = new TaskHandleStore(config);
    const sessionDir = config.getSessionDir("owner");
    await fsPromises.mkdir(sessionDir, { recursive: true });
    await fsPromises.writeFile(
      path.join(sessionDir, "chat.json"),
      JSON.stringify({
        kind: "workspace_turn",
        handleId: `${WORKSPACE_TURN_TASK_ID_PREFIX}x/../../chat`,
        ownerWorkspaceId: "owner",
        workspaceId: "escaped",
        turnId: "turn-1",
        status: "completed",
        createdAt: "2026-06-19T00:00:00.000Z",
        updatedAt: "2026-06-19T00:00:00.000Z",
        createdWorkspace: true,
        disposableWorkspace: false,
      })
    );

    expect(
      await store.getWorkspaceTurn("owner", `${WORKSPACE_TURN_TASK_ID_PREFIX}x/../../chat`)
    ).toBeNull();
  });

  it("self-heals corrupt handle records by ignoring them", async () => {
    const { config } = await createTempConfig("task-handle-store-corrupt");
    const store = new TaskHandleStore(config);
    const sessionDir = config.getSessionDir("owner");
    await fsPromises.mkdir(path.join(sessionDir, "task-handles"), { recursive: true });
    await fsPromises.writeFile(
      path.join(sessionDir, "task-handles", `${WORKSPACE_TURN_TASK_ID_PREFIX}bad.json`),
      "not json"
    );

    expect(await store.getWorkspaceTurn("owner", `${WORKSPACE_TURN_TASK_ID_PREFIX}bad`)).toBeNull();
    expect(await store.listWorkspaceTurns("owner")).toEqual([]);
  });
});
