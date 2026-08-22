import { describe, expect, it, mock, afterEach, spyOn } from "bun:test";
import { EventEmitter } from "events";
import type { AIService } from "@/node/services/aiService";
import type { InitStateManager } from "@/node/services/initStateManager";
import type { BackgroundProcessManager } from "@/node/services/backgroundProcessManager";
import type { Config } from "@/node/config";
import { createMuxMessage } from "@/common/types/message";
import { Err, Ok } from "@/common/types/result";
import { AgentSession } from "./agentSession";
import { createTestHistoryService } from "./testHistoryService";

const TEST_MODEL = "anthropic:claude-3-5-sonnet-latest";
const config = {
  srcDir: "/tmp",
  getSessionDir: (_workspaceId: string) => "/tmp",
} as unknown as Config;

// r30: family-message payload rows ride sendMessage as pre-turn rows so they
// persist inside turn admission (payload immediately before the trigger's user
// row) instead of a direct history append that can land inside another turn's
// PREPARING window.
describe("AgentSession.sendMessage (preTurnMessages)", () => {
  let historyCleanup: (() => Promise<void>) | undefined;

  async function createSessionHarness(workspaceId: string) {
    const { historyService, cleanup } = await createTestHistoryService();
    historyCleanup = cleanup;

    const streamMessage = mock(() => Promise.resolve(Ok(undefined)));
    const aiService = Object.assign(new EventEmitter(), {
      isStreaming: mock((_workspaceId: string) => false),
      stopStream: mock((_workspaceId: string) => Promise.resolve(Ok(undefined))),
      streamMessage: streamMessage as unknown as AIService["streamMessage"],
    }) as unknown as AIService;

    return {
      historyService,
      streamMessage,
      session: new AgentSession({
        workspaceId,
        config,
        historyService,
        aiService,
        initStateManager: new EventEmitter() as unknown as InitStateManager,
        backgroundProcessManager: {
          cleanup: mock((_workspaceId: string) => Promise.resolve()),
          setMessageQueued: mock((_workspaceId: string, _queued: boolean) => {
            void _queued;
          }),
        } as unknown as BackgroundProcessManager,
      }),
    };
  }

  afterEach(async () => {
    await historyCleanup?.();
  });

  it("persists pre-turn rows immediately before the turn's user row", async () => {
    const workspaceId = "ws-preturn-order";
    const { session, historyService } = await createSessionHarness(workspaceId);
    const payload = createMuxMessage("family-payload-1", "assistant", "untrusted payload", {
      timestamp: 1,
      synthetic: true,
    });

    const result = await session.sendMessage(
      "family trigger",
      { model: TEST_MODEL, agentId: "exec" },
      { synthetic: true, agentInitiated: true, preTurnMessages: [payload] }
    );
    expect(result.success).toBe(true);

    const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
    expect(history.success).toBe(true);
    if (!history.success) return;
    const roles = history.data.map((m) => `${m.role}:${m.id}`);
    // Payload directly precedes the trigger's user row — never separated by
    // another turn's rows.
    const payloadIndex = roles.indexOf("assistant:family-payload-1");
    expect(payloadIndex).toBeGreaterThanOrEqual(0);
    expect(history.data[payloadIndex + 1]?.role).toBe("user");
    const userText = history.data[payloadIndex + 1]?.parts.find((part) => part.type === "text");
    expect(userText?.type === "text" && userText.text).toContain("family trigger");
  });

  it("rolls pre-turn rows back when the user row fails to persist", async () => {
    const workspaceId = "ws-preturn-rollback";
    const { session, historyService } = await createSessionHarness(workspaceId);
    const payload = createMuxMessage("family-payload-2", "assistant", "untrusted payload", {
      timestamp: 1,
      synthetic: true,
    });

    const realAppend = historyService.appendToHistory.bind(historyService);
    spyOn(historyService, "appendToHistory").mockImplementation((wsId, message) => {
      if (message.role === "user") {
        return Promise.resolve(Err("simulated user-row append failure"));
      }
      return realAppend(wsId, message);
    });

    const result = await session.sendMessage(
      "family trigger",
      { model: TEST_MODEL, agentId: "exec" },
      { synthetic: true, agentInitiated: true, preTurnMessages: [payload] }
    );
    expect(result.success).toBe(false);

    // The orphaned payload (whose trigger never persisted) must not survive
    // into later provider requests.
    const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
    expect(history.success).toBe(true);
    if (!history.success) return;
    expect(history.data.some((m) => m.id === "family-payload-2")).toBe(false);
  });

  it("rejects non-assistant or non-synthetic pre-turn rows", async () => {
    const workspaceId = "ws-preturn-guard";
    const { session } = await createSessionHarness(workspaceId);
    const userRow = createMuxMessage("family-bad-row", "user", "smuggled instructions", {
      timestamp: 1,
      synthetic: true,
    });

    // Defensive assert: pre-turn rows are a family-payload channel; user-role
    // content here would bypass the untrusted-provenance rules.
    try {
      await session.sendMessage(
        "family trigger",
        { model: TEST_MODEL, agentId: "exec" },
        { synthetic: true, agentInitiated: true, preTurnMessages: [userRow] }
      );
      expect.unreachable("sendMessage must reject a user-role pre-turn row");
    } catch (error) {
      expect(String(error)).toContain("preTurnMessages must be synthetic assistant rows");
    }
  });
});
