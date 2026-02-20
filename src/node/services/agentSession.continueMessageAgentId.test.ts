import { describe, expect, test, mock, afterEach } from "bun:test";
import { buildContinueMessage } from "@/common/types/message";
import type { FilePart, SendMessageOptions } from "@/common/orpc/types";
import { AgentSession } from "./agentSession";
import type { Config } from "@/node/config";
import type { AIService } from "./aiService";
import type { BackgroundProcessManager } from "./backgroundProcessManager";
import type { InitStateManager } from "./initStateManager";
import type { MuxMessage } from "@/common/types/message";
import { createTestHistoryService } from "./testHistoryService";

// NOTE: This test validates that legacy `mode` field in follow-up content is correctly
// converted to `agentId` during dispatch. With the crash-safe follow-up architecture,
// the follow-up is stored on the compaction summary message and dispatched from there.

type SendOptions = SendMessageOptions & { fileParts?: FilePart[] };

interface SessionInternals {
  dispatchPendingFollowUp: () => Promise<void>;
  sendMessage: (
    message: string,
    options?: SendOptions,
    internal?: { synthetic?: boolean }
  ) => Promise<{ success: true } | { success: false; error: { type: string; message?: string } }>;
  scheduleStartupRecovery: () => void;
  startupRecoveryPromise: Promise<void> | null;
  startupRecoveryScheduled: boolean;
}

describe("AgentSession continue-message agentId fallback", () => {
  let historyCleanup: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await historyCleanup?.();
  });

  test("legacy continueMessage.mode does not fall back to compact agent", async () => {
    // Track the follow-up message that gets dispatched
    let dispatchedMessage: string | undefined;
    let dispatchedOptions: SendOptions | undefined;
    let dispatchedInternal: { synthetic?: boolean } | undefined;

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

    const { historyService, cleanup } = await createTestHistoryService();
    historyCleanup = cleanup;
    await historyService.appendToHistory("ws", mockSummaryMessage);

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

    const session = new AgentSession({
      workspaceId: "ws",
      config,
      historyService,
      aiService,
      initStateManager,
      backgroundProcessManager,
    });

    const internals = session as unknown as SessionInternals;

    // Intercept sendMessage to capture what dispatchPendingFollowUp sends
    internals.sendMessage = mock(
      (message: string, options?: SendOptions, internal?: { synthetic?: boolean }) => {
        dispatchedMessage = message;
        dispatchedOptions = options;
        dispatchedInternal = internal;
        return Promise.resolve({ success: true as const });
      }
    );

    // Call dispatchPendingFollowUp directly (normally called after compaction completes)
    await internals.dispatchPendingFollowUp();

    // Verify the follow-up was dispatched with correct agentId derived from legacy mode
    expect(dispatchedMessage).toBe("follow up");
    expect(dispatchedOptions?.agentId).toBe("plan");
    expect(dispatchedInternal?.synthetic).toBe(true);

    session.dispose();
  });

  test("dispatchPendingFollowUp throws when history read fails", async () => {
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

    const { historyService, cleanup } = await createTestHistoryService();
    historyCleanup = cleanup;

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

    const session = new AgentSession({
      workspaceId: "ws",
      config,
      historyService,
      aiService,
      initStateManager,
      backgroundProcessManager,
    });

    const internals = session as unknown as SessionInternals & {
      historyService: {
        getLastMessages: (
          workspaceId: string,
          count: number
        ) => Promise<{
          success: boolean;
          error?: string;
          data: MuxMessage[];
        }>;
      };
    };

    internals.historyService.getLastMessages = mock(() =>
      Promise.resolve({ success: false, error: "temporary history read failure", data: [] })
    );

    let dispatchError: unknown;
    try {
      await internals.dispatchPendingFollowUp();
    } catch (error) {
      dispatchError = error;
    }

    expect(dispatchError).toBeInstanceOf(Error);
    if (!(dispatchError instanceof Error)) {
      throw new Error("Expected dispatchPendingFollowUp to throw on history read failures");
    }
    expect(dispatchError.message).toContain(
      "Failed to read history for startup follow-up recovery"
    );

    session.dispose();
  });

  test("startup recovery dispatches pending follow-up only once", async () => {
    let sendCount = 0;

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

    const mockSummaryMessage = {
      id: "summary-once",
      role: "assistant" as const,
      parts: [{ type: "text" as const, text: "Compaction summary" }],
      metadata: {
        muxMetadata: {
          type: "compaction-summary" as const,
          pendingFollowUp: {
            text: "follow up once",
            model: "openai:gpt-4o",
            agentId: "exec",
          },
        },
      },
    } satisfies MuxMessage;

    const { historyService, cleanup } = await createTestHistoryService();
    historyCleanup = cleanup;
    await historyService.appendToHistory("ws", mockSummaryMessage);

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

    const session = new AgentSession({
      workspaceId: "ws",
      config,
      historyService,
      aiService,
      initStateManager,
      backgroundProcessManager,
    });

    const internals = session as unknown as SessionInternals;
    internals.sendMessage = mock(() => {
      sendCount += 1;
      return Promise.resolve({ success: true as const });
    });

    internals.scheduleStartupRecovery();
    internals.scheduleStartupRecovery();

    await internals.startupRecoveryPromise;

    expect(sendCount).toBe(1);

    session.dispose();
  });

  test("startup recovery retries pending follow-up after an initial send failure", async () => {
    let sendCount = 0;

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

    const mockSummaryMessage = {
      id: "summary-retry",
      role: "assistant" as const,
      parts: [{ type: "text" as const, text: "Compaction summary" }],
      metadata: {
        muxMetadata: {
          type: "compaction-summary" as const,
          pendingFollowUp: {
            text: "follow up retry",
            model: "openai:gpt-4o",
            agentId: "exec",
          },
        },
      },
    } satisfies MuxMessage;

    const { historyService, cleanup } = await createTestHistoryService();
    historyCleanup = cleanup;
    await historyService.appendToHistory("ws", mockSummaryMessage);

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

    const session = new AgentSession({
      workspaceId: "ws",
      config,
      historyService,
      aiService,
      initStateManager,
      backgroundProcessManager,
    });

    const internals = session as unknown as SessionInternals;
    internals.sendMessage = mock(() => {
      sendCount += 1;
      if (sendCount === 1) {
        return Promise.resolve({
          success: false,
          error: { type: "runtime_start_failed", message: "startup failed" },
        });
      }
      return Promise.resolve({ success: true as const });
    });

    internals.scheduleStartupRecovery();
    await internals.startupRecoveryPromise;

    expect(sendCount).toBe(1);
    expect(internals.startupRecoveryScheduled).toBe(false);

    internals.scheduleStartupRecovery();
    await internals.startupRecoveryPromise;

    expect(sendCount).toBe(2);
    expect(internals.startupRecoveryScheduled).toBe(true);

    session.dispose();
  });
});
