import { describe, expect, test } from "bun:test";
import { EventEmitter } from "events";
import { MockAiStreamPlayer } from "./mockAiStreamPlayer";
import { createMuxMessage, type MuxMessage } from "@/common/types/message";
import { Ok } from "@/common/types/result";
import type { HistoryService } from "@/node/services/historyService";
import type { AIService } from "@/node/services/aiService";

class InMemoryHistoryService {
  public appended: Array<{ workspaceId: string; message: MuxMessage }> = [];
  public messages = new Map<string, MuxMessage[]>();
  private nextSequence = 0;

  appendToHistory(workspaceId: string, message: MuxMessage) {
    message.metadata ??= {};

    if (message.metadata.historySequence === undefined) {
      message.metadata.historySequence = this.nextSequence++;
    } else if (message.metadata.historySequence >= this.nextSequence) {
      this.nextSequence = message.metadata.historySequence + 1;
    }

    this.appended.push({ workspaceId, message });

    const existing = this.messages.get(workspaceId) ?? [];
    this.messages.set(workspaceId, [...existing, message]);

    return Promise.resolve(Ok(undefined));
  }

  deleteMessage(workspaceId: string, messageId: string) {
    const existing = this.messages.get(workspaceId) ?? [];
    this.messages.set(
      workspaceId,
      existing.filter((message) => message.id !== messageId)
    );
    return Promise.resolve(Ok(undefined));
  }
}

function readWorkspaceId(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  if (!("workspaceId" in payload)) return undefined;

  const workspaceId = (payload as { workspaceId?: unknown }).workspaceId;
  return typeof workspaceId === "string" ? workspaceId : undefined;
}

describe("MockAiStreamPlayer", () => {
  test("appends assistant placeholder even when router turn ends with stream error", async () => {
    const historyStub = new InMemoryHistoryService();
    const aiServiceStub = new EventEmitter();

    const player = new MockAiStreamPlayer({
      historyService: historyStub as unknown as HistoryService,
      aiService: aiServiceStub as unknown as AIService,
    });

    const workspaceId = "workspace-1";

    const firstTurnUser = createMuxMessage(
      "user-1",
      "user",
      "[mock:list-languages] List 3 programming languages",
      {
        timestamp: Date.now(),
      }
    );

    const firstResult = await player.play([firstTurnUser], workspaceId);
    expect(firstResult.success).toBe(true);
    player.stop(workspaceId);

    const historyBeforeSecondTurn = historyStub.appended.map((entry) => entry.message);

    const secondTurnUser = createMuxMessage(
      "user-2",
      "user",
      "[mock:error:api] Trigger API error",
      {
        timestamp: Date.now(),
      }
    );

    const secondResult = await player.play(
      [firstTurnUser, ...historyBeforeSecondTurn, secondTurnUser],
      workspaceId
    );
    expect(secondResult.success).toBe(true);

    expect(historyStub.appended).toHaveLength(2);
    const [firstAppend, secondAppend] = historyStub.appended;

    expect(firstAppend.message.id).not.toBe(secondAppend.message.id);

    const firstSeq = firstAppend.message.metadata?.historySequence ?? -1;
    const secondSeq = secondAppend.message.metadata?.historySequence ?? -1;
    expect(secondSeq).toBe(firstSeq + 1);

    player.stop(workspaceId);
  });

  test("removes assistant placeholder when aborted before stream scheduling", async () => {
    type AppendGateResult = Awaited<ReturnType<InMemoryHistoryService["appendToHistory"]>>;
    type AppendGatePromise = ReturnType<InMemoryHistoryService["appendToHistory"]>;

    class DeferredHistoryService extends InMemoryHistoryService {
      private appendGateResolve?: (result: AppendGateResult) => void;
      public appendGate: AppendGatePromise = new Promise<AppendGateResult>((resolve) => {
        this.appendGateResolve = resolve;
      });

      private appendedMessageResolve?: (message: MuxMessage) => void;
      public appendedMessage = new Promise<MuxMessage>((resolve) => {
        this.appendedMessageResolve = resolve;
      });

      override appendToHistory(workspaceId: string, message: MuxMessage) {
        void super.appendToHistory(workspaceId, message);
        this.appendedMessageResolve?.(message);
        return this.appendGate;
      }

      resolveAppend() {
        this.appendGateResolve?.(Ok(undefined));
      }
    }

    const historyStub = new DeferredHistoryService();
    const aiServiceStub = new EventEmitter();

    const player = new MockAiStreamPlayer({
      historyService: historyStub as unknown as HistoryService,
      aiService: aiServiceStub as unknown as AIService,
    });

    const workspaceId = "workspace-abort-startup";

    const userMessage = createMuxMessage(
      "user-1",
      "user",
      "[mock:list-languages] List 3 programming languages",
      {
        timestamp: Date.now(),
      }
    );

    const abortController = new AbortController();
    const playPromise = player.play([userMessage], workspaceId, {
      abortSignal: abortController.signal,
    });

    const assistantMessage = await historyStub.appendedMessage;

    historyStub.resolveAppend();
    abortController.abort();

    const result = await playPromise;
    expect(result.success).toBe(true);

    const storedMessages = historyStub.messages.get(workspaceId) ?? [];
    expect(storedMessages.some((msg) => msg.id === assistantMessage.id)).toBe(false);
  });

  test("stop prevents queued stream events from emitting", async () => {
    const historyStub = new InMemoryHistoryService();
    const aiServiceStub = new EventEmitter();

    const player = new MockAiStreamPlayer({
      historyService: historyStub as unknown as HistoryService,
      aiService: aiServiceStub as unknown as AIService,
    });

    const workspaceId = "workspace-2";

    let deltaCount = 0;
    let abortCount = 0;
    let stopped = false;

    aiServiceStub.on("stream-abort", (payload: unknown) => {
      if (readWorkspaceId(payload) === workspaceId) {
        abortCount += 1;
      }
    });

    const firstDelta = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Timed out waiting for stream-delta"));
      }, 1000);

      aiServiceStub.on("stream-delta", (payload: unknown) => {
        if (readWorkspaceId(payload) !== workspaceId) return;

        deltaCount += 1;

        if (!stopped) {
          stopped = true;
          clearTimeout(timeout);
          player.stop(workspaceId);
          resolve();
        }
      });
    });

    const forceTurnUser = createMuxMessage("user-force", "user", "[force] keep streaming", {
      timestamp: Date.now(),
    });

    const playResult = await player.play([forceTurnUser], workspaceId);
    expect(playResult.success).toBe(true);

    await firstDelta;

    const deltasAtStop = deltaCount;

    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(deltaCount).toBe(deltasAtStop);
    expect(abortCount).toBe(1);
  });
});
