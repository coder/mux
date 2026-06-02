import type { LanguageModel } from "ai";

/**
 * The object form of {@link LanguageModel} (excluding the bare model-ID string
 * shape). Only the object form exposes `doStream`, which is what the filter
 * mutates.
 */
type LanguageModelInstance = Exclude<LanguageModel, string>;

/**
 * Filters the `@ai-sdk/openai` adapters' synthesized-default `finish` part out of
 * the LanguageModelV2 stream so {@link StreamManager}'s missing-terminal-event guard
 * (introduced in PR #3415) surfaces a clean upstream EOF as a retryable
 * `stream_truncated` error instead of committing partial output as a normal
 * assistant message.
 *
 * Background: every `@ai-sdk/openai` streaming adapter (Responses, Chat
 * Completions, legacy Completions) initializes its internal finish reason to
 * `{ unified: "other", raw: undefined }` and unconditionally emits that value
 * from its `TransformStream.flush()` at end-of-stream — even when the SSE
 * upstream closed before any terminal event arrived
 * (`response.completed` / `response.incomplete` / `response.failed`, or a
 * Chat Completions delta carrying `finish_reason`). That synthesized finish
 * silently bypasses Mux's missing-terminal-event guard, committing partial
 * output to history as if the model stopped cleanly.
 *
 * Discriminator: in this adapter family, the SDK's
 * `mapOpenAIResponseFinishReason` and `mapOpenAIFinishReason` only return
 * `unified: "other"` paired with a defined `raw` (the original unmapped API
 * value). Among finish parts that these adapters legitimately emit, the
 * `{ unified: "other", raw: undefined }` shape is unreachable except as the
 * uninitialized default. Dropping it is safe — and intentionally narrow to
 * the OpenAI adapter family. We do **not** extend this heuristic to other
 * providers: the public AI SDK contract permits any adapter to emit `(other,
 * undefined)` as a real terminal finish, so the filter must stay scoped to
 * the boundary where we know the synthesized default originates.
 *
 * Implementation: wrap the model's `doStream` so its output stream is piped
 * through a `TransformStream` that drops only the synthesized-default finish
 * part. Other parts (text deltas, tool calls, real finishes, errors, etc.)
 * pass through unchanged. When the synthesized default is dropped, the
 * downstream consumer (`streamText`, then `StreamManager`) sees a stream that
 * ended without a finish part, and the existing
 * `!receivedTerminalEvent` branch handles it as `stream_truncated`.
 */
export function wrapOpenAIModelToFilterSynthesizedFinish<M extends LanguageModelInstance>(
  model: M
): M {
  const originalDoStream = model.doStream.bind(model);
  // The wrapper is element-shape preserving (a pure filter), but the runtime
  // shape spans the union of LanguageModelV*StreamPart types — TypeScript can't
  // see that the same filter satisfies every member of the union, so we erase
  // the element type for the pipe and restore it on the way out. The function
  // signature still ties input and output element types together for callers.
  type AnyDoStream = (options: unknown) => Promise<{ stream: ReadableStream<unknown> }>;
  const wrappedDoStream: AnyDoStream = async (options) => {
    const result = await (originalDoStream as AnyDoStream)(options);
    return {
      ...result,
      stream: result.stream.pipeThrough(createOpenAISynthesizedFinishFilter<unknown>()),
    };
  };
  model.doStream = wrappedDoStream as unknown as M["doStream"];
  return model;
}

/**
 * The TransformStream used by {@link wrapOpenAIModelToFilterSynthesizedFinish}.
 * Exported separately so unit tests can exercise the filter directly without
 * constructing a full LanguageModel mock.
 *
 * Generic over the element type so `ReadableStream<T>.pipeThrough(...)` stays
 * `ReadableStream<T>` for the caller. The runtime check is shape-based and
 * does not rely on `T`.
 */
export function createOpenAISynthesizedFinishFilter<T>(): TransformStream<T, T> {
  return new TransformStream<T, T>({
    transform(part, controller) {
      if (isOpenAISynthesizedDefaultFinishPart(part)) {
        return;
      }
      controller.enqueue(part);
    },
  });
}

/**
 * True iff `part` is the `@ai-sdk/openai` synthesized-default finish — the
 * uninitialized `{ unified: "other", raw: undefined }` value that the adapter
 * emits when no terminal SSE event arrived before EOF.
 *
 * The OpenAI adapters emit finish parts whose `finishReason` is the internal
 * `{ unified, raw }` object (see `@ai-sdk/openai`'s flush handlers); the AI
 * SDK's `streamText` later splits that into `finishReason` / `rawFinishReason`
 * fields. We're operating at the adapter→`streamText` boundary, so we match
 * against the `{ unified, raw }` shape.
 */
export function isOpenAISynthesizedDefaultFinishPart(part: unknown): boolean {
  if (typeof part !== "object" || part === null) {
    return false;
  }
  const { type, finishReason } = part as { type?: unknown; finishReason?: unknown };
  if (type !== "finish") {
    return false;
  }
  if (typeof finishReason !== "object" || finishReason === null) {
    return false;
  }
  const reason = finishReason as { unified?: unknown; raw?: unknown };
  return reason.unified === "other" && reason.raw === undefined;
}
