import { describe, expect, it } from "bun:test";

import { AskUserQuestionManager } from "@/node/services/askUserQuestionManager";

const QUESTIONS = [
  {
    question: "What should we do?",
    header: "Next",
    options: [
      { label: "A", description: "Option A" },
      { label: "B", description: "Option B" },
    ],
    multiSelect: false,
  },
];

describe("AskUserQuestionManager", () => {
  it("resolves when answered", async () => {
    const manager = new AskUserQuestionManager({ timeoutMs: 1000 });

    const promise = manager.registerPending("ws", "tool-1", [...QUESTIONS]);
    manager.answer("ws", "tool-1", { "What should we do?": "A" });

    const answers = await promise;
    expect(answers).toEqual({ "What should we do?": "A" });
    expect(manager.getLatestPending("ws")).toBeNull();
  });

  it("rejects when canceled", async () => {
    const manager = new AskUserQuestionManager({ timeoutMs: 1000 });

    const promise = manager.registerPending("ws", "tool-1", [...QUESTIONS]);

    // Attach handler *before* cancel to avoid Bun treating the rejection as unhandled.
    const caught = promise.catch((err: unknown) => err);

    manager.cancel("ws", "tool-1", "User canceled");

    const error = await caught;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("User canceled");
    expect(manager.getLatestPending("ws")).toBeNull();
  });

  it("tracks latest pending per workspace", async () => {
    const manager = new AskUserQuestionManager({ timeoutMs: 1000 });

    const promise1 = manager.registerPending("ws", "tool-1", [...QUESTIONS]);
    await new Promise((r) => setTimeout(r, 5));
    const promise2 = manager.registerPending("ws", "tool-2", [...QUESTIONS]);

    expect(manager.getLatestPending("ws")?.toolCallId).toEqual("tool-2");

    // Attach handlers *before* cancel to avoid Bun treating the rejection as unhandled.
    const caught1 = promise1.catch((err: unknown) => err);
    const caught2 = promise2.catch((err: unknown) => err);

    manager.cancel("ws", "tool-1", "cleanup");
    manager.cancel("ws", "tool-2", "cleanup");

    const error1 = await caught1;
    const error2 = await caught2;

    expect(error1).toBeInstanceOf(Error);
    expect(error2).toBeInstanceOf(Error);
  });

  it("times out and cleans up", async () => {
    const manager = new AskUserQuestionManager({ timeoutMs: 10 });

    const promise = manager.registerPending("ws", "tool-1", [...QUESTIONS]);

    let error: unknown;
    try {
      await promise;
      throw new Error("Expected promise to reject");
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("Timed out");
    expect(manager.getLatestPending("ws")).toBeNull();
  });
});
