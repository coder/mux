import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { TerminalAttentionStore } from "@/node/services/terminalAttentionStore";

function makeConfig(rootDir: string): {
  sessionsDir: string;
  getSessionDir: (id: string) => string;
} {
  const sessionsDir = path.join(rootDir, "sessions");
  return { sessionsDir, getSessionDir: (id: string) => path.join(sessionsDir, id) };
}

describe("TerminalAttentionStore", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "terminal-attention-"));
  });

  afterEach(async () => {
    await fsPromises.rm(rootDir, { recursive: true, force: true });
  });

  test("enqueueIfAbsent persists a pending notification and reloads it", async () => {
    const store = new TerminalAttentionStore(makeConfig(rootDir));
    const created = await store.enqueueIfAbsent({
      ownerWorkspaceId: "owner-1",
      sourceKind: "workspace_turn",
      sourceId: "wst_abc",
      outputDelivery: "requires_task_await",
      terminalOutcome: "completed",
    });
    expect(created).not.toBeNull();
    expect(created?.status).toBe("pending");

    const pending = await store.listPending("owner-1");
    expect(pending.map((n) => n.sourceId)).toEqual(["wst_abc"]);
  });

  test("enqueueIfAbsent is idempotent by source kind + id", async () => {
    const store = new TerminalAttentionStore(makeConfig(rootDir));
    const base = {
      ownerWorkspaceId: "owner-1",
      sourceKind: "agent_task" as const,
      sourceId: "task-1",
      outputDelivery: "already_injected" as const,
      terminalOutcome: "completed" as const,
    };
    const first = await store.enqueueIfAbsent(base);
    const second = await store.enqueueIfAbsent(base);
    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(await store.listPending("owner-1")).toHaveLength(1);
  });

  test("delivered notifications are not redelivered and survive reload", async () => {
    const config = makeConfig(rootDir);
    const store = new TerminalAttentionStore(config);
    const created = await store.enqueueIfAbsent({
      ownerWorkspaceId: "owner-1",
      sourceKind: "workspace_turn",
      sourceId: "wst_done",
      outputDelivery: "requires_task_await",
      terminalOutcome: "completed",
    });
    await store.markDelivered("owner-1", created!.id);

    // Reload via a fresh store instance to prove durability.
    const reloaded = new TerminalAttentionStore(config);
    expect(await reloaded.listPending("owner-1")).toHaveLength(0);
    // Re-enqueue is suppressed because the delivered record still exists.
    expect(
      await reloaded.enqueueIfAbsent({
        ownerWorkspaceId: "owner-1",
        sourceKind: "workspace_turn",
        sourceId: "wst_done",
        outputDelivery: "requires_task_await",
        terminalOutcome: "completed",
      })
    ).toBeNull();
  });

  test("listPending coalesces and orders multiple sources for one owner", async () => {
    const store = new TerminalAttentionStore(makeConfig(rootDir));
    await store.enqueueIfAbsent({
      ownerWorkspaceId: "owner-1",
      sourceKind: "agent_task",
      sourceId: "task-a",
      outputDelivery: "already_injected",
      terminalOutcome: "completed",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    await store.enqueueIfAbsent({
      ownerWorkspaceId: "owner-1",
      sourceKind: "workspace_turn",
      sourceId: "wst-b",
      outputDelivery: "requires_task_await",
      terminalOutcome: "completed",
      createdAt: "2026-01-01T00:00:01.000Z",
    });
    const pending = await store.listPending("owner-1");
    expect(pending.map((n) => n.sourceId)).toEqual(["task-a", "wst-b"]);
  });

  test("listPendingOwnerWorkspaceIds finds pending notifications across session dirs", async () => {
    const store = new TerminalAttentionStore(makeConfig(rootDir));
    await store.enqueueIfAbsent({
      ownerWorkspaceId: "owner-b",
      sourceKind: "workspace_turn",
      sourceId: "wst-b",
      outputDelivery: "requires_task_await",
      terminalOutcome: "completed",
    });
    const delivered = await store.enqueueIfAbsent({
      ownerWorkspaceId: "owner-a",
      sourceKind: "agent_task",
      sourceId: "task-a",
      outputDelivery: "already_injected",
      terminalOutcome: "completed",
    });
    expect(delivered).not.toBeNull();
    await store.markDelivered("owner-a", delivered!.id);
    await fsPromises.mkdir(path.join(rootDir, "sessions", "owner-empty"), { recursive: true });

    expect(await store.listPendingOwnerWorkspaceIds()).toEqual(["owner-b"]);
  });
});
