import { describe, expect, test } from "bun:test";
import { createMuxMessage, filterOrphanedMcpPromptSnapshots } from "./message";
import type { MuxMessage } from "./message";

function snapshot(id: string, invokingMessageId?: string, promptName = "review"): MuxMessage {
  return createMuxMessage(id, "user", `Expanded ${promptName}`, {
    historySequence: 0,
    synthetic: true,
    mcpPromptSnapshot: {
      serverName: "coder",
      promptName,
      commandKey: `mcp__coder__${promptName}`,
      ...(invokingMessageId !== undefined ? { invokingMessageId } : {}),
    },
  });
}

function invokingUser(id: string, promptNames: string[]): MuxMessage {
  return createMuxMessage(id, "user", "Using MCP prompt", {
    historySequence: 0,
    muxMetadata: {
      type: "normal",
      mcpPromptRefs: promptNames.map((promptName) => ({
        serverName: "coder",
        promptName,
        commandKey: `mcp__coder__${promptName}`,
        source: "slash" as const,
      })),
    },
  });
}

describe("filterOrphanedMcpPromptSnapshots", () => {
  test("keeps snapshots whose invoking user row is present", () => {
    const messages = [snapshot("snap-1", "user-1"), invokingUser("user-1", ["review"])];
    expect(filterOrphanedMcpPromptSnapshots(messages)).toEqual(messages);
  });

  test("drops a snapshot whose invoking user row was never persisted", () => {
    const assistant = createMuxMessage("assistant-1", "assistant", "done", {
      historySequence: 0,
    });
    const messages = [invokingUser("user-1", []), assistant, snapshot("snap-1", "user-never")];
    expect(filterOrphanedMcpPromptSnapshots(messages).map((m) => m.id)).toEqual([
      "user-1",
      "assistant-1",
    ]);
  });

  test("drops a crash orphan even when a later turn references the same prompt", () => {
    // The later inline invocation failed to materialize (no new snapshot) but
    // its user row still carries the ref; identity must not claim the orphan.
    const messages = [
      snapshot("orphan-snap", "user-crashed"),
      invokingUser("user-later", ["review"]),
    ];
    expect(filterOrphanedMcpPromptSnapshots(messages).map((m) => m.id)).toEqual(["user-later"]);
  });

  test("drops legacy snapshots without an invoking id", () => {
    const messages = [snapshot("snap-legacy"), invokingUser("user-1", ["review"])];
    expect(filterOrphanedMcpPromptSnapshots(messages).map((m) => m.id)).toEqual(["user-1"]);
  });

  test("keeps multiple snapshots correlated to the same turn", () => {
    const messages = [
      snapshot("snap-1", "user-1", "review"),
      snapshot("snap-2", "user-1", "status"),
      invokingUser("user-1", ["review", "status"]),
    ];
    expect(filterOrphanedMcpPromptSnapshots(messages)).toEqual(messages);
  });
});
