import { describe, expect, test } from "bun:test";
import { createMuxMessage, filterOrphanedMcpPromptSnapshots } from "./message";
import type { MuxMessage } from "./message";

function snapshot(id: string, promptName = "review"): MuxMessage {
  return createMuxMessage(id, "user", `Expanded ${promptName}`, {
    historySequence: 0,
    synthetic: true,
    mcpPromptSnapshot: {
      serverName: "coder",
      promptName,
      commandKey: `mcp__coder__${promptName}`,
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
  test("keeps snapshots claimed by the next user message", () => {
    const messages = [snapshot("snap-1"), invokingUser("user-1", ["review"])];
    expect(filterOrphanedMcpPromptSnapshots(messages)).toEqual(messages);
  });

  test("drops a snapshot left at the tail by a crash", () => {
    const assistant = createMuxMessage("assistant-1", "assistant", "done", {
      historySequence: 0,
    });
    const messages = [invokingUser("user-1", []), assistant, snapshot("snap-1")];
    expect(filterOrphanedMcpPromptSnapshots(messages).map((m) => m.id)).toEqual([
      "user-1",
      "assistant-1",
    ]);
  });

  test("drops a snapshot whose following user message does not reference it", () => {
    const messages = [snapshot("snap-1", "review"), invokingUser("user-1", ["status"])];
    expect(filterOrphanedMcpPromptSnapshots(messages).map((m) => m.id)).toEqual(["user-1"]);
  });

  test("keeps only the newest snapshot per prompt when a crashed attempt is retried", () => {
    const messages = [
      snapshot("snap-stale", "review"),
      snapshot("snap-fresh", "review"),
      invokingUser("user-1", ["review"]),
    ];
    expect(filterOrphanedMcpPromptSnapshots(messages).map((m) => m.id)).toEqual([
      "snap-fresh",
      "user-1",
    ]);
  });

  test("skill snapshots inside the block do not break the claim", () => {
    const skillSnapshot = createMuxMessage("skill-snap", "user", "skill body", {
      historySequence: 0,
      synthetic: true,
      agentSkillSnapshot: { skillName: "tdd", scope: "global", sha256: "abc" },
    });
    const messages = [snapshot("snap-1"), skillSnapshot, invokingUser("user-1", ["review"])];
    expect(filterOrphanedMcpPromptSnapshots(messages)).toEqual(messages);
  });
});
