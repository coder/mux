import { describe, expect, test, mock } from "bun:test";
import { buildContinueMessage } from "@/common/types/message";
import type { FilePart, SendMessageOptions } from "@/common/orpc/types";
import { AgentSession } from "./agentSession";
import type { Config } from "@/node/config";
import type { AIService } from "./aiService";
import type { BackgroundProcessManager } from "./backgroundProcessManager";
import type { HistoryService } from "./historyService";
import type { InitStateManager } from "./initStateManager";
import type { PartialService } from "./partialService";
import type { MuxMessage } from "@/common/types/message";

// NOTE: This test validates that legacy `mode` field in follow-up content is correctly
// converted to `agentId` during dispatch. With the crash-safe follow-up architecture,
// the follow-up is stored on the compaction summary message and dispatched from there.

type SendOptions = SendMessageOptions & { fileParts?: FilePart[] };

interface SessionInternals {
  dispatchPendingFollowUp: () => Promise<void>;
  sendMessage: (message: string, options?: SendOptions) => Promise<{ success: boolean }>;
}

describe("AgentSession continue-message agentId fallback", () => {
  test("legacy continueMessage.mode does not fall back to compact agent", async () => {
    // Track the follow-up message that gets dispatched
    let dispatchedMessage: string | undefined;
    let dispatchedOptions: SendOptions | undefined;

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

    // Create a mock compaction summary with legacy mode field
    const baseContinueMessage = buildContinueMessage({
      text: "follow up",
      model: "openai:gpt-4o",
      agentId: "exec",
    });
    if (!baseContinueMessage) {
      throw new Error("Expected base continue message to be built");
    }

    // Simulate legacy format: no agentId, but has mode instead
    const legacyFollowUp = {
      text: baseContinueMessage.text,
      model: "openai:gpt-4o",
      agentId: undefined as unknown as string, // Legacy: missing agentId
      mode: "plan" as const, // Legacy: mode field instead of agentId
    };

    // Mock history service to return a compaction summary with pending follow-up
    const mockSummaryMessage = {
      id: "summary-1",
      role: "assistant" as const,
      parts: [{ type: "text" as const, text: "Compaction summary" }],
      metadata: {
        muxMetadata: {
          type: "compaction-summary" as const,
          pendingFollowUp: legacyFollowUp,
        },
      },
    } satisfies MuxMessage;

    const historyService: HistoryService = {
      getHistoryFromLatestBoundary: mock(() =>
        Promise.resolve({ success: true as const, data: [mockSummaryMessage] })
      ),
      getLastMessages: mock(() =>
        Promise.resolve({ success: true as const, data: [mockSummaryMessage] })
      ),
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

    const config: Config = {
      srcDir: "/tmp",
      getSessionDir: mock(() => "/tmp"),
    } as unknown as Config;
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

    // Intercept sendMessage to capture what dispatchPendingFollowUp sends
    internals.sendMessage = mock((message: string, options?: SendOptions) => {
      dispatchedMessage = message;
      dispatchedOptions = options;
      return Promise.resolve({ success: true });
    });

    // Call dispatchPendingFollowUp directly (normally called after compaction completes)
    await internals.dispatchPendingFollowUp();

    // Verify the follow-up was dispatched with correct agentId derived from legacy mode
    expect(dispatchedMessage).toBe("follow up");
    expect(dispatchedOptions?.agentId).toBe("plan");

    session.dispose();
  });
});
