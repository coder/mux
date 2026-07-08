import * as aiSdk from "ai";
import { type LanguageModel } from "ai";
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import {
  askSideQuestion,
  buildSideQuestionMessages,
  type SideQuestionAIService,
} from "./sideQuestionService";
import type { AIService } from "./aiService";
import { Err, Ok } from "@/common/types/result";
import { createMuxMessage, type MuxMessage } from "@/common/types/message";
import type { WorkspaceChatMessage } from "@/common/orpc/types";
import { CONTEXT_BOUNDARY_KINDS } from "@/common/utils/messages/compactionBoundary";
import { createTestHistoryService } from "./testHistoryService";
import { NAME_GEN_PREFERRED_MODELS } from "@/common/constants/nameGeneration";

afterEach(() => {
  mock.restore();
});

function createFakeModel(modelId = "side-question-model"): LanguageModel {
  return {
    specificationVersion: "v3",
    provider: "test",
    modelId,
    supportedUrls: {},
    doGenerate: () => Promise.reject(new Error("doGenerate unused in side-question tests")),
    doStream: () => Promise.reject(new Error("doStream unused in side-question tests")),
  };
}

/**
 * Fake AIService for side-question tests. `getStreamInfo` defaults to
 * "no main-agent stream is in flight" so the side question records no
 * interruption metadata; callers that want to exercise the split path
 * override it with a `streamInfo` arg.
 */
function createFakeAIService(
  model: LanguageModel,
  streamInfo?: ReturnType<AIService["getStreamInfo"]>
): SideQuestionAIService {
  return {
    createModel: () => Promise.resolve(Ok(model)),
    getStreamInfo: () => streamInfo,
    // Identity resolution: no custom-provider mappedToModel aliases in tests.
    resolveMetadataModel: (modelString: string) => modelString,
  };
}

/** Fake textStream that emits a fixed sequence of chunks. */
function fakeTextStream(
  chunks: readonly string[],
  opts?: { usage?: { inputTokens: number; outputTokens: number; totalTokens: number } }
) {
  async function* gen() {
    for (const c of chunks) {
      // The await is purely formal — bun-test's async generator typing
      // requires at least one await for `require-await`, and yielding to
      // the microtask queue here also exercises the consumer's `for await`
      // back-pressure handling the way a real provider stream would.
      await Promise.resolve();
      yield c;
    }
  }
  return {
    textStream: gen(),
    ...(opts?.usage !== undefined ? { totalUsage: Promise.resolve(opts.usage) } : {}),
  } as unknown as ReturnType<typeof aiSdk.streamText>;
}

describe("buildSideQuestionMessages", () => {
  test("wraps the question in a <system-reminder> and exposes the transcript", () => {
    const { system, messages } = buildSideQuestionMessages(
      "what file did you just edit?",
      "User: change the config\nAssistant: edited src/config.ts"
    );

    // We deliberately do NOT assert the prompt's wording here — that would be
    // a tautology against the literal in `buildSideQuestionMessages`. The
    // tools-denied contract is exercised behaviorally below (the streamText
    // call asserts `receivedTools === undefined`). What matters structurally
    // is: exactly one user message, the question shows through, and the
    // transcript we passed in is present so the model can ground on it.
    expect(typeof system).toBe("string");
    expect(messages).toHaveLength(1);
    const content = messages[0]?.content as string;
    expect(content).toContain("what file did you just edit?");
    expect(content).toContain("Assistant: edited src/config.ts");
  });

  test("handles an empty transcript gracefully", () => {
    const { messages } = buildSideQuestionMessages("hi", "");
    const content = messages[0]?.content as string;
    expect(content).toContain("(empty transcript)");
  });
});

describe("askSideQuestion (persisted, streaming)", () => {
  test("persists user + assistant messages and emits stream-start/delta/end", async () => {
    const { historyService, cleanup } = await createTestHistoryService();
    try {
      const workspaceId = "ws-btw-stream";
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("m1", "user", "what is 2+2")
      );
      await historyService.appendToHistory(workspaceId, createMuxMessage("m2", "assistant", "4"));

      let receivedTools: unknown;
      const streamUsage = { inputTokens: 100, outputTokens: 5, totalTokens: 105 };
      spyOn(aiSdk, "streamText").mockImplementation(((opts: unknown) => {
        receivedTools = (opts as { tools?: unknown }).tools;
        return fakeTextStream(["Yes — ", "**4**", ", as I said."], { usage: streamUsage });
      }) as unknown as typeof aiSdk.streamText);

      const recordUsageCalls: Array<{ modelString: string; usage: unknown }> = [];
      const emitted: WorkspaceChatMessage[] = [];
      const result = await askSideQuestion({
        workspaceId,
        question: "are you sure?",
        candidates: ["openai:gpt-4.1-mini"],
        aiService: {
          ...createFakeAIService(createFakeModel()),
          // Distinct mapped target proves the RESOLVED model is persisted
          // (custom-provider mappedToModel aliases price via metadataModel).
          resolveMetadataModel: () => "openai:mapped-target",
        },
        historyService,
        emitChatEvent: (_wsId, message) => emitted.push(message),
        recordUsage: (modelString, usage) => {
          recordUsageCalls.push({ modelString, usage });
          return Promise.resolve();
        },
      });

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.answer).toBe("Yes — **4**, as I said.");

      // Tool-blocking contract: no tools were passed to the model.
      expect(receivedTools).toBeUndefined();

      // Chat events: user message + assistant placeholder + stream-start +
      // N deltas + stream-end. The assistant placeholder is emitted as a
      // `message` event so the frontend aggregator sees the
      // side-question-answer muxMetadata BEFORE stream-start — without
      // that, the badge and the main-agent suspension layer (which both
      // key off muxMetadata) lose the marker for the entire stream.
      const types = emitted.map((m) => m.type);
      expect(types[0]).toBe("message"); // user /btw
      expect(types[1]).toBe("message"); // assistant placeholder
      expect(types[2]).toBe("stream-start");
      expect(types[types.length - 1]).toBe("stream-end");
      // At least one stream-delta in between (one per non-empty chunk).
      expect(types.filter((t) => t === "stream-delta").length).toBe(3);

      // The placeholder envelope carries the side-question-answer marker
      // so the live aggregator can pick it up before any text streams in.
      const placeholder = emitted[1];
      // Narrow defensively — the test's `WorkspaceChatMessage` type covers
      // many shapes; muxMetadata only lives on `message` envelopes.
      const placeholderMuxMeta =
        placeholder.type === "message"
          ? (placeholder.metadata?.muxMetadata as { type?: string } | undefined)
          : undefined;
      expect(placeholderMuxMeta?.type).toBe("side-question-answer");

      const terminalEvent = emitted.at(-1);
      const terminalMuxMeta =
        terminalEvent?.type === "stream-end"
          ? (terminalEvent.metadata.muxMetadata as { type?: string } | undefined)
          : undefined;
      expect(terminalMuxMeta?.type).toBe("side-question-answer");
      // Double-count guard: the live Costs cache gets this turn's spend from
      // the recordUsage callback (session-usage-delta); WorkspaceStore ALSO
      // accumulates stream-end metadata.usage, so the terminal stream-end
      // must not carry usage or open workspaces would count the turn twice.
      expect(recordUsageCalls).toEqual([
        { modelString: "openai:gpt-4.1-mini", usage: streamUsage },
      ]);
      expect(
        terminalEvent?.type === "stream-end" ? terminalEvent.metadata.usage : null
      ).toBeUndefined();

      // History: m1, m2, user /btw, assistant /btw answer.
      const after = await historyService.getLastMessages(workspaceId, 10);
      expect(after.success).toBe(true);
      if (!after.success) return;
      expect(after.data).toHaveLength(4);
      const user = after.data[2];
      const assistant = after.data[3];
      expect(user.role).toBe("user");
      expect(user.metadata?.muxMetadata?.type).toBe("side-question");
      expect(user.metadata?.muxMetadata?.commandPrefix).toBe("/btw");
      expect(assistant.role).toBe("assistant");
      expect(assistant.metadata?.muxMetadata?.type).toBe("side-question-answer");
      // The answer row stores both the raw model (attribution) and the
      // resolved metadata model (ETL pricing for mapped custom models).
      expect(assistant.metadata?.model).toBe("openai:gpt-4.1-mini");
      expect(assistant.metadata?.metadataModel).toBe("openai:mapped-target");
      // The assistant's text part should contain the full streamed answer.
      const textPart = assistant.parts.find(
        (p): p is Extract<typeof p, { type: "text" }> => p.type === "text"
      );
      expect(textPart?.text).toBe("Yes — **4**, as I said.");
    } finally {
      await cleanup();
    }
  });

  test("emits the live answer but returns an error when persistence fails", async () => {
    const { historyService, cleanup } = await createTestHistoryService();
    try {
      const workspaceId = "ws-btw-persist-fails";
      spyOn(aiSdk, "streamText").mockImplementation((() =>
        fakeTextStream(["visible answer"])) as unknown as typeof aiSdk.streamText);
      spyOn(historyService, "updateHistory").mockResolvedValueOnce(Err("disk full"));

      const emitted: WorkspaceChatMessage[] = [];
      const result = await askSideQuestion({
        workspaceId,
        question: "will this persist?",
        candidates: ["openai:gpt-4.1-mini"],
        aiService: createFakeAIService(createFakeModel()),
        historyService,
        emitChatEvent: (_wsId, message) => emitted.push(message),
      });

      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error.raw).toBe("disk full");

      const streamEnd = emitted.find((message) => message.type === "stream-end");
      expect(streamEnd?.type).toBe("stream-end");
      if (streamEnd?.type !== "stream-end") return;
      expect(streamEnd.parts).toEqual([{ type: "text", text: "visible answer" }]);

      const after = await historyService.getLastMessages(workspaceId, 10);
      expect(after.success).toBe(true);
      if (!after.success) return;
      const assistantRows = after.data.filter((message) => message.role === "assistant");
      expect(assistantRows).toHaveLength(1);
      expect(assistantRows[0].parts).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  test("excludes prior side-question turns from the transcript", async () => {
    const { historyService, cleanup } = await createTestHistoryService();
    try {
      const workspaceId = "ws-btw-skip-prior";
      // Real turn + a prior /btw exchange that should NOT leak into the
      // transcript for the next /btw.
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("u1", "user", "regular question")
      );
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("a1", "assistant", "regular answer")
      );
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("u2", "user", "old side q", {
          muxMetadata: { type: "side-question", rawCommand: "/btw old", commandPrefix: "/btw" },
        })
      );
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("a2", "assistant", "old side a", {
          muxMetadata: { type: "side-question-answer" },
        })
      );

      let capturedPrompt: string | undefined;
      spyOn(aiSdk, "streamText").mockImplementation(((opts: unknown) => {
        const messages = (opts as { messages: Array<{ content: string }> }).messages;
        capturedPrompt = messages[0]?.content;
        return fakeTextStream(["ok"]);
      }) as unknown as typeof aiSdk.streamText);

      const result = await askSideQuestion({
        workspaceId,
        question: "new question",
        candidates: ["openai:gpt-4.1-mini"],
        aiService: createFakeAIService(createFakeModel()),
        historyService,
        // No-op emitter: this test only inspects the prompt the model
        // receives. We intentionally drop chat events here so any
        // accidental dependence on emit ordering would surface as a test
        // failure rather than a silent pass.
        emitChatEvent: () => undefined,
      });

      expect(result.success).toBe(true);
      expect(capturedPrompt).toBeDefined();
      // Regular turn included, side-question artifacts excluded.
      expect(capturedPrompt).toContain("regular question");
      expect(capturedPrompt).toContain("regular answer");
      expect(capturedPrompt).not.toContain("old side q");
      expect(capturedPrompt).not.toContain("old side a");
    } finally {
      await cleanup();
    }
  });

  test("keeps legacy tool-* parts visible and skips malformed parts in the transcript", async () => {
    const { historyService, cleanup } = await createTestHistoryService();
    try {
      const workspaceId = "ws-btw-legacy-tool-part";
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("u1", "user", "run tests")
      );
      const legacyAssistant = {
        id: "a-legacy-tool",
        role: "assistant" as const,
        metadata: { timestamp: 1 },
        parts: [null, { type: 42 }, { type: "tool-bash" as const }],
      };
      // Older or hand-edited chat.jsonl rows can still contain AI SDK
      // `tool-<name>` parts (or malformed junk) even though current
      // `MuxMessage` types only model `dynamic-tool`. Preserve that legacy
      // shape here so /btw transcript generation stays upgrade-safe and
      // self-healing.
      await historyService.appendToHistory(workspaceId, legacyAssistant as unknown as MuxMessage);

      let capturedPrompt: string | undefined;
      spyOn(aiSdk, "streamText").mockImplementation(((opts: unknown) => {
        const messages = (opts as { messages: Array<{ content: string }> }).messages;
        capturedPrompt = messages[0]?.content;
        return fakeTextStream(["ok"]);
      }) as unknown as typeof aiSdk.streamText);

      const result = await askSideQuestion({
        workspaceId,
        question: "what command just ran?",
        candidates: ["openai:gpt-4.1-mini"],
        aiService: createFakeAIService(createFakeModel()),
        historyService,
        emitChatEvent: () => undefined,
      });

      expect(result.success).toBe(true);
      expect(capturedPrompt).toContain("[tool bash]");
    } finally {
      await cleanup();
    }
  });

  test("keeps recent main-chat context even after many prior /btw rows", async () => {
    const { historyService, cleanup } = await createTestHistoryService();
    try {
      const workspaceId = "ws-btw-many-prior";
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("main-context", "user", "main context should survive")
      );
      for (let i = 0; i < 120; i++) {
        await historyService.appendToHistory(
          workspaceId,
          createMuxMessage(`prior-side-q-${i}`, "user", `prior side question ${i}`, {
            muxMetadata: {
              type: "side-question",
              rawCommand: `/btw prior side question ${i}`,
              commandPrefix: "/btw",
            },
          })
        );
        await historyService.appendToHistory(
          workspaceId,
          createMuxMessage(`prior-side-a-${i}`, "assistant", `prior side answer ${i}`, {
            muxMetadata: { type: "side-question-answer" },
          })
        );
      }

      let capturedPrompt: string | undefined;
      spyOn(aiSdk, "streamText").mockImplementation(((opts: unknown) => {
        const messages = (opts as { messages: Array<{ content: string }> }).messages;
        capturedPrompt = messages[0]?.content;
        return fakeTextStream(["ok"]);
      }) as unknown as typeof aiSdk.streamText);

      const result = await askSideQuestion({
        workspaceId,
        question: "what context is active?",
        candidates: ["openai:gpt-4.1-mini"],
        aiService: createFakeAIService(createFakeModel()),
        historyService,
        emitChatEvent: () => undefined,
      });

      expect(result.success).toBe(true);
      expect(capturedPrompt).toContain("main context should survive");
      expect(capturedPrompt).not.toContain("prior side answer 119");
    } finally {
      await cleanup();
    }
  });

  test("honors durable context resets when building the transcript", async () => {
    const { historyService, cleanup } = await createTestHistoryService();
    try {
      const workspaceId = "ws-btw-context-reset";
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("pre-reset-user", "user", "forget this old topic")
      );
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("reset-boundary", "assistant", "", {
          contextBoundaryKind: CONTEXT_BOUNDARY_KINDS.RESET,
        })
      );
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("post-reset-user", "user", "keep this new topic")
      );

      let capturedPrompt: string | undefined;
      spyOn(aiSdk, "streamText").mockImplementation(((opts: unknown) => {
        const messages = (opts as { messages: Array<{ content: string }> }).messages;
        capturedPrompt = messages[0]?.content;
        return fakeTextStream(["ok"]);
      }) as unknown as typeof aiSdk.streamText);

      const result = await askSideQuestion({
        workspaceId,
        question: "what context is active?",
        candidates: ["openai:gpt-4.1-mini"],
        aiService: createFakeAIService(createFakeModel()),
        historyService,
        emitChatEvent: () => undefined,
      });

      expect(result.success).toBe(true);
      expect(capturedPrompt).toBeDefined();
      expect(capturedPrompt).not.toContain("forget this old topic");
      expect(capturedPrompt).toContain("keep this new topic");
    } finally {
      await cleanup();
    }
  });

  test("includes the latest visible main-agent stream text in the transcript", async () => {
    const { historyService, cleanup } = await createTestHistoryService();
    try {
      const workspaceId = "ws-btw-live-stream-context";
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("u1", "user", "what are you drafting?")
      );

      const liveHistoryMessage = createMuxMessage("live-main-answer", "assistant", "", {
        model: "openai:gpt-live",
      });
      await historyService.appendToHistory(workspaceId, liveHistoryMessage);
      const liveHistorySequence = liveHistoryMessage.metadata?.historySequence;
      if (typeof liveHistorySequence !== "number") {
        throw new Error("expected history sequence for live main answer");
      }
      const partialWrite = await historyService.writePartial(workspaceId, {
        ...liveHistoryMessage,
        metadata: {
          ...liveHistoryMessage.metadata,
          historySequence: liveHistorySequence,
        },
        parts: [{ type: "text", text: "older flushed partial text" }],
      });
      expect(partialWrite.success).toBe(true);

      const liveParts = [{ type: "text" as const, text: "latest visible streamed sentence" }];
      const appendToHistory = historyService.appendToHistory.bind(historyService);
      let appendCount = 0;
      spyOn(historyService, "appendToHistory").mockImplementation(
        async (appendWorkspaceId, message) => {
          const appendResult = await appendToHistory(appendWorkspaceId, message);
          appendCount += 1;
          if (appendCount === 1) {
            liveParts[0].text = "future text after /btw fired";
          }
          return appendResult;
        }
      );

      let capturedPrompt: string | undefined;
      spyOn(aiSdk, "streamText").mockImplementation(((opts: unknown) => {
        const messages = (opts as { messages: Array<{ content: string }> }).messages;
        capturedPrompt = messages[0]?.content;
        return fakeTextStream(["ok"]);
      }) as unknown as typeof aiSdk.streamText);

      const result = await askSideQuestion({
        workspaceId,
        question: "what did you just say?",
        candidates: ["openai:gpt-4.1-mini"],
        aiService: createFakeAIService(createFakeModel(), {
          messageId: "live-main-answer",
          model: "openai:gpt-live",
          historySequence: liveHistorySequence,
          startTime: 1_000,
          parts: liveParts,
          toolCompletionTimestamps: new Map(),
        }),
        historyService,
        emitChatEvent: () => undefined,
      });

      expect(result.success).toBe(true);
      expect(capturedPrompt).toContain("what are you drafting?");
      expect(capturedPrompt).toContain("latest visible streamed sentence");
      expect(capturedPrompt).not.toContain("older flushed partial text");
      expect(capturedPrompt).not.toContain("future text after /btw fired");
    } finally {
      await cleanup();
    }
  });

  test("rejects empty questions before contacting the model", async () => {
    const { historyService, cleanup } = await createTestHistoryService();
    try {
      const streamTextSpy = spyOn(aiSdk, "streamText");
      const result = await askSideQuestion({
        workspaceId: "ws-btw-empty-q",
        question: "   ",
        candidates: ["openai:gpt-4.1-mini"],
        aiService: createFakeAIService(createFakeModel()),
        historyService,
        // No-op emitter — empty-question path short-circuits before any
        // chat event would be emitted, so we don't capture them.
        emitChatEvent: () => undefined,
      });

      expect(result.success).toBe(false);
      // Defense-in-depth: an empty question must not burn an API call or
      // pollute history with an empty user row.
      expect(streamTextSpy).not.toHaveBeenCalled();
    } finally {
      await cleanup();
    }
  });

  test("returns an error, deletes the placeholder, and closes the stream when the model produces empty text", async () => {
    const { historyService, cleanup } = await createTestHistoryService();
    try {
      spyOn(aiSdk, "streamText").mockImplementation((() =>
        fakeTextStream(["   "])) as unknown as typeof aiSdk.streamText);

      const emitted: WorkspaceChatMessage[] = [];
      const result = await askSideQuestion({
        workspaceId: "ws-btw-empty",
        question: "anything?",
        candidates: ["openai:gpt-4.1-mini"],
        aiService: createFakeAIService(createFakeModel()),
        historyService,
        emitChatEvent: (_wsId, m) => emitted.push(m),
      });

      expect(result.success).toBe(false);

      // The placeholder must be removed so a retry on the next candidate
      // doesn't render alongside the empty failed row. We assert both
      // sides of the contract: the live `delete` chat event AND the
      // chat.jsonl removal.
      const deleteEvents = emitted.filter((m) => m.type === "delete");
      expect(deleteEvents).toHaveLength(1);

      const after = await historyService.getLastMessages("ws-btw-empty", 10);
      expect(after.success).toBe(true);
      if (!after.success) return;
      // Only the /btw user question survives; the empty assistant
      // placeholder was wiped.
      const assistantRows = after.data.filter((m) => m.role === "assistant");
      expect(assistantRows).toHaveLength(0);

      // Stream-end must fire before delete while the side-answer row still
      // exists, so WorkspaceStore can recognize the /btw terminal event and
      // drain any buffered main-agent deltas. Delete then removes the failed
      // row from the live transcript.
      const eventTypes = emitted.map((m) => m.type);
      const streamEndIndex = eventTypes.indexOf("stream-end");
      const deleteIndex = eventTypes.indexOf("delete");
      expect(streamEndIndex).toBeGreaterThanOrEqual(0);
      expect(deleteIndex).toBeGreaterThan(streamEndIndex);
    } finally {
      await cleanup();
    }
  });

  test("tries through the first fallback model when configured candidates fail creation", async () => {
    const { historyService, cleanup } = await createTestHistoryService();
    try {
      spyOn(aiSdk, "streamText").mockImplementation((() =>
        fakeTextStream(["fallback answer"])) as unknown as typeof aiSdk.streamText);

      const fallbackModel = NAME_GEN_PREFERRED_MODELS[0];
      const staleCandidates = ["stale-live", "stale-chat", "stale-agent"];
      const createModel = mock((modelString: string) => {
        if (modelString === fallbackModel) {
          return Promise.resolve(Ok(createFakeModel(modelString)));
        }
        return Promise.resolve(Err({ type: "model_not_available", modelId: modelString } as const));
      });

      const result = await askSideQuestion({
        workspaceId: "ws-btw-fallback-after-stale-models",
        question: "can you still answer?",
        candidates: [...staleCandidates, fallbackModel],
        aiService: {
          createModel,
          getStreamInfo: () => undefined,
          resolveMetadataModel: (modelString: string) => modelString,
        } as unknown as AIService,
        historyService,
        emitChatEvent: () => undefined,
      });

      expect(result.success).toBe(true);
      expect(createModel.mock.calls.map((call) => call[0])).toEqual([
        ...staleCandidates,
        fallbackModel,
      ]);
    } finally {
      await cleanup();
    }
  });

  test("on retry: discards the failed candidate's partial output before the next candidate streams", async () => {
    // Regression coverage for the Codex P2 review thread:
    //   When candidate A streams some text and then throws, the next
    //   candidate B must NOT render alongside A's partial output. The
    //   service deletes A's placeholder + emits a `delete` chat event so
    //   both the live aggregator and chat.jsonl forget A entirely.
    const { historyService, cleanup } = await createTestHistoryService();
    try {
      let callCount = 0;
      spyOn(aiSdk, "streamText").mockImplementation((() => {
        callCount += 1;
        if (callCount === 1) {
          // Candidate A: stream a chunk, then explode mid-stream.
          async function* failingGen() {
            await Promise.resolve();
            yield "partial-A-";
            throw new Error("candidate A fell over");
          }
          return { textStream: failingGen() } as unknown as ReturnType<typeof aiSdk.streamText>;
        }
        // Candidate B: clean stream.
        return fakeTextStream(["final-B"]);
      }) as unknown as typeof aiSdk.streamText);

      const emitted: WorkspaceChatMessage[] = [];
      const workspaceId = "ws-btw-retry";
      const result = await askSideQuestion({
        workspaceId,
        question: "explain something",
        candidates: ["bad-candidate", "good-candidate"],
        aiService: createFakeAIService(createFakeModel()),
        historyService,
        emitChatEvent: (_wsId, m) => emitted.push(m),
      });

      expect(result.success).toBe(true);
      if (!result.success) return;
      // Only the second candidate's text survives.
      expect(result.data.answer).toBe("final-B");

      // The failed candidate must close its side stream before deleting the
      // placeholder, and delete BEFORE the second candidate's stream-start.
      // Closing first drains WorkspaceStore's side-question buffer; deleting
      // before the retry ensures the live aggregator drops partial-A before
      // any new content arrives.
      const eventTypes = emitted.map((m) => m.type);
      const firstStreamEnd = eventTypes.indexOf("stream-end");
      const firstDelete = eventTypes.indexOf("delete");
      const lastStreamStart = eventTypes.lastIndexOf("stream-start");
      expect(firstStreamEnd).toBeGreaterThanOrEqual(0);
      expect(firstDelete).toBeGreaterThan(firstStreamEnd);
      expect(firstDelete).toBeLessThan(lastStreamStart);

      // chat.jsonl ends with exactly one user row + one assistant answer
      // (the failed placeholder was deleted; the second candidate's
      // placeholder was updated in place to hold "final-B").
      const after = await historyService.getLastMessages(workspaceId, 10);
      expect(after.success).toBe(true);
      if (!after.success) return;
      const assistantRows = after.data.filter((m) => m.role === "assistant");
      expect(assistantRows).toHaveLength(1);
      const textPart = assistantRows[0].parts.find(
        (p): p is Extract<typeof p, { type: "text" }> => p.type === "text"
      );
      expect(textPart?.text).toBe("final-B");
    } finally {
      await cleanup();
    }
  });
});
