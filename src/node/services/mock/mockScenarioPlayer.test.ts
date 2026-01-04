import { describe, expect, test } from "bun:test";
import { EventEmitter } from "events";
import { MockScenarioPlayer } from "./mockScenarioPlayer";
import { createMuxMessage, type MuxMessage } from "@/common/types/message";
import { Ok } from "@/common/types/result";
import type { HistoryService } from "@/node/services/historyService";
import type { AIService } from "@/node/services/aiService";

class InMemoryHistoryService {
  public appended: Array<{ workspaceId: string; message: MuxMessage }> = [];
  private nextSequence = 0;

  appendToHistory(workspaceId: string, message: MuxMessage) {
    message.metadata ??= {};

    if (message.metadata.historySequence === undefined) {
      message.metadata.historySequence = this.nextSequence++;
    } else if (message.metadata.historySequence >= this.nextSequence) {
      this.nextSequence = message.metadata.historySequence + 1;
    }

    this.appended.push({ workspaceId, message });
    return Promise.resolve(Ok(undefined));
  }
}

describe("MockScenarioPlayer", () => {
  test("appends assistant placeholder even when router turn ends with stream error", async () => {
    const historyStub = new InMemoryHistoryService();
    const aiServiceStub = new EventEmitter();

    const player = new MockScenarioPlayer({
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
});
