import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type { ExecutionHandle } from "@/common/types/execution";
import { Config } from "@/node/config";
import { EXECUTIONS_DIR, ExecutionStore } from "@/node/services/executionStore";

function handle(overrides: Partial<ExecutionHandle> = {}): ExecutionHandle {
  return {
    version: 1,
    executionId: "exe_test",
    aliases: ["legacy-task"],
    ownerSessionId: "owner",
    requesterWorkspaceId: "requester",
    target: { kind: "workspace", workspaceId: "child", origin: "created" },
    launchPolicy: { kind: "agent_task", agentId: "exec", prompt: "Implement" },
    completionPolicy: { kind: "final_assistant_message" },
    retentionPolicy: { kind: "delete_workspace_on_completion" },
    attentionPolicy: "blocking_until_terminal",
    status: "running",
    createdAt: "2026-08-06T00:00:00.000Z",
    updatedAt: "2026-08-06T00:00:01.000Z",
    startedAt: "2026-08-06T00:00:01.000Z",
    ...overrides,
  };
}

describe("ExecutionStore", () => {
  let rootDir: string;
  let config: Config;
  let store: ExecutionStore;

  beforeEach(async () => {
    rootDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mux-execution-store-"));
    config = new Config(rootDir);
    store = new ExecutionStore(config);
  });

  afterEach(async () => {
    await fsPromises.rm(rootDir, { recursive: true, force: true });
  });

  test("atomically upserts, lists, gets, and deletes owner-scoped handles", async () => {
    const first = handle();
    const second = handle({
      executionId: "exe_second",
      aliases: undefined,
      status: "completed",
      result: { kind: "completed", reportMarkdown: "Done" },
      terminalAt: "2026-08-06T00:00:02.000Z",
      updatedAt: "2026-08-06T00:00:02.000Z",
    });

    await Promise.all([store.upsert(first), store.upsert(second)]);

    expect(await store.get("owner", first.executionId)).toEqual(first);
    expect(
      (await store.list("owner", { statuses: ["completed"] })).map((item) => item.executionId)
    ).toEqual(["exe_second"]);
    expect(await store.get("other", first.executionId)).toBeNull();

    const entries = await fsPromises.readdir(
      path.join(config.getSessionDir("owner"), EXECUTIONS_DIR)
    );
    expect(entries.sort()).toEqual(["exe_second.json", "exe_test.json"]);
    expect(entries.some((entry) => entry.includes(".tmp"))).toBe(false);

    await store.delete("owner", first.executionId);
    expect(await store.get("owner", first.executionId)).toBeNull();
  });

  test("rejects unsafe owner and execution path components", () => {
    expect(store.list("../owner")).rejects.toThrow("safe path component");
    expect(store.upsert(handle({ ownerSessionId: "owner/child" }))).rejects.toThrow(
      "safe path component"
    );
    expect(store.delete("owner", "../exe_test")).rejects.toThrow("valid execution ID");
  });

  test("filters corrupt, malformed, and mismatched records", async () => {
    const dir = path.join(config.getSessionDir("owner"), EXECUTIONS_DIR);
    await fsPromises.mkdir(dir, { recursive: true });
    await fsPromises.writeFile(path.join(dir, "exe_corrupt.json"), "not json");
    await fsPromises.writeFile(
      path.join(dir, "exe_malformed.json"),
      JSON.stringify({ version: 1, executionId: "exe_malformed" })
    );
    await fsPromises.writeFile(
      path.join(dir, "exe_mismatch.json"),
      JSON.stringify(handle({ executionId: "exe_other" }))
    );

    expect(await store.list("owner")).toEqual([]);
    expect(await store.get("owner", "exe_corrupt")).toBeNull();
  });
});
