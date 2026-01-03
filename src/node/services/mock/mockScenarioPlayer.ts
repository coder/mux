import assert from "@/common/utils/assert";
import type { MuxMessage } from "@/common/types/message";
import { createMuxMessage } from "@/common/types/message";
import type { HistoryService } from "@/node/services/historyService";
import type { Result } from "@/common/types/result";
import { Ok, Err } from "@/common/types/result";
import type { SendMessageError } from "@/common/types/errors";
import type { AIService } from "@/node/services/aiService";
import { log } from "@/node/services/log";
import type {
  MockAssistantEvent,
  MockStreamErrorEvent,
  MockStreamStartEvent,
  ScenarioTurn,
} from "./scenarioTypes";
import { allScenarios } from "./scenarios";
import { MockAiRouter, readMockAiModeFromEnv, type MockAiMode } from "./mockAiRouter";
import { buildMockStreamEventsFromReply } from "./mockAiStreamAdapter";
import type {
  StreamStartEvent,
  StreamDeltaEvent,
  StreamEndEvent,
  UsageDeltaEvent,
} from "@/common/types/stream";
import type { ToolCallStartEvent, ToolCallEndEvent } from "@/common/types/stream";
import type { ReasoningDeltaEvent } from "@/common/types/stream";
import { getTokenizerForModel } from "@/node/utils/main/tokenizer";
import { KNOWN_MODELS } from "@/common/constants/knownModels";

const MOCK_TOKENIZER_MODEL = KNOWN_MODELS.GPT.id;
const TOKENIZE_TIMEOUT_MS = 150;
let tokenizerFallbackLogged = false;
let tokenizerUnavailableLogged = false;

function approximateTokenCount(text: string): number {
  const normalizedLength = text.trim().length;
  if (normalizedLength === 0) {
    return 0;
  }
  return Math.max(1, Math.ceil(normalizedLength / 4));
}

async function tokenizeWithMockModel(text: string, context: string): Promise<number> {
  assert(typeof text === "string", `Mock scenario ${context} expects string input`);

  // Prefer fast approximate token counting in mock mode.
  // We only use the real tokenizer if it's available and responds quickly.
  const approximateTokens = approximateTokenCount(text);

  let fallbackUsed = false;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let tokenizerErrorMessage: string | undefined;

  const fallbackPromise = new Promise<number>((resolve) => {
    timeoutId = setTimeout(() => {
      fallbackUsed = true;
      resolve(approximateTokens);
    }, TOKENIZE_TIMEOUT_MS);
  });

  const actualPromise = (async () => {
    try {
      const tokenizer = await getTokenizerForModel(MOCK_TOKENIZER_MODEL);
      assert(
        typeof tokenizer.encoding === "string" && tokenizer.encoding.length > 0,
        `Tokenizer for ${MOCK_TOKENIZER_MODEL} must expose a non-empty encoding`
      );
      const tokens = await tokenizer.countTokens(text);
      assert(
        Number.isFinite(tokens) && tokens >= 0,
        `Tokenizer for ${MOCK_TOKENIZER_MODEL} returned invalid token count`
      );
      return tokens;
    } catch (error) {
      tokenizerErrorMessage = error instanceof Error ? error.message : String(error);
      return approximateTokens;
    }
  })();

  const tokens = await Promise.race([actualPromise, fallbackPromise]);

  if (timeoutId !== undefined) {
    clearTimeout(timeoutId);
  }

  if (fallbackUsed && !tokenizerFallbackLogged) {
    tokenizerFallbackLogged = true;
    void actualPromise.then((resolvedTokens) => {
      log.debug(
        `[MockScenarioPlayer] Tokenizer fallback used for ${context}; emitted ${approximateTokens}, background tokenizer returned ${resolvedTokens}`
      );
    });
  }

  if (tokenizerErrorMessage && !tokenizerUnavailableLogged) {
    tokenizerUnavailableLogged = true;
    log.debug(
      `[MockScenarioPlayer] Tokenizer unavailable for ${context}; using approximate (${tokenizerErrorMessage})`
    );
  }

  assert(
    Number.isFinite(tokens) && tokens >= 0,
    `Token counting produced invalid count for ${context}`
  );

  return tokens;
}

interface MockPlayerDeps {
  aiService: AIService;
  historyService: HistoryService;
}

interface ActiveStream {
  timers: Array<ReturnType<typeof setTimeout>>;
  messageId: string;
  eventQueue: Array<() => Promise<void>>;
  isProcessing: boolean;
}

export class MockScenarioPlayer {
  private readonly scenarios: ScenarioTurn[] = allScenarios;
  private readonly router = new MockAiRouter();
  private readonly mode: MockAiMode;
  private readonly activeStreams = new Map<string, ActiveStream>();
  private readonly completedTurns = new Set<number>();
  private nextMockMessageId = 0;

  constructor(
    private readonly deps: MockPlayerDeps,
    options?: {
      mode?: MockAiMode;
    }
  ) {
    this.mode = options?.mode ?? readMockAiModeFromEnv();
  }

  isStreaming(workspaceId: string): boolean {
    return this.activeStreams.has(workspaceId);
  }

  stop(workspaceId: string): void {
    const active = this.activeStreams.get(workspaceId);
    if (!active) return;

    // Clear all pending timers
    for (const timer of active.timers) {
      clearTimeout(timer);
    }

    // Emit stream-abort event to mirror real streaming behavior
    this.deps.aiService.emit("stream-abort", {
      type: "stream-abort",
      workspaceId,
      messageId: active.messageId,
      reason: "user_cancelled",
    });

    this.activeStreams.delete(workspaceId);
  }

  async play(messages: MuxMessage[], workspaceId: string): Promise<Result<void, SendMessageError>> {
    const latest = messages[messages.length - 1];
    if (!latest || latest.role !== "user") {
      return Err({ type: "unknown", raw: "Mock AI expected a user message" });
    }

    const latestText = this.extractText(latest);

    let events: MockAssistantEvent[];
    let messageId: string;
    let scenarioTurnIndex: number | undefined;

    if (this.mode === "scenario") {
      const turnIndex = this.findTurnIndex(latestText);
      if (turnIndex !== -1) {
        const turn = this.scenarios[turnIndex];
        if (
          typeof turn.user.editOfTurn === "number" &&
          !this.completedTurns.has(turn.user.editOfTurn)
        ) {
          return Err({
            type: "unknown",
            raw: `Mock scenario turn "${turn.user.text}" requires completion of turn index ${turn.user.editOfTurn}`,
          });
        }

        messageId = turn.assistant.messageId;
        events = turn.assistant.events;
        scenarioTurnIndex = turnIndex;
      } else {
        const reply = this.router.route({
          messages,
          latestUserMessage: latest,
          latestUserText: latestText,
        });

        messageId = `msg-mock-${this.nextMockMessageId++}`;
        events = buildMockStreamEventsFromReply(reply, { messageId });
      }
    } else {
      const reply = this.router.route({
        messages,
        latestUserMessage: latest,
        latestUserText: latestText,
      });

      messageId = `msg-mock-${this.nextMockMessageId++}`;
      events = buildMockStreamEventsFromReply(reply, { messageId });
    }

    const streamStart = events.find(
      (event): event is MockStreamStartEvent => event.kind === "stream-start"
    );
    if (!streamStart) {
      return Err({ type: "unknown", raw: "Mock AI turn missing stream-start" });
    }

    let historySequence = this.computeNextHistorySequence(messages);

    const assistantMessage = createMuxMessage(messageId, "assistant", "", {
      timestamp: Date.now(),
      model: streamStart.model,
    });

    const appendResult = await this.deps.historyService.appendToHistory(
      workspaceId,
      assistantMessage
    );
    if (!appendResult.success) {
      return Err({ type: "unknown", raw: appendResult.error });
    }
    historySequence = assistantMessage.metadata?.historySequence ?? historySequence;

    // Cancel any existing stream before starting a new one
    if (this.isStreaming(workspaceId)) {
      this.stop(workspaceId);
    }

    this.scheduleEvents(workspaceId, events, messageId, historySequence);

    if (scenarioTurnIndex !== undefined) {
      this.completedTurns.add(scenarioTurnIndex);
    }

    return Ok(undefined);
  }

  async replayStream(_workspaceId: string): Promise<void> {
    // No-op for mock scenario; events are deterministic and do not support mid-stream replay
  }

  private scheduleEvents(
    workspaceId: string,
    events: MockAssistantEvent[],
    messageId: string,
    historySequence: number
  ): void {
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    this.activeStreams.set(workspaceId, {
      timers,
      messageId,
      eventQueue: [],
      isProcessing: false,
    });

    for (const event of events) {
      const timer = setTimeout(() => {
        this.enqueueEvent(workspaceId, () =>
          this.dispatchEvent(workspaceId, event, messageId, historySequence)
        );
      }, event.delay);
      timers.push(timer);
    }
  }

  private enqueueEvent(workspaceId: string, handler: () => Promise<void>): void {
    const active = this.activeStreams.get(workspaceId);
    if (!active) return;

    active.eventQueue.push(handler);
    void this.processQueue(workspaceId);
  }

  private async processQueue(workspaceId: string): Promise<void> {
    const active = this.activeStreams.get(workspaceId);
    if (!active || active.isProcessing) return;

    active.isProcessing = true;

    while (active.eventQueue.length > 0) {
      const handler = active.eventQueue.shift();
      if (!handler) break;

      try {
        await handler();
      } catch (error) {
        log.error(`Event handler error for ${workspaceId}:`, error);
      }
    }

    active.isProcessing = false;
  }

  private async dispatchEvent(
    workspaceId: string,
    event: MockAssistantEvent,
    messageId: string,
    historySequence: number
  ): Promise<void> {
    switch (event.kind) {
      case "stream-start": {
        const payload: StreamStartEvent = {
          type: "stream-start",
          workspaceId,
          messageId,
          model: event.model,
          historySequence,
          startTime: Date.now(),
          ...(event.mode && { mode: event.mode }),
        };
        this.deps.aiService.emit("stream-start", payload);
        break;
      }
      case "reasoning-delta": {
        // Mock scenarios use the same tokenization logic as real streams for consistency
        const tokens = await tokenizeWithMockModel(event.text, "reasoning-delta text");
        const payload: ReasoningDeltaEvent = {
          type: "reasoning-delta",
          workspaceId,
          messageId,
          delta: event.text,
          tokens,
          timestamp: Date.now(),
        };
        this.deps.aiService.emit("reasoning-delta", payload);
        break;
      }
      case "tool-start": {
        // Mock scenarios use the same tokenization logic as real streams for consistency
        const inputText = JSON.stringify(event.args);
        const tokens = await tokenizeWithMockModel(inputText, "tool-call args");
        const payload: ToolCallStartEvent = {
          type: "tool-call-start",
          workspaceId,
          messageId,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.args,
          tokens,
          timestamp: Date.now(),
        };
        this.deps.aiService.emit("tool-call-start", payload);
        break;
      }
      case "usage-delta": {
        const payload: UsageDeltaEvent = {
          type: "usage-delta",
          workspaceId,
          messageId,
          usage: event.usage,
          providerMetadata: event.providerMetadata,
          cumulativeUsage: event.cumulativeUsage,
          cumulativeProviderMetadata: event.cumulativeProviderMetadata,
        };
        this.deps.aiService.emit("usage-delta", payload);
        break;
      }
      case "tool-end": {
        const payload: ToolCallEndEvent = {
          type: "tool-call-end",
          workspaceId,
          messageId,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          result: event.result,
          timestamp: Date.now(),
        };
        this.deps.aiService.emit("tool-call-end", payload);
        break;
      }
      case "stream-delta": {
        // Mock scenarios use the same tokenization logic as real streams for consistency
        let tokens: number;
        try {
          tokens = await tokenizeWithMockModel(event.text, "stream-delta text");
        } catch (error) {
          log.error("tokenize failed for stream-delta", error);
          throw error;
        }
        const payload: StreamDeltaEvent = {
          type: "stream-delta",
          workspaceId,
          messageId,
          delta: event.text,
          tokens,
          timestamp: Date.now(),
        };
        this.deps.aiService.emit("stream-delta", payload);
        break;
      }
      case "stream-error": {
        const payload: MockStreamErrorEvent = event;
        this.deps.aiService.emit("error", {
          type: "error",
          workspaceId,
          messageId,
          error: payload.error,
          errorType: payload.errorType,
        });
        this.cleanup(workspaceId);
        break;
      }
      case "stream-end": {
        const payload: StreamEndEvent = {
          type: "stream-end",
          workspaceId,
          messageId,
          metadata: {
            model: event.metadata.model,
            systemMessageTokens: event.metadata.systemMessageTokens,
          },
          parts: event.parts,
        };

        // Update history with completed message (mirrors real StreamManager behavior)
        // Fetch the current message from history to get its historySequence
        const historyResult = await this.deps.historyService.getHistory(workspaceId);
        if (historyResult.success) {
          const existingMessage = historyResult.data.find((msg) => msg.id === messageId);
          if (existingMessage?.metadata?.historySequence !== undefined) {
            const completedMessage: MuxMessage = {
              id: messageId,
              role: "assistant",
              parts: event.parts,
              metadata: {
                ...existingMessage.metadata,
                model: event.metadata.model,
                systemMessageTokens: event.metadata.systemMessageTokens,
              },
            };
            const updateResult = await this.deps.historyService.updateHistory(
              workspaceId,
              completedMessage
            );

            if (!updateResult.success) {
              log.error(`Failed to update history for ${messageId}: ${updateResult.error}`);
            }
          }
        }

        this.deps.aiService.emit("stream-end", payload);
        this.cleanup(workspaceId);
        break;
      }
    }
  }

  private cleanup(workspaceId: string): void {
    const active = this.activeStreams.get(workspaceId);
    if (!active) return;

    // Clear all pending timers
    for (const timer of active.timers) {
      clearTimeout(timer);
    }

    // Clear event queue to prevent any pending events from processing
    active.eventQueue = [];

    this.activeStreams.delete(workspaceId);
  }

  private extractText(message: MuxMessage): string {
    return message.parts
      .filter((part) => "text" in part)
      .map((part) => (part as { text: string }).text)
      .join("");
  }

  private computeNextHistorySequence(messages: MuxMessage[]): number {
    let maxSequence = 0;
    for (const message of messages) {
      const seq = message.metadata?.historySequence;
      if (typeof seq === "number" && seq > maxSequence) {
        maxSequence = seq;
      }
    }
    return maxSequence + 1;
  }

  private findTurnIndex(text: string): number {
    const normalizedText = text.trim();
    for (let index = 0; index < this.scenarios.length; index += 1) {
      if (this.completedTurns.has(index)) {
        continue;
      }
      const candidate = this.scenarios[index];
      if (candidate.user.text.trim() === normalizedText) {
        return index;
      }
    }
    return -1;
  }
}
