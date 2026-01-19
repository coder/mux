import { describe, expect, test, mock } from "bun:test";
import { buildContinueMessage, type ContinueMessage } from "@/common/types/message";
import type { ImagePart, SendMessageOptions } from "@/common/orpc/types";
import { AgentSession } from "./agentSession";
import type { Config } from "@/node/config";
import type { AIService } from "./aiService";
import type { BackgroundProcessManager } from "./backgroundProcessManager";
import type { HistoryService } from "./historyService";
import type { InitStateManager } from "./initStateManager";
import type { PartialService } from "./partialService";

// NOTE: This test is intentionally narrow: it only validates the agentId chosen for queued
// continue messages when compaction is requested.

type SendOptions = SendMessageOptions & { imageParts?: ImagePart[] };

interface SessionInternals {
  streamWithHistory: (
    modelString: string,
    options?: SendMessageOptions
  ) => Promise<{ success: true; data: undefined }>;
  messageQueue: {
    produceMessage: () => { message: string; options?: SendOptions };
  };
}

describe("AgentSession continue-message agentId fallback", () => {
  test("legacy continueMessage.mode does not fall back to compact agent", async () => {
    const aiService: AIService = {
      on() {
        return this;
      },
      off() {
        return this;
      },
      isStreaming: () => false,
      stopStream: mock(() => Promise.resolve({ success: true as const, data: undefined })),
    } as unknown as AIService;

    const historyService: HistoryService = {
      appendToHistory: mock(() => Promise.resolve({ success: true as const, data: undefined })),
    } as unknown as HistoryService;

    const initStateManager: InitStateManager = {
      on() {
        return this;
      },
      off() {
        return this;
      },
    } as unknown as InitStateManager;

    const backgroundProcessManager: BackgroundProcessManager = {
      cleanup: mock(() => Promise.resolve()),
      setMessageQueued: mock(() => undefined),
    } as unknown as BackgroundProcessManager;

    const config: Config = { srcDir: "/tmp" } as unknown as Config;
    const partialService: PartialService = {} as unknown as PartialService;

    const session = new AgentSession({
      workspaceId: "ws",
      config,
      historyService,
      partialService,
      aiService,
      initStateManager,
      backgroundProcessManager,
    });

    const internals = session as unknown as SessionInternals;

    // Avoid exercising the full stream pipeline; we only care about the queue contents.
    internals.streamWithHistory = () =>
      Promise.resolve({ success: true as const, data: undefined });

    const baseContinueMessage = buildContinueMessage({
      text: "follow up",
      model: "openai:gpt-4o",
      agentId: "exec",
    });
    if (!baseContinueMessage) {
      throw new Error("Expected base continue message to be built");
    }

    const legacyContinueMessage = {
      ...baseContinueMessage,
      agentId: undefined,
      mode: "plan" as const,
    } as unknown as ContinueMessage;

    const result = await session.sendMessage("/compact", {
      model: "openai:gpt-4o",
      agentId: "compact",
      mode: "compact",
      disableWorkspaceAgents: true,
      toolPolicy: [{ regex_match: ".*", action: "disable" }],
      muxMetadata: {
        type: "compaction-request",
        rawCommand: "/compact",
        parsed: {
          continueMessage: legacyContinueMessage,
        },
      },
    });

    expect(result.success).toBe(true);

    const queued = internals.messageQueue.produceMessage();
    expect(queued.message).toBe("follow up");
    expect(queued.options?.agentId).toBe("plan");
    expect(queued.options?.disableWorkspaceAgents).toBe(true);

    session.dispose();
  });
});
