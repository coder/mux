import { describe, expect, test, beforeEach, afterEach, spyOn } from "bun:test";
import { EventEmitter } from "events";
import { MockAiStreamPlayer } from "./mockAiStreamPlayer";
import { createMuxMessage, type MuxMessage } from "@/common/types/message";
import { Ok } from "@/common/types/result";
import type { HistoryService } from "@/node/services/historyService";
import type { AIService } from "@/node/services/aiService";
import { createTestHistoryService } from "../testHistoryService";

function readWorkspaceId(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  if (!("workspaceId" in payload)) return undefined;

  const workspaceId = (payload as { workspaceId?: unknown }).workspaceId;
  return typeof workspaceId === "string" ? workspaceId : undefined;
}

describe("MockAiStreamPlayer", () => {
  let historyService: HistoryService;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const testHistory = await createTestHistoryService();
    historyService = testHistory.historyService;
    cleanup = testHistory.cleanup;
  });

  afterEach(async () => {
    await cleanup();
  });

  test("appends assistant placeholder even when router turn ends with stream error", async () => {
    const aiServiceStub = new EventEmitter();

    const player = new MockAiStreamPlayer({
      historyService,
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

    // Read back what was appended during the first turn
    const historyResult = await historyService.getLastMessages(workspaceId, 100);
    const historyBeforeSecondTurn = historyResult.success ? historyResult.data : [];

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

    // Read back all messages and check the assistant placeholders
    const allResult = await historyService.getLastMessages(workspaceId, 100);
    const allMessages = allResult.success ? allResult.data : [];
    const assistantMessages = allMessages.filter((m) => m.role === "assistant");

    expect(assistantMessages).toHaveLength(2);
    const [firstAppend, secondAppend] = assistantMessages;

    expect(firstAppend.id).not.toBe(secondAppend.id);

    const firstSeq = firstAppend.metadata?.historySequence ?? -1;
    const secondSeq = secondAppend.metadata?.historySequence ?? -1;
    expect(secondSeq).toBe(firstSeq + 1);

    player.stop(workspaceId);
  });

  test("removes assistant placeholder when aborted before stream scheduling", async () => {
    type AppendResult = Awaited<ReturnType<HistoryService["appendToHistory"]>>;

    // Control when appendToHistory resolves to test the abort race condition.
    // The real service writes to disk immediately; we gate the returned promise
    // so the player sees a pending append while we trigger abort.
    let appendResolve!: (result: AppendResult) => void;
    const appendGate = new Promise<AppendResult>((resolve) => {
      appendResolve = resolve;
    });

    let appendedMessageResolve!: (msg: MuxMessage) => void;
    const appendedMessage = new Promise<MuxMessage>((resolve) => {
      appendedMessageResolve = resolve;
    });

    const originalAppend = historyService.appendToHistory.bind(historyService);
    spyOn(historyService, "appendToHistory").mockImplementation(
      async (wId: string, message: MuxMessage) => {
        // Write to disk so deleteMessage can find it later
        await originalAppend(wId, message);
        appendedMessageResolve(message);
        // Delay returning to the caller until the gate opens
        return appendGate;
      }
    );

    const aiServiceStub = new EventEmitter();

    const player = new MockAiStreamPlayer({
      historyService,
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

    const assistantMsg = await appendedMessage;

    appendResolve(Ok(undefined));
    abortController.abort();

    const result = await playPromise;
    expect(result.success).toBe(true);

    // Verify the placeholder was deleted from history
    const storedResult = await historyService.getLastMessages(workspaceId, 100);
    const storedMessages = storedResult.success ? storedResult.data : [];
    expect(storedMessages.some((msg) => msg.id === assistantMsg.id)).toBe(false);
  });

  test("stop prevents queued stream events from emitting", async () => {
    const aiServiceStub = new EventEmitter();

    const player = new MockAiStreamPlayer({
      historyService,
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
