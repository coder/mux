import { describe, expect, it } from "bun:test";

import { DelegatedToolCallManager } from "@/node/services/delegatedToolCallManager";

describe("DelegatedToolCallManager", () => {
  it("resolves pending tool calls when answered", async () => {
    const manager = new DelegatedToolCallManager();

    const pending = manager.registerPending("ws", "tool-1", "bash");
    manager.answer("ws", "tool-1", { ok: true });

    expect(await pending).toEqual({ ok: true });
    expect(manager.getLatestPending("ws")).toBeNull();
  });

  it("rejects pending tool calls when canceled", async () => {
    const manager = new DelegatedToolCallManager();

    const pending = manager.registerPending("ws", "tool-1", "bash");
    const caught = pending.catch((error: unknown) => error);

    manager.cancel("ws", "tool-1", "Interrupted");

    const error = await caught;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("Interrupted");
  });

  it("tracks latest pending call per workspace", async () => {
    const manager = new DelegatedToolCallManager();

    const first = manager.registerPending("ws", "tool-1", "file_read");
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = manager.registerPending("ws", "tool-2", "bash");

    expect(manager.getLatestPending("ws")?.toolCallId).toBe("tool-2");

    const firstError = first.catch((error: unknown) => error);
    const secondError = second.catch((error: unknown) => error);

    manager.cancelAll("ws", "cleanup");

    expect(await firstError).toBeInstanceOf(Error);
    expect(await secondError).toBeInstanceOf(Error);
  });
});
