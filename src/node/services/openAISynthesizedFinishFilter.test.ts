import { describe, test, expect } from "bun:test";

import {
  createOpenAISynthesizedFinishFilter,
  isOpenAISynthesizedDefaultFinishPart,
  wrapOpenAIModelToFilterSynthesizedFinish,
} from "./openAISynthesizedFinishFilter";
// The wrapper is typed against the LanguageModel union (V2|V3) from "ai", but
// the V2/V3 stream-part and tool-result variants drift just enough to make
// constructing a fully-typed in-test fake unworkable. Tests run against a
// minimal structural shape that matches the wrapper's runtime surface, then
// cast at the boundary.
interface LanguageModelLike {
  specificationVersion: string;
  provider: string;
  modelId: string;
  supportedUrls: Record<string, unknown>;
  doGenerate: (...args: unknown[]) => Promise<unknown>;
  doStream: (options: unknown) => Promise<{
    stream: ReadableStream<unknown>;
    request?: unknown;
    response?: unknown;
  }>;
}

function streamOf<T>(items: T[]): ReadableStream<T> {
  return new ReadableStream<T>({
    start(controller) {
      for (const item of items) {
        controller.enqueue(item);
      }
      controller.close();
    },
  });
}

async function collect<T>(stream: ReadableStream<T>): Promise<T[]> {
  const out: T[] = [];
  const reader = stream.getReader();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    out.push(value);
  }
  return out;
}

describe("isOpenAISynthesizedDefaultFinishPart", () => {
  test("matches the OpenAI adapter's uninitialized default", () => {
    const part = { type: "finish", finishReason: { unified: "other", raw: undefined } };
    expect(isOpenAISynthesizedDefaultFinishPart(part)).toBe(true);
  });

  test("rejects 'other' finishes that carry an unmapped raw reason", () => {
    // The legitimate-but-unmapped "other" case (e.g. a future
    // incomplete_details.reason the SDK does not know about) — these must
    // continue to count as terminal events.
    const part = {
      type: "finish",
      finishReason: { unified: "other", raw: "safety_violation" },
    };
    expect(isOpenAISynthesizedDefaultFinishPart(part)).toBe(false);
  });

  test("rejects normal stop finishes", () => {
    const part = { type: "finish", finishReason: { unified: "stop", raw: "stop" } };
    expect(isOpenAISynthesizedDefaultFinishPart(part)).toBe(false);
  });

  test("rejects length and content-filter finishes", () => {
    expect(
      isOpenAISynthesizedDefaultFinishPart({
        type: "finish",
        finishReason: { unified: "length", raw: "max_output_tokens" },
      })
    ).toBe(false);
    expect(
      isOpenAISynthesizedDefaultFinishPart({
        type: "finish",
        finishReason: { unified: "content-filter", raw: "content_filter" },
      })
    ).toBe(false);
  });

  test("rejects error finishes synthesized by the adapter", () => {
    // When the adapter's transform observes a chunk-level error it sets
    // finishReason to { unified: "error", raw: undefined }. We must not drop
    // that — it's a real terminal signal.
    expect(
      isOpenAISynthesizedDefaultFinishPart({
        type: "finish",
        finishReason: { unified: "error", raw: undefined },
      })
    ).toBe(false);
  });

  test("rejects non-finish parts even if shaped suspiciously", () => {
    expect(
      isOpenAISynthesizedDefaultFinishPart({
        type: "text-delta",
        finishReason: { unified: "other", raw: undefined },
      })
    ).toBe(false);
    expect(isOpenAISynthesizedDefaultFinishPart(null)).toBe(false);
    expect(isOpenAISynthesizedDefaultFinishPart(undefined)).toBe(false);
    expect(isOpenAISynthesizedDefaultFinishPart("finish")).toBe(false);
  });

  test("rejects finish parts shaped as a unified string (post-streamText conversion)", () => {
    // Defensive: if this filter is ever fed a stream that has already been
    // normalized through streamText, the finishReason will be the string
    // "other" rather than { unified: "other", raw: undefined }. We must not
    // accidentally drop legitimate finishes at that boundary.
    expect(isOpenAISynthesizedDefaultFinishPart({ type: "finish", finishReason: "other" })).toBe(
      false
    );
  });
});

describe("createOpenAISynthesizedFinishFilter", () => {
  test("drops only the synthesized default finish part", async () => {
    const input = [
      { type: "stream-start", warnings: [] },
      { type: "text-delta", id: "0", delta: "partial answer" },
      { type: "finish", finishReason: { unified: "other", raw: undefined } },
    ];

    const out = await collect(streamOf(input).pipeThrough(createOpenAISynthesizedFinishFilter()));

    expect(out).toEqual([
      { type: "stream-start", warnings: [] },
      { type: "text-delta", id: "0", delta: "partial answer" },
    ]);
  });

  test("passes through real finish parts", async () => {
    const input = [
      { type: "text-delta", id: "0", delta: "done" },
      { type: "finish", finishReason: { unified: "stop", raw: "stop" } },
    ];

    const out = await collect(streamOf(input).pipeThrough(createOpenAISynthesizedFinishFilter()));

    expect(out).toEqual(input);
  });

  test("passes through legitimate unmapped 'other' finishes (raw reason present)", async () => {
    const input = [
      { type: "text-delta", id: "0", delta: "done" },
      { type: "finish", finishReason: { unified: "other", raw: "safety_violation" } },
    ];

    const out = await collect(streamOf(input).pipeThrough(createOpenAISynthesizedFinishFilter()));

    expect(out).toEqual(input);
  });
});

describe("wrapOpenAIModelToFilterSynthesizedFinish", () => {
  test("filters the model's doStream output without touching anything else", async () => {
    const captured: unknown[] = [];
    const fakeModel: LanguageModelLike = {
      specificationVersion: "v3",
      provider: "openai",
      modelId: "gpt-fake",
      supportedUrls: {},
      doGenerate: () => Promise.reject(new Error("unused")),
      doStream: (options) => {
        captured.push(options);
        return Promise.resolve({
          stream: streamOf<unknown>([
            { type: "stream-start", warnings: [] },
            { type: "text-delta", id: "0", delta: "partial" },
            { type: "finish", finishReason: { unified: "other", raw: undefined } },
          ]),
          request: {},
          response: { headers: {} },
        });
      },
    };

    const wrapped = wrapOpenAIModelToFilterSynthesizedFinish(
      fakeModel as unknown as Parameters<typeof wrapOpenAIModelToFilterSynthesizedFinish>[0]
    ) as unknown as LanguageModelLike;
    expect(wrapped).toBe(fakeModel);

    const result = await wrapped.doStream({ marker: 1 });
    expect(captured).toEqual([{ marker: 1 }]);

    const parts = await collect(result.stream);
    expect(parts).toEqual([
      { type: "stream-start", warnings: [] },
      { type: "text-delta", id: "0", delta: "partial" },
    ]);
  });

  test("preserves real finish parts emitted by the model", async () => {
    const fakeModel: LanguageModelLike = {
      specificationVersion: "v3",
      provider: "openai",
      modelId: "gpt-fake",
      supportedUrls: {},
      doGenerate: () => Promise.reject(new Error("unused")),
      doStream: () =>
        Promise.resolve({
          stream: streamOf<unknown>([
            { type: "text-delta", id: "0", delta: "complete" },
            { type: "finish", finishReason: { unified: "stop", raw: "stop" } },
          ]),
          request: {},
          response: { headers: {} },
        }),
    };

    const wrapped = wrapOpenAIModelToFilterSynthesizedFinish(
      fakeModel as unknown as Parameters<typeof wrapOpenAIModelToFilterSynthesizedFinish>[0]
    ) as unknown as LanguageModelLike;
    const result = await wrapped.doStream({});
    const parts = await collect(result.stream);
    expect(parts).toEqual([
      { type: "text-delta", id: "0", delta: "complete" },
      { type: "finish", finishReason: { unified: "stop", raw: "stop" } },
    ]);
  });
});
