import { describe, expect, mock, test } from "bun:test";

import { createMuxMessage, type MuxMessage, type MuxMessageMetadata } from "@/common/types/message";
import { Ok } from "@/common/types/result";
import type { AIService, StreamMessageOptions } from "@/node/services/aiService";

import { inheritOpenWorkspaceTurnMetadata } from "./agentSession";
import { createAgentSessionHarness } from "./agentSession.testHarness";

const correlation = {
  type: "workspace-turn-task",
  taskHandleId: "wst_handle",
  ownerWorkspaceId: "parentworkspace",
  turnId: "turn",
} as const;

function turnPrompt(id: string): MuxMessage {
  return createMuxMessage(id, "user", "Delegated prompt", { muxMetadata: correlation });
}

function cutAssistant(id: string): MuxMessage {
  return createMuxMessage(id, "assistant", "Working...", {
    finishReason: "tool-calls",
    muxMetadata: correlation,
  });
}

function wake(id: string): MuxMessage {
  return createMuxMessage(id, "user", "A background bash monitor matched output.", {
    muxMetadata: { type: "bash-monitor-wake", records: [] },
  });
}

describe("inheritOpenWorkspaceTurnMetadata", () => {
  test("wake after a queue-cut correlated assistant inherits the turn correlation", () => {
    const messages = [turnPrompt("prompt"), cutAssistant("cut"), wake("wake")];
    expect(inheritOpenWorkspaceTurnMetadata(messages)).toEqual(correlation);
  });

  test("chained wake continuations keep inheriting through inherited assistants", () => {
    const messages = [
      turnPrompt("prompt"),
      cutAssistant("cut1"),
      wake("wake1"),
      cutAssistant("cut2"),
      wake("wake2"),
    ];
    expect(inheritOpenWorkspaceTurnMetadata(messages)).toEqual(correlation);
  });

  test("a correlated assistant that finished with stop closes the turn", () => {
    const messages = [
      turnPrompt("prompt"),
      createMuxMessage("final", "assistant", "Final report", {
        finishReason: "stop",
        muxMetadata: correlation,
      }),
      wake("wake"),
    ];
    expect(inheritOpenWorkspaceTurnMetadata(messages)).toBeUndefined();
  });

  test("a manual user prompt supersedes the open turn", () => {
    const messages = [
      turnPrompt("prompt"),
      cutAssistant("cut"),
      createMuxMessage("manual", "user", "User takes over"),
      wake("wake"),
    ];
    expect(inheritOpenWorkspaceTurnMetadata(messages)).toBeUndefined();
  });

  test("an uncorrelated assistant closes the chain", () => {
    const messages = [
      createMuxMessage("plain", "assistant", "Unrelated turn", { finishReason: "tool-calls" }),
      wake("wake"),
    ];
    expect(inheritOpenWorkspaceTurnMetadata(messages)).toBeUndefined();
  });

  test("a partial correlated assistant does not leave the turn open", () => {
    const messages = [
      turnPrompt("prompt"),
      createMuxMessage("partial", "assistant", "Crashed mid-work", {
        finishReason: "tool-calls",
        partial: true,
        muxMetadata: correlation,
      }),
      wake("wake"),
    ];
    expect(inheritOpenWorkspaceTurnMetadata(messages)).toBeUndefined();
  });

  test("empty history yields no correlation", () => {
    expect(inheritOpenWorkspaceTurnMetadata([])).toBeUndefined();
  });
});

describe("AgentSession workspace-turn correlation inheritance", () => {
  async function sendAfterQueueCut(sendOptions: {
    muxMetadata?: MuxMessageMetadata;
  }): Promise<StreamMessageOptions["muxMetadata"]> {
    let streamedMuxMetadata: StreamMessageOptions["muxMetadata"];
    const streamMessage = mock((opts: StreamMessageOptions) => {
      streamedMuxMetadata = opts.muxMetadata;
      return Promise.resolve(Ok(undefined));
    });
    const { session, cleanup, historyService } = await createAgentSessionHarness({
      workspaceId: "workspace-turn-inheritance",
      aiServiceOverrides: {
        streamMessage: streamMessage as unknown as AIService["streamMessage"],
      },
    });
    try {
      // Seed a delegated turn that was cut at a tool boundary by a queued dispatch.
      await historyService.appendToHistory(
        "workspace-turn-inheritance",
        turnPrompt("delegated-prompt")
      );
      await historyService.appendToHistory("workspace-turn-inheritance", cutAssistant("cut"));

      const result = await session.sendMessage("continuation", {
        model: "anthropic:claude-sonnet-4-5",
        agentId: "exec",
        ...(sendOptions.muxMetadata != null ? { muxMetadata: sendOptions.muxMetadata } : {}),
      });
      expect(result.success).toBe(true);
      expect(streamMessage.mock.calls).toHaveLength(1);
      return streamedMuxMetadata;
    } finally {
      session.dispose();
      await cleanup();
    }
  }

  test("bash-monitor-wake continuation streams inherit the open turn correlation", async () => {
    const streamed = await sendAfterQueueCut({
      muxMetadata: { type: "bash-monitor-wake", records: [] },
    });
    expect(streamed).toEqual(correlation);
  });

  test("manual user messages after a queue cut do not inherit the correlation", async () => {
    const streamed = await sendAfterQueueCut({});
    expect(streamed).toBeUndefined();
  });
});
