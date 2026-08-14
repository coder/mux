import { describe, expect, test } from "bun:test";
import {
  createMuxMessage,
  filterOrphanedMcpPromptSnapshots,
  sanitizeMcpPromptRefs,
} from "./message";
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
    const messages = [
      snapshot("orphan-snap", "user-crashed"),
      invokingUser("user-later", ["review"]),
    ];
    expect(filterOrphanedMcpPromptSnapshots(messages).map((m) => m.id)).toEqual(["user-later"]);
  });

  test("drops a snapshot whose invoking id points at a row without a matching ref", () => {
    const unrelated = createMuxMessage("user-unrelated", "user", "Plain message", {
      historySequence: 0,
    });
    const messages = [snapshot("snap-1", "user-unrelated"), unrelated];
    expect(filterOrphanedMcpPromptSnapshots(messages).map((m) => m.id)).toEqual(["user-unrelated"]);
  });

  test("drops a snapshot whose invoking id points at a different prompt's turn", () => {
    const messages = [snapshot("snap-1", "user-1", "review"), invokingUser("user-1", ["status"])];
    expect(filterOrphanedMcpPromptSnapshots(messages).map((m) => m.id)).toEqual(["user-1"]);
  });

  test("drops legacy snapshots without an invoking id", () => {
    const messages = [snapshot("snap-legacy"), invokingUser("user-1", ["review"])];
    expect(filterOrphanedMcpPromptSnapshots(messages).map((m) => m.id)).toEqual(["user-1"]);
  });

  test("drops raw rows whose snapshot field is present but malformed", () => {
    // Raw chat.jsonl rows bypass the oRPC sanitizer, so the request-side
    // filter must treat a present-but-invalid field as corruption.
    const corruptRow = (id: string, snapshotValue: unknown): MuxMessage => {
      const message = createMuxMessage(id, "user", "Expanded review", {
        historySequence: 0,
        synthetic: true,
      });
      (message.metadata as Record<string, unknown>).mcpPromptSnapshot = snapshotValue;
      return message;
    };
    const messages = [
      corruptRow("snap-null", null),
      corruptRow("snap-wrong-shape", { serverName: 42, promptName: "review" }),
      snapshot("snap-valid", "user-1"),
      invokingUser("user-1", ["review"]),
    ];
    expect(filterOrphanedMcpPromptSnapshots(messages).map((m) => m.id)).toEqual([
      "snap-valid",
      "user-1",
    ]);
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

describe("sanitizeMcpPromptRefs arguments", () => {
  const baseRef = {
    serverName: "coder",
    promptName: "review",
    commandKey: "mcp__coder__review",
    source: "slash" as const,
  };

  test("keeps a valid string-record arguments field", () => {
    const refs = sanitizeMcpPromptRefs([{ ...baseRef, arguments: { path: "src" } }]);
    expect(refs).toEqual([{ ...baseRef, arguments: { path: "src" } }]);
  });

  test("drops malformed arguments but keeps the reference identity", () => {
    const malformedArgumentsValues: unknown[] = ["path", { path: 1 }, [1], 42, null];

    for (const malformed of malformedArgumentsValues) {
      const refs = sanitizeMcpPromptRefs([{ ...baseRef, arguments: malformed }]);
      expect(refs).toEqual([baseRef]);
    }
  });
});
