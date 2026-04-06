/**
 * Copilot-only Responses streaming adapter.
 *
 * GitHub Copilot's /v1/responses endpoint can emit Responses API events
 * in an order that differs from the standard OpenAI Responses API, causing
 * the upstream SDK's V3 stream part translation to produce broken lifecycles
 * (e.g., orphaned text-deltas, missing text-start/text-end pairs, or
 * tool-call parts arriving before tool-input-end).
 *
 * This module wraps a Responses-capable LanguageModelV3 and rebuilds
 * coherent V3 stream parts from raw SSE events. It only touches the
 * `doStream` path; `doGenerate` is delegated unchanged.
 *
 * The wrapper:
 *  - Forces `includeRawChunks: true` on the inner model
 *  - Suppresses the inner model's text/tool semantic parts (which may be broken)
 *  - Rebuilds text-start/text-delta/text-end and tool-input-start/delta/end/tool-call
 *    from raw Responses events keyed by item_id + content_index / output_index
 *  - Passes through everything else unchanged (finish, response-metadata,
 *    reasoning-*, source, raw, etc.)
 */

import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3StreamPart,
  LanguageModelV3StreamResult,
} from "@ai-sdk/provider";

// ---------------------------------------------------------------------------
// Raw Responses event type guards
// ---------------------------------------------------------------------------

interface RawResponsesEvent {
  type: string;
  [key: string]: unknown;
}

function isRawEvent(value: unknown): value is RawResponsesEvent {
  return (
    typeof value === "object" &&
    value != null &&
    typeof (value as RawResponsesEvent).type === "string"
  );
}

// response.output_item.added — item: { type: "message" | "function_call" | ... }
function isOutputItemAdded(ev: RawResponsesEvent): boolean {
  return ev.type === "response.output_item.added";
}

// response.output_item.done
function isOutputItemDone(ev: RawResponsesEvent): boolean {
  return ev.type === "response.output_item.done";
}

// response.output_text.delta
function isTextDelta(ev: RawResponsesEvent): boolean {
  return ev.type === "response.output_text.delta";
}

// response.function_call_arguments.delta
function isFunctionCallArgsDelta(ev: RawResponsesEvent): boolean {
  return ev.type === "response.function_call_arguments.delta";
}

// response.content_part.added
function isContentPartAdded(ev: RawResponsesEvent): boolean {
  return ev.type === "response.content_part.added";
}

// response.content_part.done
function isContentPartDone(ev: RawResponsesEvent): boolean {
  return ev.type === "response.content_part.done";
}

// response.output_text.done
function isTextDone(ev: RawResponsesEvent): boolean {
  return ev.type === "response.output_text.done";
}

// response.function_call_arguments.done
function isFunctionCallArgsDone(ev: RawResponsesEvent): boolean {
  return ev.type === "response.function_call_arguments.done";
}

// response.failed
function isResponseFailed(ev: RawResponsesEvent): boolean {
  return ev.type === "response.failed";
}

// ---------------------------------------------------------------------------
// Helpers to extract fields from raw events
// ---------------------------------------------------------------------------

function getItemId(ev: RawResponsesEvent): string | undefined {
  // Some events use `item_id`, output_item events nest under `item.id`
  if (typeof ev.item_id === "string") return ev.item_id;
  const item = ev.item as Record<string, unknown> | undefined;
  if (item && typeof item.id === "string") return item.id;
  return undefined;
}

function getItemType(ev: RawResponsesEvent): string | undefined {
  const item = ev.item as Record<string, unknown> | undefined;
  return item && typeof item.type === "string" ? item.type : undefined;
}

function getOutputIndex(ev: RawResponsesEvent): number {
  return typeof ev.output_index === "number" ? ev.output_index : 0;
}

function getContentIndex(ev: RawResponsesEvent): number {
  return typeof ev.content_index === "number" ? ev.content_index : 0;
}

function getDelta(ev: RawResponsesEvent): string {
  return typeof ev.delta === "string" ? ev.delta : "";
}

function getPartType(ev: RawResponsesEvent): string | undefined {
  const part = ev.part as Record<string, unknown> | undefined;
  return part && typeof part.type === "string" ? part.type : undefined;
}

function getPartText(ev: RawResponsesEvent): string | undefined {
  const part = ev.part as Record<string, unknown> | undefined;
  return part && typeof part.text === "string" ? part.text : undefined;
}

function getText(ev: RawResponsesEvent): string | undefined {
  return typeof ev.text === "string" ? ev.text : undefined;
}

function getArguments(ev: RawResponsesEvent): string | undefined {
  return typeof ev.arguments === "string" ? ev.arguments : undefined;
}

// ---------------------------------------------------------------------------
// Semantic part types suppressed from the inner stream
// ---------------------------------------------------------------------------

/** Parts the wrapper rebuilds from raw events — suppress the inner model's versions. */
const SUPPRESSED_INNER_TYPES = new Set<string>([
  "text-start",
  "text-delta",
  "text-end",
  "tool-input-start",
  "tool-input-delta",
  "tool-input-end",
  "tool-call",
]);

// ---------------------------------------------------------------------------
// Tracking state for open text / tool parts
// ---------------------------------------------------------------------------

interface OpenTextPart {
  /** Composite id emitted on text-start/delta/end (`${itemId}:${contentIndex}`). */
  externalId: string;
  started: boolean;
  /** Accumulated text from deltas, used for reconciliation in output_text.done. */
  accum: string;
}

interface OpenToolCall {
  itemId: string;
  callId: string;
  toolName: string;
  args: string;
  started: boolean;
  finalized: boolean;
}

// ---------------------------------------------------------------------------
// Stream transformer
// ---------------------------------------------------------------------------

function createCopilotResponsesTransform(
  outerWantsRaw: boolean
): TransformStream<LanguageModelV3StreamPart, LanguageModelV3StreamPart> {
  // Track open text parts by `${itemId}:${contentIndex}`
  const openTexts = new Map<string, OpenTextPart>();
  // Track open tool calls by output_index
  const openTools = new Map<number, OpenToolCall>();

  return new TransformStream<LanguageModelV3StreamPart, LanguageModelV3StreamPart>({
    transform(chunk, controller) {
      // Always forward raw chunks if the outer caller wanted them
      if (chunk.type === "raw") {
        if (outerWantsRaw) {
          controller.enqueue(chunk);
        }

        // Process the raw event to rebuild semantic parts
        const rawValue = chunk.rawValue;
        if (!isRawEvent(rawValue)) return;

        processRawEvent(rawValue, controller);
        return;
      }

      // Suppress the inner model's semantic text/tool parts — we rebuild from raw
      if (SUPPRESSED_INNER_TYPES.has(chunk.type)) {
        return;
      }

      // Pass through everything else: finish, response-metadata, reasoning-*, source, error, stream-start, etc.
      controller.enqueue(chunk);
    },

    flush(controller) {
      // Close any still-open text parts (defensive — should not happen in normal flow).
      for (const [, text] of openTexts) {
        if (text.started) {
          controller.enqueue({ type: "text-end", id: text.externalId });
        }
      }
      openTexts.clear();

      // Finalize any still-open tool calls
      for (const [, tool] of openTools) {
        if (!tool.finalized) {
          finalizeToolCall(tool, controller);
        }
      }
      openTools.clear();
    },
  });

  // -------------------------------------------
  // Raw event processing
  // -------------------------------------------

  function processRawEvent(
    ev: RawResponsesEvent,
    controller: TransformStreamDefaultController<LanguageModelV3StreamPart>
  ): void {
    if (isOutputItemAdded(ev)) {
      handleOutputItemAdded(ev, controller);
    } else if (isContentPartAdded(ev)) {
      handleContentPartAdded(ev, controller);
    } else if (isTextDelta(ev)) {
      handleTextDelta(ev, controller);
    } else if (isTextDone(ev)) {
      handleTextDone(ev, controller);
    } else if (isContentPartDone(ev)) {
      handleContentPartDone(ev, controller);
    } else if (isFunctionCallArgsDelta(ev)) {
      handleFunctionCallArgsDelta(ev, controller);
    } else if (isFunctionCallArgsDone(ev)) {
      handleFunctionCallArgsDone(ev, controller);
    } else if (isOutputItemDone(ev)) {
      handleOutputItemDone(ev, controller);
    } else if (isResponseFailed(ev)) {
      handleResponseFailed(ev, controller);
    }
    // response.created, response.completed, response.incomplete,
    // response.reasoning_summary_*, response.output_text.annotation.*,
    // etc. are either already handled by passthrough parts (finish,
    // response-metadata, reasoning-*, source) or don't need semantic translation.
  }

  function handleOutputItemAdded(
    ev: RawResponsesEvent,
    controller: TransformStreamDefaultController<LanguageModelV3StreamPart>
  ): void {
    const itemType = getItemType(ev);
    const itemId = getItemId(ev);
    if (!itemId) return;

    if (itemType === "message") {
      // A message item can have multiple content parts, but typically starts
      // with index 0. We emit text-start eagerly here — the SDK does the same.
      // Use composite key as the external id so each content part gets a
      // unique identity (prevents DevTools from overwriting accumulated text
      // when multiple content indices share the same itemId).
      const key = `${itemId}:${getContentIndex(ev)}`;
      openTexts.set(key, { externalId: key, started: true, accum: "" });
      controller.enqueue({ type: "text-start", id: key });
    } else if (itemType === "function_call") {
      const item = ev.item as Record<string, unknown>;
      const callId = typeof item.call_id === "string" ? item.call_id : itemId;
      const toolName = typeof item.name === "string" ? item.name : "unknown";
      const outputIndex = getOutputIndex(ev);

      openTools.set(outputIndex, {
        itemId,
        callId,
        toolName,
        args: "",
        started: true,
        finalized: false,
      });

      controller.enqueue({
        type: "tool-input-start",
        id: callId,
        toolName,
      });
    }
  }

  function handleTextDelta(
    ev: RawResponsesEvent,
    controller: TransformStreamDefaultController<LanguageModelV3StreamPart>
  ): void {
    const itemId = typeof ev.item_id === "string" ? ev.item_id : undefined;
    if (!itemId) return;

    const contentIndex = getContentIndex(ev);
    const key = `${itemId}:${contentIndex}`;

    // Ensure text-start was emitted (defensive against out-of-order events)
    if (!openTexts.has(key)) {
      openTexts.set(key, { externalId: key, started: true, accum: "" });
      controller.enqueue({ type: "text-start", id: key });
    }

    const delta = getDelta(ev);
    if (delta.length > 0) {
      const text = openTexts.get(key)!;
      text.accum += delta;
      controller.enqueue({ type: "text-delta", id: text.externalId, delta });
    }
  }

  /**
   * response.content_part.added — emitted when a new content part (e.g., output_text)
   * is added to a message item. Triggers text-start if not already started, plus an
   * optional initial text-delta if the part carries inline text.
   */
  function handleContentPartAdded(
    ev: RawResponsesEvent,
    controller: TransformStreamDefaultController<LanguageModelV3StreamPart>
  ): void {
    const itemId = typeof ev.item_id === "string" ? ev.item_id : undefined;
    if (!itemId) return;

    const partType = getPartType(ev);
    // Only handle output_text content parts
    if (partType !== "output_text") return;

    const contentIndex = getContentIndex(ev);
    const key = `${itemId}:${contentIndex}`;

    if (!openTexts.has(key)) {
      openTexts.set(key, { externalId: key, started: true, accum: "" });
      controller.enqueue({ type: "text-start", id: key });
    }

    // Some servers include initial text inline in the content_part.added event
    const initialText = getPartText(ev);
    if (initialText && initialText.length > 0) {
      const text = openTexts.get(key)!;
      text.accum += initialText;
      controller.enqueue({ type: "text-delta", id: text.externalId, delta: initialText });
    }
  }

  /**
   * response.output_text.done — emitted when the full text for a content part
   * is finalized. Reconciles any trailing text that was not delivered via deltas.
   */
  function handleTextDone(
    ev: RawResponsesEvent,
    controller: TransformStreamDefaultController<LanguageModelV3StreamPart>
  ): void {
    const itemId = typeof ev.item_id === "string" ? ev.item_id : undefined;
    if (!itemId) return;

    const contentIndex = getContentIndex(ev);
    const key = `${itemId}:${contentIndex}`;
    const finalText = getText(ev);

    const text = openTexts.get(key);
    if (text && finalText != null && finalText.length > text.accum.length) {
      // Emit any trailing text that the deltas missed
      const trailing = finalText.slice(text.accum.length);
      text.accum = finalText;
      controller.enqueue({ type: "text-delta", id: text.externalId, delta: trailing });
    }
  }

  /**
   * response.content_part.done — emitted when a content part is fully done.
   * Closes the text part with text-end.
   */
  function handleContentPartDone(
    ev: RawResponsesEvent,
    controller: TransformStreamDefaultController<LanguageModelV3StreamPart>
  ): void {
    const itemId = typeof ev.item_id === "string" ? ev.item_id : undefined;
    if (!itemId) return;

    const contentIndex = getContentIndex(ev);
    const key = `${itemId}:${contentIndex}`;

    const text = openTexts.get(key);
    if (text?.started) {
      controller.enqueue({ type: "text-end", id: text.externalId });
      openTexts.delete(key);
    }
  }

  function handleFunctionCallArgsDelta(
    ev: RawResponsesEvent,
    controller: TransformStreamDefaultController<LanguageModelV3StreamPart>
  ): void {
    const outputIndex = getOutputIndex(ev);
    const tool = openTools.get(outputIndex);
    if (!tool) return;

    const delta = getDelta(ev);
    tool.args += delta;

    if (delta.length > 0) {
      controller.enqueue({ type: "tool-input-delta", id: tool.callId, delta });
    }
  }

  /**
   * response.function_call_arguments.done — emitted when the final arguments
   * for a function call are available. Reconciles accumulated args and finalizes
   * the tool call (tool-input-end + tool-call), so output_item.done becomes
   * a no-op fallback for this tool.
   */
  function handleFunctionCallArgsDone(
    ev: RawResponsesEvent,
    controller: TransformStreamDefaultController<LanguageModelV3StreamPart>
  ): void {
    const outputIndex = getOutputIndex(ev);
    const tool = openTools.get(outputIndex);
    if (!tool || tool.finalized) return;

    // Reconcile final arguments from the done event
    const finalArgs = getArguments(ev);
    if (finalArgs != null) {
      tool.args = finalArgs;
    }

    finalizeToolCall(tool, controller);
    openTools.delete(outputIndex);
  }

  /**
   * response.output_item.done — fallback finalization.
   * For message items: closes any still-open text parts that content_part.done did not
   * already close (e.g., when the server omits content_part events).
   * For function_call items: finalizes only if function_call_arguments.done was not
   * received (the tool will already be deleted from openTools if args-done ran).
   */
  function handleOutputItemDone(
    ev: RawResponsesEvent,
    controller: TransformStreamDefaultController<LanguageModelV3StreamPart>
  ): void {
    const itemType = getItemType(ev);
    const itemId = getItemId(ev);
    if (!itemId) return;

    if (itemType === "message") {
      // Fallback: close any text parts that content_part.done did not already close
      for (const [key, text] of openTexts) {
        if (text.externalId.startsWith(`${itemId}:`) && text.started) {
          controller.enqueue({ type: "text-end", id: text.externalId });
          openTexts.delete(key);
        }
      }
    } else if (itemType === "function_call") {
      // Fallback: finalize only if function_call_arguments.done did not already do so
      const outputIndex = getOutputIndex(ev);
      const tool = openTools.get(outputIndex);
      if (tool && !tool.finalized) {
        // output_item.done for function_call contains the final arguments
        const item = ev.item as Record<string, unknown>;
        if (typeof item.arguments === "string") {
          tool.args = item.arguments;
        }
        finalizeToolCall(tool, controller);
        openTools.delete(outputIndex);
      }
    }
  }

  function finalizeToolCall(
    tool: OpenToolCall,
    controller: TransformStreamDefaultController<LanguageModelV3StreamPart>
  ): void {
    if (tool.finalized) return;
    tool.finalized = true;

    controller.enqueue({ type: "tool-input-end", id: tool.callId });
    controller.enqueue({
      type: "tool-call",
      toolCallId: tool.callId,
      toolName: tool.toolName,
      input: tool.args,
    });
  }

  function handleResponseFailed(
    ev: RawResponsesEvent,
    controller: TransformStreamDefaultController<LanguageModelV3StreamPart>
  ): void {
    const response = ev.response as Record<string, unknown> | undefined;
    const error = response?.error ?? ev.error ?? "Copilot Responses request failed";
    controller.enqueue({ type: "error", error });
  }
}

// ---------------------------------------------------------------------------
// Public wrapper
// ---------------------------------------------------------------------------

/**
 * Wrap a Responses-capable LanguageModelV3 for use with GitHub Copilot.
 *
 * The wrapper rebuilds coherent V3 text/tool stream parts from raw Responses
 * events, compensating for ordering differences in Copilot's /v1/responses.
 *
 * - `doGenerate` is delegated unchanged.
 * - `doStream` forces `includeRawChunks: true`, suppresses the inner model's
 *   text/tool semantic parts, and rebuilds them from the raw events.
 */
export function wrapCopilotResponsesModel(inner: LanguageModelV3): LanguageModelV3 {
  return {
    specificationVersion: inner.specificationVersion,
    provider: inner.provider,
    modelId: inner.modelId,
    supportedUrls: inner.supportedUrls,

    doGenerate: (options: LanguageModelV3CallOptions) => inner.doGenerate(options),

    async doStream(options: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
      const outerWantsRaw = options.includeRawChunks === true;

      // Force raw chunks so we can rebuild semantics from SSE events
      const innerOptions: LanguageModelV3CallOptions = {
        ...options,
        includeRawChunks: true,
      };

      const result = await inner.doStream(innerOptions);

      return {
        ...result,
        stream: result.stream.pipeThrough(createCopilotResponsesTransform(outerWantsRaw)),
      };
    },
  };
}
