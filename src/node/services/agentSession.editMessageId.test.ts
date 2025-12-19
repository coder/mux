import { describe, expect, it, mock } from "bun:test";
import { EventEmitter } from "events";
import type { AIService } from "@/node/services/aiService";
import type { HistoryService } from "@/node/services/historyService";
import type { PartialService } from "@/node/services/partialService";
import type { InitStateManager } from "@/node/services/initStateManager";
import type { BackgroundProcessManager } from "@/node/services/backgroundProcessManager";
import type { Config } from "@/node/config";
import type { MuxMessage } from "@/common/types/message";
import type { SendMessageError } from "@/common/types/errors";
import type { Result } from "@/common/types/result";
import { Ok, Err } from "@/common/types/result";
import { AgentSession } from "./agentSession";

describe("AgentSession.sendMessage (editMessageId)", () => {
  it("treats missing edit target as no-op (allows recovery after compaction)", async () => {
    const workspaceId = "ws-test";

    const config = {
      srcDir: "/tmp",
      getSessionDir: (_workspaceId: string) => "/tmp",
    } as unknown as Config;

    const messages: MuxMessage[] = [];
    let nextSeq = 0;

    const truncateAfterMessage = mock((_workspaceId: string, messageId: string) => {
      return Promise.resolve(Err(`Message with ID ${messageId} not found in history`));
    });

    const appendToHistory = mock((_workspaceId: string, message: MuxMessage) => {
      message.metadata = { ...(message.metadata ?? {}), historySequence: nextSeq++ };
      messages.push(message);
      return Promise.resolve(Ok(undefined));
    });

    const getHistory = mock((_workspaceId: string): Promise<Result<MuxMessage[], string>> => {
      return Promise.resolve(Ok([...messages]));
    });

    const historyService = {
      truncateAfterMessage,
      appendToHistory,
      getHistory,
    } as unknown as HistoryService;

    const partialService = {
      commitToHistory: mock((_workspaceId: string) => Promise.resolve(Ok(undefined))),
    } as unknown as PartialService;

    const aiEmitter = new EventEmitter();
    const streamMessage = mock((_messages: MuxMessage[]) => {
      return Promise.resolve(Ok(undefined));
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

    const result = await session.sendMessage("hello", {
      model: "anthropic:claude-3-5-sonnet-latest",
      editMessageId: "missing-user-message-id",
    });

    expect(result.success).toBe(true);
    expect(truncateAfterMessage.mock.calls).toHaveLength(1);
    expect(appendToHistory.mock.calls).toHaveLength(1);
    expect(streamMessage.mock.calls).toHaveLength(1);
  });
});
