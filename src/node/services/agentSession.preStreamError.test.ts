import { describe, expect, it, mock } from "bun:test";
import { EventEmitter } from "events";
import type { Config } from "@/node/config";
import type { AIService } from "@/node/services/aiService";
import type { BackgroundProcessManager } from "@/node/services/backgroundProcessManager";
import type { HistoryService } from "@/node/services/historyService";
import type { InitStateManager } from "@/node/services/initStateManager";
import type { PartialService } from "@/node/services/partialService";
import type { SendMessageError } from "@/common/types/errors";
import type { MuxMessage } from "@/common/types/message";
import type { Result } from "@/common/types/result";
import { Err, Ok } from "@/common/types/result";
import type { StreamErrorMessage, WorkspaceChatMessage } from "@/common/orpc/types";
import { AgentSession } from "./agentSession";

describe("AgentSession pre-stream errors", () => {
  it("emits stream-error when stream startup fails", async () => {
    const workspaceId = "ws-test";

    const config = {
      srcDir: "/tmp",
      getSessionDir: (_workspaceId: string) => "/tmp",
    } as unknown as Config;

    const messages: MuxMessage[] = [];
    let nextSeq = 0;

    const appendToHistory = mock((_workspaceId: string, message: MuxMessage) => {
      message.metadata = { ...(message.metadata ?? {}), historySequence: nextSeq++ };
      messages.push(message);
      return Promise.resolve(Ok(undefined));
    });

    const getHistory = mock((_workspaceId: string): Promise<Result<MuxMessage[], string>> => {
      return Promise.resolve(Ok([...messages]));
    });

    const historyService = {
      appendToHistory,
      getHistory,
    } as unknown as HistoryService;

    const partialService = {
      commitToHistory: mock((_workspaceId: string) => Promise.resolve(Ok(undefined))),
    } as unknown as PartialService;

    const aiEmitter = new EventEmitter();
    const streamMessage = mock((_history: MuxMessage[]) => {
      return Promise.resolve(
        Err({
          type: "api_key_not_found",
          provider: "anthropic",
        })
      );
    });
    const aiService = Object.assign(aiEmitter, {
      isStreaming: mock((_workspaceId: string) => false),
      stopStream: mock((_workspaceId: string) => Promise.resolve(Ok(undefined))),
      streamMessage: streamMessage as unknown as (
        ...args: Parameters<AIService["streamMessage"]>
      ) => Promise<Result<void, SendMessageError>>,
    }) as unknown as AIService;

    const initStateManager = new EventEmitter() as unknown as InitStateManager;

    const backgroundProcessManager = {
      cleanup: mock((_workspaceId: string) => Promise.resolve()),
      setMessageQueued: mock((_workspaceId: string, _queued: boolean) => {
        void _queued;
      }),
    } as unknown as BackgroundProcessManager;

    const session = new AgentSession({
      workspaceId,
      config,
      historyService,
      partialService,
      aiService,
      initStateManager,
      backgroundProcessManager,
    });

    const events: WorkspaceChatMessage[] = [];
    session.onChatEvent((event) => {
      events.push(event.message);
    });

    const result = await session.sendMessage("hello", {
      model: "anthropic:claude-3-5-sonnet-latest",
    });

    expect(result.success).toBe(false);
    expect(streamMessage.mock.calls).toHaveLength(1);

    const streamError = events.find(
      (event): event is StreamErrorMessage => event.type === "stream-error"
    );

    expect(streamError).toBeDefined();
    expect(streamError?.errorType).toBe("authentication");
    expect(streamError?.error).toContain("anthropic");
    expect(streamError?.messageId).toMatch(/^assistant-/);
  });
});
