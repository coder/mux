import { describe, expect, it } from "bun:test";
import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3FinishReason,
  LanguageModelV3StreamPart,
  LanguageModelV3StreamResult,
  LanguageModelV3Usage,
} from "@ai-sdk/provider";
import { wrapCopilotResponsesModel } from "../copilotResponsesModel";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Minimal stub LanguageModelV3 whose doStream returns a hand-crafted stream. */
function createStubModel(
  streamParts: LanguageModelV3StreamPart[]
): LanguageModelV3 & { lastStreamOptions: LanguageModelV3CallOptions | null } {
  const stub = {
    specificationVersion: "v3" as const,
    provider: "github-copilot.responses",
    modelId: "gpt-5.2",
    supportedUrls: {},
    lastStreamOptions: null as LanguageModelV3CallOptions | null,

    doGenerate: () => {
      throw new Error("doGenerate not implemented in stub");
    },

    doStream(options: LanguageModelV3CallOptions): PromiseLike<LanguageModelV3StreamResult> {
      stub.lastStreamOptions = options;
      return Promise.resolve({
        stream: new ReadableStream<LanguageModelV3StreamPart>({
          start(controller) {
            for (const part of streamParts) {
              controller.enqueue(part);
            }
            controller.close();
          },
        }),
      });
    },
  };
  return stub;
}

/** Collect all parts from a ReadableStream. */
async function collectStream(
  stream: ReadableStream<LanguageModelV3StreamPart>
): Promise<LanguageModelV3StreamPart[]> {
  const parts: LanguageModelV3StreamPart[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
  }
  return parts;
}

/** Build a raw chunk wrapping a Responses SSE event. */
function raw(event: Record<string, unknown>): LanguageModelV3StreamPart {
  return { type: "raw", rawValue: event };
}

/** Build a V3-compliant usage object for tests. */
function makeUsage(inputTotal: number, outputTotal: number): LanguageModelV3Usage {
  return {
    inputTokens: {
      total: inputTotal,
      noCache: undefined,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: { total: outputTotal, text: undefined, reasoning: undefined },
  };
}

/** Build a finish stream part with V3-compliant usage. */
function finish(
  reason: LanguageModelV3FinishReason["unified"],
  inputTotal: number,
  outputTotal: number
): LanguageModelV3StreamPart {
  // Use a typed variable to satisfy consistent-type-assertions lint rule.
  const part: LanguageModelV3StreamPart = {
    type: "finish",
    finishReason: { unified: reason, raw: reason },
    usage: makeUsage(inputTotal, outputTotal),
  };
  return part;
}

// ---------------------------------------------------------------------------
// Minimal stub call options
// ---------------------------------------------------------------------------
const baseOptions: LanguageModelV3CallOptions = {
  prompt: [],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("wrapCopilotResponsesModel", () => {
  describe("text lifecycle", () => {
    it("rebuilds coherent text-start / text-delta / text-end from raw events", async () => {
      const messageItemId = "msg_001";
      const stub = createStubModel([
        raw({
          type: "response.output_item.added",
          item: { id: messageItemId, type: "message" },
          output_index: 0,
        }),
        raw({
          type: "response.output_text.delta",
          item_id: messageItemId,
          content_index: 0,
          delta: "Hello",
        }),
        raw({
          type: "response.output_text.delta",
          item_id: messageItemId,
          content_index: 0,
          delta: " world",
        }),
        raw({
          type: "response.output_item.done",
          item: { id: messageItemId, type: "message" },
          output_index: 0,
        }),
        finish("stop", 10, 5),
      ]);

      const wrapped = wrapCopilotResponsesModel(stub);
      const result = await wrapped.doStream(baseOptions);
      const parts = await collectStream(result.stream);

      // Should see coherent lifecycle from our wrapper
      const types = parts.map((p) => p.type);
      expect(types).toEqual([
        "text-start", // from response.output_item.added (message)
        "text-delta", // from response.output_text.delta "Hello"
        "text-delta", // from response.output_text.delta " world"
        "text-end", // from response.output_item.done (message)
        "finish",
      ]);

      // Verify text content
      const deltas = parts.filter((p) => p.type === "text-delta") as Array<{
        type: "text-delta";
        delta: string;
      }>;
      expect(deltas.map((d) => d.delta)).toEqual(["Hello", " world"]);
    });

    it("handles orphaned text deltas (delta before output_item.added)", async () => {
      const messageItemId = "msg_orphan";
      const stub = createStubModel([
        // Copilot sends text delta BEFORE output_item.added — the wrapper should
        // defensively emit text-start when it sees the first delta for an unknown item.
        raw({
          type: "response.output_text.delta",
          item_id: messageItemId,
          content_index: 0,
          delta: "Early",
        }),
        raw({
          type: "response.output_item.added",
          item: { id: messageItemId, type: "message" },
          output_index: 0,
        }),
        raw({
          type: "response.output_text.delta",
          item_id: messageItemId,
          content_index: 0,
          delta: " text",
        }),
        raw({
          type: "response.output_item.done",
          item: { id: messageItemId, type: "message" },
          output_index: 0,
        }),
        finish("stop", 5, 3),
      ]);

      const wrapped = wrapCopilotResponsesModel(stub);
      const result = await wrapped.doStream(baseOptions);
      const parts = await collectStream(result.stream);

      const types = parts.map((p) => p.type);
      // The first delta triggers a defensive text-start.
      // The output_item.added for message also triggers text-start (for a new key).
      // But both share the same itemId, so output_item.done closes them.
      expect(types).toContain("text-start");
      expect(types).toContain("text-delta");
      expect(types).toContain("text-end");
      expect(types).toContain("finish");

      // The deltas should both be present
      const deltas = parts.filter((p) => p.type === "text-delta") as Array<{
        type: "text-delta";
        delta: string;
      }>;
      expect(deltas.map((d) => d.delta)).toContain("Early");
      expect(deltas.map((d) => d.delta)).toContain(" text");
    });

    // Regression: flush() must emit text-end with the same composite id used
    // by text-start, so downstream consumers (e.g. DevTools) can match them.
    it("flush emits text-end with the same composite id as text-start", async () => {
      const messageItemId = "msg_flush_regression";
      const expectedId = `${messageItemId}:0`;
      // Stream that opens a text part but never closes it — no content_part.done
      // or output_item.done, just a finish event followed by stream close.
      const stub = createStubModel([
        raw({
          type: "response.output_item.added",
          item: { id: messageItemId, type: "message" },
          output_index: 0,
        }),
        raw({
          type: "response.output_text.delta",
          item_id: messageItemId,
          content_index: 0,
          delta: "Hello world",
        }),
        // Stream ends here — no content_part.done, no output_item.done.
        finish("stop", 10, 5),
      ]);

      const wrapped = wrapCopilotResponsesModel(stub);
      const result = await wrapped.doStream(baseOptions);
      const parts = await collectStream(result.stream);

      // The flush fallback must close the open text part.
      const textEnds = parts.filter((p) => p.type === "text-end") as Array<{
        type: "text-end";
        id: string;
      }>;
      expect(textEnds).toHaveLength(1);
      expect(textEnds[0].id).toBe(expectedId);

      // Verify the full lifecycle is coherent: text-start, text-delta, text-end
      // all use the same composite id.
      const textStarts = parts.filter((p) => p.type === "text-start") as Array<{
        type: "text-start";
        id: string;
      }>;
      expect(textStarts).toHaveLength(1);
      expect(textStarts[0].id).toBe(expectedId);

      const textDeltas = parts.filter((p) => p.type === "text-delta") as Array<{
        type: "text-delta";
        id: string;
        delta: string;
      }>;
      expect(textDeltas).toHaveLength(1);
      expect(textDeltas[0].id).toBe(expectedId);
      expect(textDeltas[0].delta).toBe("Hello world");
    });
  });

  describe("inner semantic part suppression", () => {
    it("suppresses inner text-start/text-delta/text-end and rebuilds from raw", async () => {
      // Simulates what the real inner model emits: both raw events AND semantic parts.
      // The wrapper should suppress the semantic parts and only emit its own rebuilds.
      const innerTextStart: LanguageModelV3StreamPart = { type: "text-start", id: "msg_sup" };
      const innerTextDelta: LanguageModelV3StreamPart = {
        type: "text-delta",
        id: "msg_sup",
        delta: "Hi",
      };
      const innerTextEnd: LanguageModelV3StreamPart = { type: "text-end", id: "msg_sup" };
      const stub = createStubModel([
        raw({
          type: "response.output_item.added",
          item: { id: "msg_sup", type: "message" },
          output_index: 0,
        }),
        innerTextStart,
        raw({
          type: "response.output_text.delta",
          item_id: "msg_sup",
          content_index: 0,
          delta: "Hi",
        }),
        innerTextDelta,
        raw({
          type: "response.output_item.done",
          item: { id: "msg_sup", type: "message" },
          output_index: 0,
        }),
        innerTextEnd,
        finish("stop", 1, 1),
      ]);

      const wrapped = wrapCopilotResponsesModel(stub);
      const result = await wrapped.doStream(baseOptions);
      const parts = await collectStream(result.stream);

      // Should have exactly one text-start, one text-delta, one text-end — no duplicates
      const types = parts.map((p) => p.type);
      expect(types).toEqual(["text-start", "text-delta", "text-end", "finish"]);
    });

    it("suppresses inner tool-input-start/delta/end/tool-call and rebuilds from raw", async () => {
      const innerToolStart: LanguageModelV3StreamPart = {
        type: "tool-input-start",
        id: "call_sup",
        toolName: "bash",
      };
      const innerToolDelta: LanguageModelV3StreamPart = {
        type: "tool-input-delta",
        id: "call_sup",
        delta: "{}",
      };
      const innerToolEnd: LanguageModelV3StreamPart = { type: "tool-input-end", id: "call_sup" };
      const innerToolCall: LanguageModelV3StreamPart = {
        type: "tool-call",
        toolCallId: "call_sup",
        toolName: "bash",
        input: "{}",
      };

      const stub = createStubModel([
        raw({
          type: "response.output_item.added",
          item: { id: "fc_sup", type: "function_call", call_id: "call_sup", name: "bash" },
          output_index: 0,
        }),
        innerToolStart,
        raw({ type: "response.function_call_arguments.delta", output_index: 0, delta: "{}" }),
        innerToolDelta,
        raw({
          type: "response.output_item.done",
          item: {
            id: "fc_sup",
            type: "function_call",
            call_id: "call_sup",
            name: "bash",
            arguments: "{}",
          },
          output_index: 0,
        }),
        innerToolEnd,
        innerToolCall,
        finish("tool-calls", 1, 1),
      ]);

      const wrapped = wrapCopilotResponsesModel(stub);
      const result = await wrapped.doStream(baseOptions);
      const parts = await collectStream(result.stream);

      // Should have exactly one of each — no duplicates from inner parts
      const types = parts.map((p) => p.type);
      expect(types).toEqual([
        "tool-input-start",
        "tool-input-delta",
        "tool-input-end",
        "tool-call",
        "finish",
      ]);
    });
  });

  describe("tool call lifecycle", () => {
    it("rebuilds tool-input-start / delta / end / tool-call from raw events", async () => {
      const callId = "call_abc123";
      const toolName = "bash";
      const stub = createStubModel([
        raw({
          type: "response.output_item.added",
          item: { id: "fc_001", type: "function_call", call_id: callId, name: toolName },
          output_index: 0,
        }),
        raw({ type: "response.function_call_arguments.delta", output_index: 0, delta: '{"script' }),
        raw({ type: "response.function_call_arguments.delta", output_index: 0, delta: '":"ls"}' }),
        raw({
          type: "response.output_item.done",
          item: {
            id: "fc_001",
            type: "function_call",
            call_id: callId,
            name: toolName,
            arguments: '{"script":"ls"}',
          },
          output_index: 0,
        }),
        finish("tool-calls", 20, 10),
      ]);

      const wrapped = wrapCopilotResponsesModel(stub);
      const result = await wrapped.doStream(baseOptions);
      const parts = await collectStream(result.stream);

      const types = parts.map((p) => p.type);
      expect(types).toEqual([
        "tool-input-start",
        "tool-input-delta",
        "tool-input-delta",
        "tool-input-end",
        "tool-call",
        "finish",
      ]);

      // Verify tool-call has correct args from output_item.done
      const toolCall = parts.find((p) => p.type === "tool-call") as {
        type: "tool-call";
        toolCallId: string;
        toolName: string;
        input: string;
      };
      expect(toolCall.toolCallId).toBe(callId);
      expect(toolCall.toolName).toBe(toolName);
      expect(toolCall.input).toBe('{"script":"ls"}');
    });
  });

  describe("finish / usage passthrough", () => {
    it("passes through finish and response-metadata unchanged", async () => {
      const responseMetadata: LanguageModelV3StreamPart = {
        type: "response-metadata",
        id: "resp_001",
        timestamp: new Date("2024-01-01"),
        modelId: "gpt-5.2",
      };
      const stub = createStubModel([responseMetadata, finish("stop", 100, 50)]);

      const wrapped = wrapCopilotResponsesModel(stub);
      const result = await wrapped.doStream(baseOptions);
      const parts = await collectStream(result.stream);

      expect(parts).toHaveLength(2);
      expect(parts[0].type).toBe("response-metadata");
      expect(parts[1].type).toBe("finish");

      const finishPart = parts[1] as { type: "finish"; usage: unknown; finishReason: unknown };
      expect(finishPart.usage).toEqual(makeUsage(100, 50));
    });
  });

  describe("terminal failure", () => {
    it("emits error part from response.failed raw event", async () => {
      const stub = createStubModel([
        raw({
          type: "response.failed",
          response: { error: { message: "Rate limit exceeded", code: "rate_limit" } },
        }),
        finish("error", 0, 0),
      ]);

      const wrapped = wrapCopilotResponsesModel(stub);
      const result = await wrapped.doStream(baseOptions);
      const parts = await collectStream(result.stream);

      const errorPart = parts.find((p) => p.type === "error");
      expect(errorPart).toBeDefined();
      expect((errorPart as { type: "error"; error: unknown }).error).toEqual({
        message: "Rate limit exceeded",
        code: "rate_limit",
      });
    });
  });

  describe("raw chunk passthrough", () => {
    it("forwards raw chunks when outer caller requested them", async () => {
      const stub = createStubModel([
        raw({
          type: "response.output_item.added",
          item: { id: "msg_r", type: "message" },
          output_index: 0,
        }),
        raw({
          type: "response.output_text.delta",
          item_id: "msg_r",
          content_index: 0,
          delta: "Hi",
        }),
        raw({
          type: "response.output_item.done",
          item: { id: "msg_r", type: "message" },
          output_index: 0,
        }),
        finish("stop", 1, 1),
      ]);

      const wrapped = wrapCopilotResponsesModel(stub);
      const result = await wrapped.doStream({ ...baseOptions, includeRawChunks: true });
      const parts = await collectStream(result.stream);

      // Should include raw chunks alongside rebuilt semantic parts
      const rawParts = parts.filter((p) => p.type === "raw");
      expect(rawParts.length).toBeGreaterThanOrEqual(3);

      // Should also include rebuilt semantic parts
      const types = parts.filter((p) => p.type !== "raw").map((p) => p.type);
      expect(types).toEqual(["text-start", "text-delta", "text-end", "finish"]);
    });

    it("suppresses raw chunks when outer caller did not request them", async () => {
      const stub = createStubModel([
        raw({
          type: "response.output_item.added",
          item: { id: "msg_s", type: "message" },
          output_index: 0,
        }),
        raw({
          type: "response.output_text.delta",
          item_id: "msg_s",
          content_index: 0,
          delta: "Hi",
        }),
        raw({
          type: "response.output_item.done",
          item: { id: "msg_s", type: "message" },
          output_index: 0,
        }),
        finish("stop", 1, 1),
      ]);

      const wrapped = wrapCopilotResponsesModel(stub);
      const result = await wrapped.doStream(baseOptions); // no includeRawChunks
      const parts = await collectStream(result.stream);

      // Should NOT include any raw chunks
      expect(parts.filter((p) => p.type === "raw")).toHaveLength(0);

      // Should include rebuilt semantic parts
      const types = parts.map((p) => p.type);
      expect(types).toEqual(["text-start", "text-delta", "text-end", "finish"]);
    });
  });

  describe("includeRawChunks forwarding", () => {
    it("always passes includeRawChunks: true to the inner model", async () => {
      const stub = createStubModel([finish("stop", 0, 0)]);

      const wrapped = wrapCopilotResponsesModel(stub);

      // Call without includeRawChunks
      await wrapped.doStream(baseOptions);
      expect(stub.lastStreamOptions?.includeRawChunks).toBe(true);
    });
  });

  describe("doGenerate passthrough", () => {
    it("delegates doGenerate to the inner model unchanged", async () => {
      const expectedResult = {
        content: [],
        text: "test",
        usage: makeUsage(5, 3),
        finishReason: { unified: "stop" as const, raw: "stop" },
        response: {},
        warnings: [],
      };

      const stub = createStubModel([]);
      stub.doGenerate = () => Promise.resolve(expectedResult) as never;

      const wrapped = wrapCopilotResponsesModel(stub);
      const result = await wrapped.doGenerate(baseOptions);
      expect(result).toBe(expectedResult);
    });
  });

  describe("content_part lifecycle events", () => {
    it("rebuilds text lifecycle from content_part.added / output_text.done / content_part.done", async () => {
      const messageItemId = "msg_cp";
      const stub = createStubModel([
        // output_item.added for the message
        raw({
          type: "response.output_item.added",
          item: { id: messageItemId, type: "message" },
          output_index: 0,
        }),
        // content_part.added with output_text type — should emit text-start
        // (but output_item.added already started one at index 0, so this is
        // for a second content part at index 1)
        raw({
          type: "response.content_part.added",
          item_id: messageItemId,
          content_index: 1,
          part: { type: "output_text", text: "" },
        }),
        // Text deltas for second content part
        raw({
          type: "response.output_text.delta",
          item_id: messageItemId,
          content_index: 1,
          delta: "Hello",
        }),
        raw({
          type: "response.output_text.delta",
          item_id: messageItemId,
          content_index: 1,
          delta: " world",
        }),
        // output_text.done reconciliation
        raw({
          type: "response.output_text.done",
          item_id: messageItemId,
          content_index: 1,
          text: "Hello world",
        }),
        // content_part.done closes the text part
        raw({
          type: "response.content_part.done",
          item_id: messageItemId,
          content_index: 1,
          part: { type: "output_text", text: "Hello world" },
        }),
        // Close any remaining text from output_item
        raw({
          type: "response.output_item.done",
          item: { id: messageItemId, type: "message" },
          output_index: 0,
        }),
        finish("stop", 10, 5),
      ]);

      const wrapped = wrapCopilotResponsesModel(stub);
      const result = await wrapped.doStream(baseOptions);
      const parts = await collectStream(result.stream);

      const types = parts.map((p) => p.type);

      // First text-start from output_item.added (index 0), second from content_part.added (index 1)
      expect(types).toEqual([
        "text-start", // from output_item.added (message, content_index 0)
        "text-start", // from content_part.added (output_text, content_index 1)
        "text-delta", // "Hello"
        "text-delta", // " world"
        "text-end", // from content_part.done (content_index 1)
        "text-end", // from output_item.done fallback (content_index 0)
        "finish",
      ]);

      // Each content index gets a unique composite id so downstream consumers
      // (e.g. DevTools) can track them independently.
      const textStarts = parts.filter((p) => p.type === "text-start") as Array<{
        type: "text-start";
        id: string;
      }>;
      expect(textStarts[0].id).toBe(`${messageItemId}:0`);
      expect(textStarts[1].id).toBe(`${messageItemId}:1`);

      const deltas = parts.filter((p) => p.type === "text-delta") as Array<{
        type: "text-delta";
        id: string;
        delta: string;
      }>;
      expect(deltas.map((d) => d.delta)).toEqual(["Hello", " world"]);
      // Deltas for content_index 1
      expect(deltas[0].id).toBe(`${messageItemId}:1`);
      expect(deltas[1].id).toBe(`${messageItemId}:1`);
    });

    it("content_part.added emits text-start and initial delta when part carries text", async () => {
      const messageItemId = "msg_cp_init";
      const stub = createStubModel([
        raw({
          type: "response.content_part.added",
          item_id: messageItemId,
          content_index: 0,
          part: { type: "output_text", text: "Initial" },
        }),
        raw({
          type: "response.output_text.delta",
          item_id: messageItemId,
          content_index: 0,
          delta: " more",
        }),
        raw({
          type: "response.content_part.done",
          item_id: messageItemId,
          content_index: 0,
          part: { type: "output_text", text: "Initial more" },
        }),
        finish("stop", 5, 3),
      ]);

      const wrapped = wrapCopilotResponsesModel(stub);
      const result = await wrapped.doStream(baseOptions);
      const parts = await collectStream(result.stream);

      const types = parts.map((p) => p.type);
      expect(types).toEqual([
        "text-start", // from content_part.added
        "text-delta", // "Initial" (initial text from content_part.added)
        "text-delta", // " more" (from output_text.delta)
        "text-end", // from content_part.done
        "finish",
      ]);

      const deltas = parts.filter((p) => p.type === "text-delta") as Array<{
        type: "text-delta";
        delta: string;
      }>;
      expect(deltas.map((d) => d.delta)).toEqual(["Initial", " more"]);
    });

    it("ignores content_part.added for non-output_text types", async () => {
      const messageItemId = "msg_cp_other";
      const stub = createStubModel([
        // A content_part.added with an unsupported type should not trigger text-start
        raw({
          type: "response.content_part.added",
          item_id: messageItemId,
          content_index: 0,
          part: { type: "refusal", refusal: "I cannot help with that" },
        }),
        finish("stop", 5, 1),
      ]);

      const wrapped = wrapCopilotResponsesModel(stub);
      const result = await wrapped.doStream(baseOptions);
      const parts = await collectStream(result.stream);

      const types = parts.map((p) => p.type);
      expect(types).toEqual(["finish"]);
    });
  });

  describe("output_text.done reconciliation", () => {
    it("emits trailing text delta when output_text.done has more text than accumulated deltas", async () => {
      const messageItemId = "msg_reconcile";
      const stub = createStubModel([
        raw({
          type: "response.output_item.added",
          item: { id: messageItemId, type: "message" },
          output_index: 0,
        }),
        raw({
          type: "response.output_text.delta",
          item_id: messageItemId,
          content_index: 0,
          delta: "Hello",
        }),
        // output_text.done has final text that includes trailing content not in deltas
        raw({
          type: "response.output_text.done",
          item_id: messageItemId,
          content_index: 0,
          text: "Hello world",
        }),
        raw({
          type: "response.output_item.done",
          item: { id: messageItemId, type: "message" },
          output_index: 0,
        }),
        finish("stop", 10, 5),
      ]);

      const wrapped = wrapCopilotResponsesModel(stub);
      const result = await wrapped.doStream(baseOptions);
      const parts = await collectStream(result.stream);

      const types = parts.map((p) => p.type);
      expect(types).toEqual([
        "text-start",
        "text-delta", // "Hello" from delta
        "text-delta", // " world" reconciled from output_text.done
        "text-end", // from output_item.done fallback
        "finish",
      ]);

      const deltas = parts.filter((p) => p.type === "text-delta") as Array<{
        type: "text-delta";
        delta: string;
      }>;
      expect(deltas.map((d) => d.delta)).toEqual(["Hello", " world"]);
    });

    it("does not emit extra delta when output_text.done matches accumulated text", async () => {
      const messageItemId = "msg_no_reconcile";
      const stub = createStubModel([
        raw({
          type: "response.output_item.added",
          item: { id: messageItemId, type: "message" },
          output_index: 0,
        }),
        raw({
          type: "response.output_text.delta",
          item_id: messageItemId,
          content_index: 0,
          delta: "Hello world",
        }),
        // output_text.done matches exactly — no reconciliation needed
        raw({
          type: "response.output_text.done",
          item_id: messageItemId,
          content_index: 0,
          text: "Hello world",
        }),
        raw({
          type: "response.output_item.done",
          item: { id: messageItemId, type: "message" },
          output_index: 0,
        }),
        finish("stop", 10, 5),
      ]);

      const wrapped = wrapCopilotResponsesModel(stub);
      const result = await wrapped.doStream(baseOptions);
      const parts = await collectStream(result.stream);

      const types = parts.map((p) => p.type);
      // Only one text-delta — no extra reconciliation delta
      expect(types).toEqual(["text-start", "text-delta", "text-end", "finish"]);

      const deltas = parts.filter((p) => p.type === "text-delta") as Array<{
        type: "text-delta";
        delta: string;
      }>;
      expect(deltas).toHaveLength(1);
      expect(deltas[0].delta).toBe("Hello world");
    });
  });

  describe("function_call_arguments.done lifecycle", () => {
    it("finalizes tool call from arguments.done, making output_item.done a no-op", async () => {
      const callId = "call_argsdone";
      const toolName = "bash";
      const stub = createStubModel([
        raw({
          type: "response.output_item.added",
          item: { id: "fc_ad", type: "function_call", call_id: callId, name: toolName },
          output_index: 0,
        }),
        raw({ type: "response.function_call_arguments.delta", output_index: 0, delta: '{"script' }),
        raw({ type: "response.function_call_arguments.delta", output_index: 0, delta: '":"ls"}' }),
        // function_call_arguments.done delivers final args and finalizes the tool
        raw({
          type: "response.function_call_arguments.done",
          output_index: 0,
          arguments: '{"script":"ls"}',
        }),
        // output_item.done should be a no-op since args-done already finalized
        raw({
          type: "response.output_item.done",
          item: {
            id: "fc_ad",
            type: "function_call",
            call_id: callId,
            name: toolName,
            arguments: '{"script":"ls"}',
          },
          output_index: 0,
        }),
        finish("tool-calls", 20, 10),
      ]);

      const wrapped = wrapCopilotResponsesModel(stub);
      const result = await wrapped.doStream(baseOptions);
      const parts = await collectStream(result.stream);

      const types = parts.map((p) => p.type);
      // Only one tool-input-end and one tool-call — not doubled by output_item.done
      expect(types).toEqual([
        "tool-input-start",
        "tool-input-delta",
        "tool-input-delta",
        "tool-input-end",
        "tool-call",
        "finish",
      ]);

      const toolCall = parts.find((p) => p.type === "tool-call") as {
        type: "tool-call";
        toolCallId: string;
        toolName: string;
        input: string;
      };
      expect(toolCall.toolCallId).toBe(callId);
      expect(toolCall.toolName).toBe(toolName);
      expect(toolCall.input).toBe('{"script":"ls"}');
    });

    it("reconciles arguments from done event when deltas were incomplete", async () => {
      const callId = "call_reconcile_args";
      const toolName = "file_read";
      const stub = createStubModel([
        raw({
          type: "response.output_item.added",
          item: { id: "fc_ra", type: "function_call", call_id: callId, name: toolName },
          output_index: 0,
        }),
        // Only partial arguments via delta
        raw({ type: "response.function_call_arguments.delta", output_index: 0, delta: '{"path":' }),
        // Done event carries the full arguments
        raw({
          type: "response.function_call_arguments.done",
          output_index: 0,
          arguments: '{"path":"src/test.ts"}',
        }),
        finish("tool-calls", 10, 5),
      ]);

      const wrapped = wrapCopilotResponsesModel(stub);
      const result = await wrapped.doStream(baseOptions);
      const parts = await collectStream(result.stream);

      const toolCall = parts.find((p) => p.type === "tool-call") as {
        type: "tool-call";
        input: string;
      };
      // Final input should be from the done event, not the incomplete deltas
      expect(toolCall.input).toBe('{"path":"src/test.ts"}');
    });
  });

  describe("content_part.done closes text before output_item.done", () => {
    it("content_part.done emits text-end so output_item.done does not double-close", async () => {
      const messageItemId = "msg_cp_first";
      const stub = createStubModel([
        raw({
          type: "response.output_item.added",
          item: { id: messageItemId, type: "message" },
          output_index: 0,
        }),
        raw({
          type: "response.output_text.delta",
          item_id: messageItemId,
          content_index: 0,
          delta: "Hi",
        }),
        // content_part.done closes the text part
        raw({
          type: "response.content_part.done",
          item_id: messageItemId,
          content_index: 0,
          part: { type: "output_text", text: "Hi" },
        }),
        // output_item.done should not double-close
        raw({
          type: "response.output_item.done",
          item: { id: messageItemId, type: "message" },
          output_index: 0,
        }),
        finish("stop", 5, 2),
      ]);

      const wrapped = wrapCopilotResponsesModel(stub);
      const result = await wrapped.doStream(baseOptions);
      const parts = await collectStream(result.stream);

      const types = parts.map((p) => p.type);
      // Exactly one text-end, not two
      expect(types).toEqual(["text-start", "text-delta", "text-end", "finish"]);
    });
  });

  describe("full plan lifecycle ordering", () => {
    it("handles the complete content_part event sequence from the plan", async () => {
      // Simulates the exact sequence from the accepted plan:
      // content_part.added → output_text.delta → output_text.done → content_part.done → output_item.done
      // This is the ordering that would previously trip "text part <id> not found".
      const messageItemId = "msg_plan";
      const stub = createStubModel([
        raw({
          type: "response.output_item.added",
          item: { id: messageItemId, type: "message" },
          output_index: 0,
        }),
        raw({
          type: "response.content_part.added",
          item_id: messageItemId,
          content_index: 0,
          part: { type: "output_text", text: "" },
        }),
        raw({
          type: "response.output_text.delta",
          item_id: messageItemId,
          content_index: 0,
          delta: "Test ",
        }),
        raw({
          type: "response.output_text.delta",
          item_id: messageItemId,
          content_index: 0,
          delta: "output",
        }),
        raw({
          type: "response.output_text.done",
          item_id: messageItemId,
          content_index: 0,
          text: "Test output",
        }),
        raw({
          type: "response.content_part.done",
          item_id: messageItemId,
          content_index: 0,
          part: { type: "output_text", text: "Test output" },
        }),
        raw({
          type: "response.output_item.done",
          item: { id: messageItemId, type: "message" },
          output_index: 0,
        }),
        finish("stop", 15, 8),
      ]);

      const wrapped = wrapCopilotResponsesModel(stub);
      const result = await wrapped.doStream(baseOptions);
      const parts = await collectStream(result.stream);

      const types = parts.map((p) => p.type);
      // output_item.added emits text-start for index 0,
      // content_part.added sees key already exists so does NOT emit duplicate text-start,
      // deltas emit text-delta, output_text.done is a no-op (matches accumulated),
      // content_part.done emits text-end, output_item.done is a no-op (already closed)
      expect(types).toEqual([
        "text-start",
        "text-delta", // "Test "
        "text-delta", // "output"
        "text-end",
        "finish",
      ]);

      const deltas = parts.filter((p) => p.type === "text-delta") as Array<{
        type: "text-delta";
        delta: string;
      }>;
      expect(deltas.map((d) => d.delta)).toEqual(["Test ", "output"]);
    });
  });
  describe("mixed text and tool calls", () => {
    it("handles interleaved text and tool call events", async () => {
      const msgId = "msg_mixed";
      const callId = "call_mixed";
      const stub = createStubModel([
        // Text message starts
        raw({
          type: "response.output_item.added",
          item: { id: msgId, type: "message" },
          output_index: 0,
        }),
        raw({
          type: "response.output_text.delta",
          item_id: msgId,
          content_index: 0,
          delta: "Let me ",
        }),
        raw({
          type: "response.output_text.delta",
          item_id: msgId,
          content_index: 0,
          delta: "check.",
        }),
        raw({
          type: "response.output_item.done",
          item: { id: msgId, type: "message" },
          output_index: 0,
        }),
        // Tool call
        raw({
          type: "response.output_item.added",
          item: { id: "fc_m", type: "function_call", call_id: callId, name: "file_read" },
          output_index: 1,
        }),
        raw({
          type: "response.function_call_arguments.delta",
          output_index: 1,
          delta: '{"path":"test.ts"}',
        }),
        raw({
          type: "response.output_item.done",
          item: {
            id: "fc_m",
            type: "function_call",
            call_id: callId,
            name: "file_read",
            arguments: '{"path":"test.ts"}',
          },
          output_index: 1,
        }),
        finish("tool-calls", 30, 15),
      ]);

      const wrapped = wrapCopilotResponsesModel(stub);
      const result = await wrapped.doStream(baseOptions);
      const parts = await collectStream(result.stream);

      const types = parts.map((p) => p.type);
      expect(types).toEqual([
        "text-start",
        "text-delta",
        "text-delta",
        "text-end",
        "tool-input-start",
        "tool-input-delta",
        "tool-input-end",
        "tool-call",
        "finish",
      ]);
    });
  });
});
