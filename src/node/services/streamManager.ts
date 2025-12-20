import { EventEmitter } from "events";
import * as path from "path";
import { PlatformPaths } from "@/common/utils/paths";
import {
  streamText,
  stepCountIs,
  type ModelMessage,
  type LanguageModel,
  type Tool,
  LoadAPIKeyError,
  APICallError,
  RetryError,
} from "ai";
import type { LanguageModelV2Usage } from "@ai-sdk/provider";
import type { Result } from "@/common/types/result";
import { Ok, Err } from "@/common/types/result";
import { log } from "./log";
import type {
  StreamStartEvent,
  StreamEndEvent,
  UsageDeltaEvent,
  ErrorEvent,
  ToolCallEndEvent,
  CompletedMessagePart,
} from "@/common/types/stream";

import type { SendMessageError, StreamErrorType } from "@/common/types/errors";
import type { MuxMetadata, MuxMessage } from "@/common/types/message";
import type { PartialService } from "./partialService";
import type { HistoryService } from "./historyService";
import { addUsage, accumulateProviderMetadata } from "@/common/utils/tokens/usageHelpers";
import { AsyncMutex } from "@/node/utils/concurrency/asyncMutex";
import type { ToolPolicy } from "@/common/utils/tools/toolPolicy";
import { StreamingTokenTracker } from "@/node/utils/main/StreamingTokenTracker";
import type { Runtime } from "@/node/runtime/Runtime";
import { execBuffered } from "@/node/utils/runtime/helpers";
import {
  createCachedSystemMessage,
  applyCacheControlToTools,
} from "@/common/utils/ai/cacheStrategy";
import type { SessionUsageService } from "./sessionUsageService";
import { createDisplayUsage } from "@/common/utils/tokens/displayUsage";
import { normalizeGatewayModel } from "@/common/utils/ai/models";

// Disable AI SDK warning logging (e.g., "setting `toolChoice` to `none` is not supported")
globalThis.AI_SDK_LOG_WARNINGS = false;

// Type definitions for stream parts with extended properties
interface ReasoningDeltaPart {
  type: "reasoning-delta";
  text?: string;
}

// Branded types for compile-time safety
type WorkspaceId = string & { __brand: "WorkspaceId" };
type StreamToken = string & { __brand: "StreamToken" };

// Stream state enum for exhaustive checking
enum StreamState {
  IDLE = "idle",
  STARTING = "starting",
  STREAMING = "streaming",
  STOPPING = "stopping",
  COMPLETED = "completed", // Stream finished successfully (before cleanup)
  ERROR = "error",
}

/**
 * Strip encryptedContent from web search results to reduce token usage.
 * The encrypted page content can be massive (4000+ chars per result) and isn't
 * needed for model context. Keep URL, title, and pageAge for reference.
 */
function stripEncryptedContent(output: unknown): unknown {
  // Check if output is JSON with a value array (web search results)
  if (
    typeof output === "object" &&
    output !== null &&
    "type" in output &&
    output.type === "json" &&
    "value" in output &&
    Array.isArray(output.value)
  ) {
    // Strip encryptedContent from each search result
    const strippedValue = output.value.map((item: unknown) => {
      if (item && typeof item === "object" && "encryptedContent" in item) {
        // Remove encryptedContent but keep other fields
        const { encryptedContent, ...rest } = item as Record<string, unknown>;
        return rest;
      }
      return item;
    });

    return {
      ...output,
      value: strippedValue,
    };
  }

  return output;
}

// Comprehensive stream info
interface WorkspaceStreamInfo {
  state: StreamState;
  streamResult: Awaited<ReturnType<typeof streamText>>;
  abortController: AbortController;
  messageId: string;
  token: StreamToken;
  startTime: number;
  model: string;
  initialMetadata?: Partial<MuxMetadata>;
  historySequence: number;
  // Track accumulated parts for partial message (includes reasoning, text, and tools)
  parts: CompletedMessagePart[];
  // Track last partial write time for throttling
  lastPartialWriteTime: number;
  // Throttle timer for partial writes
  partialWriteTimer?: ReturnType<typeof setTimeout>;
  // Track in-flight write to serialize writes
  partialWritePromise?: Promise<void>;
  // Track background processing promise for guaranteed cleanup
  processingPromise: Promise<void>;
  // Soft-interrupt state: when pending, stream will end at next block boundary
  softInterrupt: { pending: false } | { pending: true; abandonPartial: boolean };
  // Temporary directory for tool outputs (auto-cleaned when stream ends)
  runtimeTempDir: string;
  // Runtime for temp directory cleanup
  runtime: Runtime;
  // Cumulative usage across all steps (for live cost display during streaming)
  cumulativeUsage: LanguageModelV2Usage;
  // Cumulative provider metadata across all steps (for live cost display with cache tokens)
  cumulativeProviderMetadata?: Record<string, unknown>;
  // Last step's usage (for context window display during streaming)
  lastStepUsage?: LanguageModelV2Usage;
  // Last step's provider metadata (for context window cache display)
  lastStepProviderMetadata?: Record<string, unknown>;
}

/**
 * StreamManager - Handles all streaming operations with type safety and atomic operations
 *
 * Key invariants:
 * - Only one active stream per workspace at any time
 * - Atomic stream creation/cancellation operations
 * - Guaranteed resource cleanup in all code paths
 */
export class StreamManager extends EventEmitter {
  private workspaceStreams = new Map<WorkspaceId, WorkspaceStreamInfo>();
  private streamLocks = new Map<WorkspaceId, AsyncMutex>();
  private readonly PARTIAL_WRITE_THROTTLE_MS = 500;
  private readonly historyService: HistoryService;
  private readonly partialService: PartialService;
  private readonly sessionUsageService?: SessionUsageService;
  // Token tracker for live streaming statistics
  private tokenTracker = new StreamingTokenTracker();
  // Track OpenAI previousResponseIds that have been invalidated
  // When frontend retries, buildProviderOptions will omit these IDs
  private lostResponseIds = new Set<string>();

  constructor(
    historyService: HistoryService,
    partialService: PartialService,
    sessionUsageService?: SessionUsageService
  ) {
    super();
    this.historyService = historyService;
    this.partialService = partialService;
    this.sessionUsageService = sessionUsageService;
  }

  /**
   * Write the current partial message to disk (throttled by mtime)
   * Ensures writes happen during rapid streaming (crash-resilient)
   */
  private async schedulePartialWrite(
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo
  ): Promise<void> {
    const now = Date.now();
    const timeSinceLastWrite = now - streamInfo.lastPartialWriteTime;

    // If enough time has passed, write immediately
    if (timeSinceLastWrite >= this.PARTIAL_WRITE_THROTTLE_MS) {
      await this.flushPartialWrite(workspaceId, streamInfo);
      return;
    }

    // Otherwise, schedule write for remaining time (fire-and-forget for scheduled writes)
    if (streamInfo.partialWriteTimer) {
      clearTimeout(streamInfo.partialWriteTimer);
    }

    const remainingTime = this.PARTIAL_WRITE_THROTTLE_MS - timeSinceLastWrite;
    streamInfo.partialWriteTimer = setTimeout(() => {
      void this.flushPartialWrite(workspaceId, streamInfo);
    }, remainingTime);
  }

  /**
   * Flush any pending partial write and write immediately
   * Serializes writes to prevent races - waits for any in-flight write before starting new one
   */
  private async flushPartialWrite(
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo
  ): Promise<void> {
    // Wait for any in-flight write to complete first (serialization)
    if (streamInfo.partialWritePromise) {
      await streamInfo.partialWritePromise;
    }

    // Clear throttle timer
    if (streamInfo.partialWriteTimer) {
      clearTimeout(streamInfo.partialWriteTimer);
      streamInfo.partialWriteTimer = undefined;
    }

    // Start new write and track the promise
    streamInfo.partialWritePromise = (async () => {
      try {
        const partialMessage: MuxMessage = {
          id: streamInfo.messageId,
          role: "assistant",
          metadata: {
            historySequence: streamInfo.historySequence,
            timestamp: streamInfo.startTime,
            model: streamInfo.model,
            partial: true, // Always true - this method only writes partial messages
            ...streamInfo.initialMetadata,
          },
          parts: streamInfo.parts, // Parts array includes reasoning, text, and tools
        };

        await this.partialService.writePartial(workspaceId as string, partialMessage);
        streamInfo.lastPartialWriteTime = Date.now();
      } catch (error) {
        log.error("Failed to write partial message:", error);
      } finally {
        // Clear promise when write completes
        streamInfo.partialWritePromise = undefined;
      }
    })();

    // Wait for this write to complete
    await streamInfo.partialWritePromise;
  }

  /**
   * Atomically ensures stream safety by cancelling any existing stream
   * @param workspaceId The workspace to ensure stream safety for
   * @returns A unique stream token for the new stream
   */
  private async ensureStreamSafety(workspaceId: WorkspaceId): Promise<StreamToken> {
    const existing = this.workspaceStreams.get(workspaceId);

    if (existing && existing.state !== StreamState.IDLE) {
      await this.cancelStreamSafely(workspaceId, existing, undefined);
    }

    // Generate unique token for this stream (8 hex chars for context efficiency)
    return Math.random().toString(16).substring(2, 10) as StreamToken;
  }

  /**
   * Generate a unique stream token (8 hex characters)
   * Used by callers that need to prepare resources (like tools) before starting the stream
   * Uses 8 hex chars instead of UUID for context efficiency (shorter paths in agent output)
   */
  public generateStreamToken(): StreamToken {
    return Math.random().toString(16).substring(2, 10) as StreamToken;
  }

  /**
   * Create a temporary directory for a stream token
   * Use ~/.mux-tmp instead of system temp directory (e.g., /var/folders/...)
   * because macOS user-scoped temp paths are extremely long, which leads to:
   * - Agent mistakes when copying/manipulating paths
   * - Harder to read in tool outputs
   * - Potential path length issues on some systems
   *
   * Uses the Runtime abstraction so temp directories work for both local and SSH runtimes.
   */
  public async createTempDirForStream(streamToken: StreamToken, runtime: Runtime): Promise<string> {
    // Create directory and get absolute path (works for both local and remote)
    // Use 'cd' + 'pwd' to resolve ~ to absolute path
    const command = `mkdir -p ~/.mux-tmp/${streamToken} && cd ~/.mux-tmp/${streamToken} && pwd`;
    const result = await execBuffered(runtime, command, {
      cwd: "/",
      timeout: 10,
    });

    if (result.exitCode !== 0) {
      throw new Error(
        `Failed to create temp directory ~/.mux-tmp/${streamToken}: exit code ${result.exitCode}`
      );
    }

    // Return absolute path (e.g., "/home/user/.mux-tmp/abc123")
    return result.stdout.trim();
  }

  /**
   * Extracts usage and duration metadata from stream result.
   *
   * Usage is only available after stream completes naturally.
   * On abort, the usage promise may hang - we use a timeout to return quickly.
   */
  private async emitToolCallDeltaIfPresent(
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo,
    part: unknown
  ): Promise<boolean> {
    const maybeDelta = part as { type?: string } | undefined;
    if (maybeDelta?.type !== "tool-call-delta") {
      return false;
    }

    const toolDelta = part as {
      toolCallId: string;
      toolName: string;
      argsTextDelta: string;
    };

    const deltaText = String(toolDelta.argsTextDelta ?? "");
    if (deltaText.length === 0) {
      return true;
    }

    const tokens = await this.tokenTracker.countTokens(deltaText);
    const timestamp = Date.now();

    this.emit("tool-call-delta", {
      type: "tool-call-delta",
      workspaceId: workspaceId as string,
      messageId: streamInfo.messageId,
      toolCallId: toolDelta.toolCallId,
      toolName: toolDelta.toolName,
      delta: toolDelta.argsTextDelta,
      tokens,
      timestamp,
    });

    return true;
  }

  private async getStreamMetadata(
    streamInfo: WorkspaceStreamInfo,
    timeoutMs = 1000
  ): Promise<{
    totalUsage?: LanguageModelV2Usage;
    contextUsage?: LanguageModelV2Usage;
    contextProviderMetadata?: Record<string, unknown>;
    duration: number;
  }> {
    // Helper: wrap promise with independent timeout + error handling
    // Each promise resolves independently - one failure doesn't mask others
    const withTimeout = <T>(promise: Promise<T>): Promise<T | undefined> =>
      Promise.race([
        promise,
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), timeoutMs)),
      ]).catch(() => undefined);

    // Fetch all metadata in parallel with independent timeouts
    // - totalUsage: sum of all steps (for cost calculation)
    // - contextUsage: last step only (for context window display)
    // - contextProviderMetadata: last step (for context window cache display)
    const [totalUsage, contextUsage, contextProviderMetadata] = await Promise.all([
      withTimeout(streamInfo.streamResult.totalUsage),
      withTimeout(streamInfo.streamResult.usage),
      withTimeout(streamInfo.streamResult.providerMetadata),
    ]);

    return {
      totalUsage,
      contextUsage,
      contextProviderMetadata,
      duration: Date.now() - streamInfo.startTime,
    };
  }

  /**
   * Aggregate provider metadata across all steps.
   *
   * CRITICAL: For multi-step tool calls, cache creation tokens are reported per-step.
   * streamResult.providerMetadata only contains the LAST step's metadata, missing
   * cache creation tokens from earlier steps. We must sum across all steps.
   */
  private async getAggregatedProviderMetadata(
    streamInfo: WorkspaceStreamInfo,
    timeoutMs = 1000
  ): Promise<Record<string, unknown> | undefined> {
    try {
      const steps = await Promise.race([
        streamInfo.streamResult.steps,
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), timeoutMs)),
      ]);

      if (!steps || steps.length === 0) {
        // Fall back to last step's provider metadata
        return await streamInfo.streamResult.providerMetadata;
      }

      // If only one step, no aggregation needed
      if (steps.length === 1) {
        return steps[0].providerMetadata;
      }

      // Aggregate cache creation tokens across all steps
      let totalCacheCreationTokens = 0;
      let lastStepMetadata: Record<string, unknown> | undefined;

      for (const step of steps) {
        lastStepMetadata = step.providerMetadata;
        const anthropicMeta = step.providerMetadata?.anthropic as
          | { cacheCreationInputTokens?: number }
          | undefined;
        if (anthropicMeta?.cacheCreationInputTokens) {
          totalCacheCreationTokens += anthropicMeta.cacheCreationInputTokens;
        }
      }

      // If no cache creation tokens found, just return last step's metadata
      if (totalCacheCreationTokens === 0) {
        return lastStepMetadata;
      }

      // Merge aggregated cache creation tokens into the last step's metadata
      return {
        ...lastStepMetadata,
        anthropic: {
          ...(lastStepMetadata?.anthropic as Record<string, unknown> | undefined),
          cacheCreationInputTokens: totalCacheCreationTokens,
        },
      };
    } catch (error) {
      log.debug("Could not aggregate provider metadata:", error);
      return undefined;
    }
  }

  /**
   * Safely cancels an existing stream with proper cleanup
   *
   * CRITICAL: Waits for the processing promise to complete before cleanup.
   * This ensures the old stream fully exits before a new stream can start,
   * preventing concurrent streams and race conditions.
   */
  /**
   * Convert a part to an event and emit it.
   * Shared between live streaming and replay to ensure consistent event emission.
   * This guarantees replay reconstructs the exact stream using the same tokenization logic.
   *
   * @param workspaceId - Workspace identifier
   * @param messageId - Message identifier
   * @param part - The part to emit (text, reasoning, or tool)
   */
  private async emitPartAsEvent(
    workspaceId: WorkspaceId,
    messageId: string,
    part: CompletedMessagePart
  ): Promise<void> {
    const timestamp = part.timestamp ?? Date.now();

    if (part.type === "text") {
      const tokens = await this.tokenTracker.countTokens(part.text);
      this.emit("stream-delta", {
        type: "stream-delta",
        workspaceId: workspaceId as string,
        messageId,
        delta: part.text,
        tokens,
        timestamp,
      });
    } else if (part.type === "reasoning") {
      const tokens = await this.tokenTracker.countTokens(part.text);
      this.emit("reasoning-delta", {
        type: "reasoning-delta",
        workspaceId: workspaceId as string,
        messageId,
        delta: part.text,
        tokens,
        timestamp,
      });
    } else if (part.type === "dynamic-tool") {
      const inputText = JSON.stringify(part.input);
      const tokens = await this.tokenTracker.countTokens(inputText);
      this.emit("tool-call-start", {
        type: "tool-call-start",
        workspaceId: workspaceId as string,
        messageId,
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        args: part.input,
        tokens,
        timestamp,
      });

      // If tool has output, emit completion
      if (part.state === "output-available") {
        this.emit("tool-call-end", {
          type: "tool-call-end",
          workspaceId: workspaceId as string,
          messageId,
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          result: part.output,
          timestamp: Date.now(),
        });
      }
    }
  }

  private async cancelStreamSafely(
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo,
    abandonPartial?: boolean
  ): Promise<void> {
    try {
      streamInfo.state = StreamState.STOPPING;
      // Flush any pending partial write immediately (preserves work on interruption)
      await this.flushPartialWrite(workspaceId, streamInfo);

      streamInfo.abortController.abort();

      // Unlike checkSoftCancelStream, await cleanup (blocking)
      await this.cleanupStream(workspaceId, streamInfo, abandonPartial);
    } catch (error) {
      log.error("Error during stream cancellation:", error);
      // Force cleanup even if cancellation fails
      this.workspaceStreams.delete(workspaceId);
    }
  }

  // Checks if a soft interrupt is necessary, and performs one if so
  // Similar to cancelStreamSafely but performs cleanup without blocking
  private async checkSoftCancelStream(
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo
  ): Promise<void> {
    if (!streamInfo.softInterrupt.pending) return;
    try {
      streamInfo.state = StreamState.STOPPING;

      // Flush any pending partial write immediately (preserves work on interruption)
      await this.flushPartialWrite(workspaceId, streamInfo);

      streamInfo.abortController.abort();

      // Return back to the stream loop so we can wait for it to finish before
      // sending the stream abort event.
      const abandonPartial = streamInfo.softInterrupt.pending
        ? streamInfo.softInterrupt.abandonPartial
        : false;
      void this.cleanupStream(workspaceId, streamInfo, abandonPartial);
    } catch (error) {
      log.error("Error during stream cancellation:", error);
      // Force cleanup even if cancellation fails
      this.workspaceStreams.delete(workspaceId);
    }
  }

  private async cleanupStream(
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo,
    abandonPartial?: boolean
  ): Promise<void> {
    // CRITICAL: Wait for processing to fully complete before cleanup
    // This prevents race conditions where the old stream is still running
    // while a new stream starts (e.g., old stream writing to partial.json)
    await streamInfo.processingPromise;

    // For aborts, use our tracked cumulativeUsage directly instead of AI SDK's totalUsage.
    // cumulativeUsage is updated on each finish-step event (before tool execution),
    // so it has accurate data even when the stream is interrupted mid-tool-call.
    // AI SDK's totalUsage may return zeros or stale data when aborted.
    const duration = Date.now() - streamInfo.startTime;
    const hasCumulativeUsage = (streamInfo.cumulativeUsage.totalTokens ?? 0) > 0;
    const usage = hasCumulativeUsage ? streamInfo.cumulativeUsage : undefined;

    // For context window display, use last step's usage (inputTokens = current context size)
    const contextUsage = streamInfo.lastStepUsage;
    const contextProviderMetadata = streamInfo.lastStepProviderMetadata;

    // Include provider metadata for accurate cost calculation
    const providerMetadata = streamInfo.cumulativeProviderMetadata;

    // Emit abort event with usage if available
    this.emit("stream-abort", {
      type: "stream-abort",
      workspaceId: workspaceId as string,
      messageId: streamInfo.messageId,
      metadata: { usage, contextUsage, duration, providerMetadata, contextProviderMetadata },
      abandonPartial,
    });

    // Clean up immediately
    this.workspaceStreams.delete(workspaceId);
  }

  /**
   * Atomically creates a new stream with all necessary setup
   */
  private createStreamAtomically(
    workspaceId: WorkspaceId,
    streamToken: StreamToken,
    runtimeTempDir: string,
    runtime: Runtime,
    messages: ModelMessage[],
    model: LanguageModel,
    modelString: string,
    abortSignal: AbortSignal | undefined,
    system: string,
    historySequence: number,
    tools?: Record<string, Tool>,
    initialMetadata?: Partial<MuxMetadata>,
    providerOptions?: Record<string, unknown>,
    maxOutputTokens?: number,
    toolPolicy?: ToolPolicy
  ): WorkspaceStreamInfo {
    // Create abort controller for this specific stream
    const abortController = new AbortController();

    // Link external abort signal
    if (abortSignal) {
      abortSignal.addEventListener("abort", () => abortController.abort());
    }

    // Determine toolChoice based on toolPolicy.
    //
    // If a tool is required (tools object has exactly one tool after applyToolPolicy),
    // force the model to use it using the AI SDK tool choice shape.
    let toolChoice: { type: "tool"; toolName: string } | "required" | undefined;
    if (tools && toolPolicy) {
      const hasRequireAction = toolPolicy.some((filter) => filter.action === "require");
      if (hasRequireAction && Object.keys(tools).length === 1) {
        const requiredToolName = Object.keys(tools)[0];
        toolChoice = { type: "tool", toolName: requiredToolName };
        log.debug("Setting toolChoice to tool", { toolName: requiredToolName });
      }
    }

    // Anthropic Extended Thinking is incompatible with forced tool choice.
    // If a tool is forced, disable thinking for this request to avoid API errors.
    let finalProviderOptions = providerOptions;
    const [provider] = normalizeGatewayModel(modelString).split(":", 2);
    if (
      toolChoice &&
      provider === "anthropic" &&
      providerOptions &&
      typeof providerOptions === "object" &&
      "anthropic" in providerOptions
    ) {
      const anthropicOptions = (providerOptions as { anthropic?: unknown }).anthropic;
      if (
        anthropicOptions &&
        typeof anthropicOptions === "object" &&
        "thinking" in anthropicOptions
      ) {
        const { thinking: _thinking, ...rest } = anthropicOptions as Record<string, unknown>;
        finalProviderOptions = {
          ...providerOptions,
          anthropic: rest,
        };
      }
    }

    // Apply cache control for Anthropic models
    let finalMessages = messages;
    let finalTools = tools;
    let finalSystem: string | undefined = system;

    // For Anthropic models, convert system message to a cached message at the start
    const cachedSystemMessage = createCachedSystemMessage(system, modelString);
    if (cachedSystemMessage) {
      // Prepend cached system message and set system parameter to undefined
      // Note: Must be undefined, not empty string, to avoid Anthropic API error
      finalMessages = [cachedSystemMessage, ...messages];
      finalSystem = undefined;
    }

    // Apply cache control to tools for Anthropic models
    if (tools) {
      finalTools = applyCacheControlToTools(tools, modelString);
    }

    // Start streaming - this can throw immediately if API key is missing
    let streamResult;
    try {
      streamResult = streamText({
        model,
        messages: finalMessages,
        system: finalSystem,
        abortSignal: abortController.signal,
        tools: finalTools,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment
        toolChoice: toolChoice as any, // Force tool use when required by policy
        // When toolChoice is set (required tool), limit to 1 step to prevent infinite loops
        // Otherwise allow effectively unlimited steps (100k) for autonomous multi-turn workflows.
        // IMPORTANT: Models should be able to run for hours or even days calling tools repeatedly
        // to complete complex tasks. The stopWhen condition allows the model to decide when it's done.
        ...(toolChoice ? { maxSteps: 1 } : { stopWhen: stepCountIs(100000) }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment
        providerOptions: finalProviderOptions as any, // Pass provider-specific options (thinking/reasoning config)
        // Default to 32000 tokens if not specified (Anthropic defaults to 4096)
        maxOutputTokens: maxOutputTokens ?? 32000,
      });
    } catch (error) {
      // Clean up abort controller if stream creation fails
      abortController.abort();
      // Re-throw the error to be caught by startStream
      throw error;
    }

    const messageId = `assistant-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    const streamInfo: WorkspaceStreamInfo = {
      state: StreamState.STARTING,
      streamResult,
      abortController,
      messageId,
      token: streamToken,
      startTime: Date.now(),
      model: modelString,
      initialMetadata,
      historySequence,
      parts: [], // Initialize empty parts array
      lastPartialWriteTime: 0, // Initialize to 0 to allow immediate first write
      partialWritePromise: undefined, // No write in flight initially
      processingPromise: Promise.resolve(), // Placeholder, overwritten in startStream
      softInterrupt: { pending: false },
      runtimeTempDir, // Stream-scoped temp directory for tool outputs
      runtime, // Runtime for temp directory cleanup
      // Initialize cumulative tracking for multi-step streams
      cumulativeUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      cumulativeProviderMetadata: undefined,
    };

    // Atomically register the stream
    this.workspaceStreams.set(workspaceId, streamInfo);

    return streamInfo;
  }

  /**
   * Complete a tool call by updating its part and emitting tool-call-end event.
   * CRITICAL: Flushes partial to disk BEFORE emitting event to prevent race conditions
   * where listeners (e.g., sendQueuedMessages) read stale partial data.
   */
  private async completeToolCall(
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo,
    toolCalls: Map<
      string,
      { toolCallId: string; toolName: string; input: unknown; output?: unknown }
    >,
    toolCallId: string,
    toolName: string,
    output: unknown
  ): Promise<void> {
    // Find and update the existing tool part
    const existingPartIndex = streamInfo.parts.findIndex(
      (p) => p.type === "dynamic-tool" && p.toolCallId === toolCallId
    );

    if (existingPartIndex !== -1) {
      const existingPart = streamInfo.parts[existingPartIndex];
      if (existingPart.type === "dynamic-tool") {
        streamInfo.parts[existingPartIndex] = {
          ...existingPart,
          state: "output-available" as const,
          output,
        };
      }
    } else {
      // Fallback: part not found (shouldn't happen for errors, but can happen for results)
      // This case exists in tool-result but we'll keep it for robustness
      const toolCall = toolCalls.get(toolCallId);
      if (toolCall) {
        streamInfo.parts.push({
          type: "dynamic-tool" as const,
          toolCallId,
          toolName,
          state: "output-available" as const,
          input: toolCall.input,
          output,
        });
      }
    }

    // CRITICAL: Flush partial to disk BEFORE emitting event
    // This ensures listeners (like sendQueuedMessages) see the tool result when they
    // read partial.json via commitToHistory. Without this await, there's a race condition
    // where the partial is read before the tool result is written, causing "amnesia".
    await this.flushPartialWrite(workspaceId, streamInfo);

    // Emit tool-call-end event (listeners can now safely read partial)
    this.emit("tool-call-end", {
      type: "tool-call-end",
      workspaceId: workspaceId as string,
      messageId: streamInfo.messageId,
      toolCallId,
      toolName,
      result: output,
      timestamp: Date.now(),
    } as ToolCallEndEvent);
  }

  /**
   * Emit nested tool events from PTC code_execution.
   * These are forwarded to the frontend via the same event channel as regular tool events.
   * The parentToolCallId field identifies which code_execution call spawned this nested call.
   */
  emitNestedToolEvent(
    workspaceId: string,
    messageId: string,
    event: {
      type: "tool-call-start" | "tool-call-end";
      callId: string;
      toolName: string;
      args: unknown;
      parentToolCallId: string;
      startTime: number;
      endTime?: number;
      result?: unknown;
      error?: string;
    }
  ): void {
    if (event.type === "tool-call-start") {
      this.emit("tool-call-start", {
        type: "tool-call-start",
        workspaceId,
        messageId,
        toolCallId: event.callId,
        toolName: event.toolName,
        args: event.args,
        tokens: 0, // Nested calls don't count toward stream tokens
        timestamp: event.startTime,
        parentToolCallId: event.parentToolCallId,
      });
    } else if (event.type === "tool-call-end") {
      this.emit("tool-call-end", {
        type: "tool-call-end",
        workspaceId,
        messageId,
        toolCallId: event.callId,
        toolName: event.toolName,
        result: event.result ?? (event.error ? { error: event.error } : undefined),
        timestamp: event.endTime!,
        parentToolCallId: event.parentToolCallId,
      });
    }
    // Console events are not streamed (appear in final result only)
  }

  /**
   * Processes a stream with guaranteed cleanup, regardless of success or failure
   */
  private async processStreamWithCleanup(
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo,
    historySequence: number
  ): Promise<void> {
    try {
      // Update state to streaming
      streamInfo.state = StreamState.STREAMING;

      // Emit stream start event (include mode from initialMetadata if available)
      const streamStartMode = streamInfo.initialMetadata?.mode as "plan" | "exec" | undefined;
      this.emit("stream-start", {
        type: "stream-start",
        workspaceId: workspaceId as string,
        messageId: streamInfo.messageId,
        model: streamInfo.model,
        historySequence,
        startTime: streamInfo.startTime,
        ...(streamStartMode && { mode: streamStartMode }),
      } as StreamStartEvent);

      // Initialize token tracker for this model
      await this.tokenTracker.setModel(streamInfo.model);

      // Use fullStream to capture all events including tool calls
      const toolCalls = new Map<
        string,
        { toolCallId: string; toolName: string; input: unknown; output?: unknown }
      >();

      for await (const part of streamInfo.streamResult.fullStream) {
        // Check if stream was cancelled BEFORE processing any parts
        // This improves interruption responsiveness by catching aborts earlier
        if (streamInfo.abortController.signal.aborted) {
          break;
        }

        // Log all stream parts to debug reasoning (commented out - too spammy)
        // console.log("[DEBUG streamManager]: Stream part", {
        //   type: part.type,
        //   hasText: "text" in part,
        //   preview: "text" in part ? (part as StreamPartWithText).text?.substring(0, 50) : undefined,
        // });

        switch (part.type) {
          case "text-delta": {
            // Append each delta as a new part (merging happens at display time)
            const textPart = {
              type: "text" as const,
              text: part.text,
              timestamp: Date.now(),
            };
            streamInfo.parts.push(textPart);

            // Emit using shared logic (ensures replay consistency)
            await this.emitPartAsEvent(workspaceId, streamInfo.messageId, textPart);

            // Schedule partial write (throttled, fire-and-forget to not block stream)
            void this.schedulePartialWrite(workspaceId, streamInfo);
            break;
          }

          default: {
            if (await this.emitToolCallDeltaIfPresent(workspaceId, streamInfo, part)) {
              break;
            }
            break;
          }

          case "reasoning-delta": {
            // Both Anthropic and OpenAI use reasoning-delta for streaming reasoning content
            const delta = (part as ReasoningDeltaPart).text ?? "";

            // Append each delta as a new part (merging happens at display time)
            const reasoningPart = {
              type: "reasoning" as const,
              text: delta,
              timestamp: Date.now(),
            };
            streamInfo.parts.push(reasoningPart);

            // Emit using shared logic (ensures replay consistency)
            await this.emitPartAsEvent(workspaceId, streamInfo.messageId, reasoningPart);

            void this.schedulePartialWrite(workspaceId, streamInfo);
            break;
          }

          case "reasoning-end": {
            // Reasoning-end is just a signal - no state to update
            this.emit("reasoning-end", {
              type: "reasoning-end",
              workspaceId: workspaceId as string,
              messageId: streamInfo.messageId,
            });
            await this.checkSoftCancelStream(workspaceId, streamInfo);
            break;
          }

          case "tool-call": {
            // Tool call started - store in map for later lookup
            toolCalls.set(part.toolCallId, {
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              input: part.input,
            });

            // Note: Tool availability is handled by the SDK, which emits tool-error events
            // for unavailable tools. No need to check here.

            // IMPORTANT: Add tool part to streamInfo.parts immediately (not just on completion)
            // This ensures in-progress tool calls are saved to partial.json if stream is interrupted
            const toolPart = {
              type: "dynamic-tool" as const,
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              state: "input-available" as const,
              // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
              input: part.input,
              timestamp: Date.now(),
            };
            streamInfo.parts.push(toolPart);

            // Emit using shared logic (ensures replay consistency)
            const inputText = JSON.stringify(part.input);
            log.debug(
              `[StreamManager] tool-call: toolName=${part.toolName}, input length=${inputText.length}`
            );
            await this.emitPartAsEvent(workspaceId, streamInfo.messageId, toolPart);

            // CRITICAL: Flush partial immediately for ask_user_question
            // This tool blocks waiting for user input, and if the app restarts during
            // that wait, the partial must be persisted so it can be restored.
            // Without this, the throttled write might not complete before app shutdown.
            if (part.toolName === "ask_user_question") {
              await this.flushPartialWrite(workspaceId, streamInfo);
            }
            break;
          }

          case "tool-result": {
            // Tool call completed successfully
            const toolCall = toolCalls.get(part.toolCallId);
            if (toolCall) {
              // Strip encrypted content from web search results before storing
              const strippedOutput = stripEncryptedContent(part.output);
              toolCall.output = strippedOutput;

              // Use shared completion logic (await to ensure partial is flushed before event)
              await this.completeToolCall(
                workspaceId,
                streamInfo,
                toolCalls,
                part.toolCallId,
                part.toolName,
                strippedOutput
              );
            }
            await this.checkSoftCancelStream(workspaceId, streamInfo);
            break;
          }

          // Handle tool-error parts from the stream (AI SDK 5.0+)
          // These are emitted when tool execution fails (e.g., tool doesn't exist)
          case "tool-error": {
            const toolErrorPart = part as {
              toolCallId: string;
              toolName: string;
              error: unknown;
            };

            const logLevel = streamInfo.abortController.signal.aborted ? log.debug : log.error;
            logLevel(`Tool execution error for '${toolErrorPart.toolName}'`, {
              toolCallId: toolErrorPart.toolCallId,
              error: toolErrorPart.error,
            });

            // Format error output
            const errorOutput = {
              success: false,
              error:
                typeof toolErrorPart.error === "string"
                  ? toolErrorPart.error
                  : toolErrorPart.error instanceof Error
                    ? toolErrorPart.error.message
                    : JSON.stringify(toolErrorPart.error),
            };

            // Use shared completion logic (await to ensure partial is flushed before event)
            await this.completeToolCall(
              workspaceId,
              streamInfo,
              toolCalls,
              toolErrorPart.toolCallId,
              toolErrorPart.toolName,
              errorOutput
            );
            await this.checkSoftCancelStream(workspaceId, streamInfo);
            break;
          }

          // Handle error parts from the stream (e.g., OpenAI context_length_exceeded)
          case "error": {
            // Capture the error and immediately throw to trigger error handling
            // Error parts are structured errors from the AI SDK
            const errorPart = part as { error: unknown };

            // Try to extract error message from various possible structures
            let errorMessage: string | undefined;

            if (errorPart.error instanceof Error) {
              throw errorPart.error;
            } else if (typeof errorPart.error === "object" && errorPart.error !== null) {
              const errorObj = errorPart.error as Record<string, unknown>;

              // Check for nested error object with message (OpenAI format)
              if (errorObj.error && typeof errorObj.error === "object" && errorObj.error !== null) {
                const nestedError = errorObj.error as Record<string, unknown>;
                if (typeof nestedError.message === "string") {
                  errorMessage = nestedError.message;
                }
              }

              // Fallback to direct message property
              errorMessage ??= typeof errorObj.message === "string" ? errorObj.message : undefined;

              // Last resort: stringify the error
              errorMessage ??= JSON.stringify(errorObj);

              const error = new Error(errorMessage);
              // Preserve original error as cause for debugging
              Object.assign(error, { cause: errorObj });
              throw error;
            } else {
              throw new Error(String(errorPart.error));
            }
          }

          // Handle other event types as needed
          case "start":
          case "start-step":
          case "text-start":
          case "finish":
            // These events can be logged or handled if needed
            break;

          case "finish-step": {
            // Emit usage-delta event with usage from this step
            const finishStepPart = part as {
              type: "finish-step";
              usage: LanguageModelV2Usage;
              providerMetadata?: Record<string, unknown>;
            };

            // Update cumulative totals for this stream
            streamInfo.cumulativeUsage = addUsage(streamInfo.cumulativeUsage, finishStepPart.usage);
            streamInfo.cumulativeProviderMetadata = accumulateProviderMetadata(
              streamInfo.cumulativeProviderMetadata,
              finishStepPart.providerMetadata
            );

            // Track last step's data for context window display
            streamInfo.lastStepUsage = finishStepPart.usage;
            streamInfo.lastStepProviderMetadata = finishStepPart.providerMetadata;

            const usageEvent: UsageDeltaEvent = {
              type: "usage-delta",
              workspaceId: workspaceId as string,
              messageId: streamInfo.messageId,
              // Step-level (for context window display)
              usage: finishStepPart.usage,
              providerMetadata: finishStepPart.providerMetadata,
              // Cumulative (for live cost display)
              cumulativeUsage: streamInfo.cumulativeUsage,
              cumulativeProviderMetadata: streamInfo.cumulativeProviderMetadata,
            };
            this.emit("usage-delta", usageEvent);
            await this.checkSoftCancelStream(workspaceId, streamInfo);
            break;
          }

          case "text-end": {
            await this.checkSoftCancelStream(workspaceId, streamInfo);
            break;
          }
        }
      }

      // No need to save remaining text - text-delta handler already maintains parts array
      // (Removed duplicate push that was causing double text parts)

      // Flush final state to partial.json for crash resilience
      // This happens regardless of abort status to ensure the final state is persisted to disk
      // On abort: second flush after cancelStreamSafely, ensures all streamed content is saved
      // On normal completion: provides crash resilience before AIService writes to chat.jsonl
      await this.flushPartialWrite(workspaceId, streamInfo);

      // Check if stream completed successfully
      if (!streamInfo.abortController.signal.aborted) {
        // Get all metadata from stream result in one call
        // - totalUsage: sum of all steps (for cost calculation)
        // - contextUsage: last step only (for context window display)
        // - contextProviderMetadata: last step (for context window cache tokens)
        // Falls back to tracked values from finish-step if streamResult fails/times out
        const streamMeta = await this.getStreamMetadata(streamInfo);
        const totalUsage = streamMeta.totalUsage;
        const contextUsage = streamMeta.contextUsage ?? streamInfo.lastStepUsage;
        const contextProviderMetadata =
          streamMeta.contextProviderMetadata ?? streamInfo.lastStepProviderMetadata;
        const duration = streamMeta.duration;
        // Aggregated provider metadata across all steps (for cost calculation with cache tokens)
        const providerMetadata = await this.getAggregatedProviderMetadata(streamInfo);

        // Emit stream end event with parts preserved in temporal order
        const streamEndEvent: StreamEndEvent = {
          type: "stream-end",
          workspaceId: workspaceId as string,
          messageId: streamInfo.messageId,
          metadata: {
            ...streamInfo.initialMetadata, // AIService-provided metadata (systemMessageTokens, etc)
            model: streamInfo.model,
            usage: totalUsage, // Total across all steps (for cost calculation)
            contextUsage, // Last step only (for context window display)
            providerMetadata, // Aggregated (for cost calculation)
            contextProviderMetadata, // Last step (for context window display)
            duration,
          },
          parts: streamInfo.parts, // Parts array with temporal ordering (includes reasoning)
        };

        // Mark as completed BEFORE emitting stream-end to prevent race conditions
        // where isStreaming() returns true while event handlers try to send new messages
        streamInfo.state = StreamState.COMPLETED;

        this.emit("stream-end", streamEndEvent);

        // Update history with final message (only if there are parts)
        if (streamInfo.parts && streamInfo.parts.length > 0) {
          const finalAssistantMessage: MuxMessage = {
            id: streamInfo.messageId,
            role: "assistant",
            metadata: {
              ...streamEndEvent.metadata,
              historySequence: streamInfo.historySequence,
            },
            parts: streamInfo.parts,
          };

          // CRITICAL: Delete partial.json before updating chat.jsonl
          // On successful completion, partial.json becomes stale and must be removed
          await this.partialService.deletePartial(workspaceId as string);

          // Update the placeholder message in chat.jsonl with final content
          await this.historyService.updateHistory(workspaceId as string, finalAssistantMessage);

          // Update cumulative session usage (if service is available)
          if (this.sessionUsageService && totalUsage) {
            const messageUsage = createDisplayUsage(totalUsage, streamInfo.model, providerMetadata);
            if (messageUsage) {
              const normalizedModel = normalizeGatewayModel(streamInfo.model);
              await this.sessionUsageService.recordUsage(
                workspaceId as string,
                normalizedModel,
                messageUsage
              );
            }
          }
        }
      }
    } catch (error) {
      streamInfo.state = StreamState.ERROR;

      // Log the actual error for debugging
      log.error("Stream processing error:", error);

      // Check if this is a lost previousResponseId error and record it
      // Frontend will automatically retry, and buildProviderOptions will filter it out
      this.recordLostResponseIdIfApplicable(error, streamInfo);

      // Extract error message (errors thrown from 'error' parts already have the correct message)
      let errorMessage: string = error instanceof Error ? error.message : String(error);
      let actualError: unknown = error;

      // For categorization, use the cause if available (preserves the original error structure)
      if (error instanceof Error && error.cause) {
        actualError = error.cause;
      }

      let errorType = this.categorizeError(actualError);

      // Enhance model-not-found error messages
      if (errorType === "model_not_found") {
        // Extract model name from model string (e.g., "anthropic:sonnet-1m" -> "sonnet-1m")
        const [, modelName] = streamInfo.model.split(":");
        errorMessage = `Model '${modelName || streamInfo.model}' does not exist or is not available. Please check your model selection.`;
      }

      // If we detect API key issues in the error message, override the type
      if (
        errorMessage.toLowerCase().includes("api key") ||
        errorMessage.toLowerCase().includes("api_key") ||
        errorMessage.toLowerCase().includes("anthropic_api_key")
      ) {
        errorType = "authentication";
      }

      // Write error metadata to partial.json for persistence across reloads
      const errorPartialMessage: MuxMessage = {
        id: streamInfo.messageId,
        role: "assistant",
        metadata: {
          historySequence: streamInfo.historySequence,
          timestamp: streamInfo.startTime,
          model: streamInfo.model,
          partial: true,
          error: errorMessage,
          errorType,
          ...streamInfo.initialMetadata,
        },
        parts: streamInfo.parts,
      };
      // Wait for any in-flight partial write to complete before writing error state
      // This prevents race conditions where the error write and a throttled flush
      // write at the same time, causing inconsistent partial.json state
      if (streamInfo.partialWritePromise) {
        await streamInfo.partialWritePromise;
      }
      // Write error state to disk - await to ensure consistent state before any resume
      await this.partialService.writePartial(workspaceId as string, errorPartialMessage);

      // Emit error event
      this.emit("error", {
        type: "error",
        workspaceId: workspaceId as string,
        messageId: streamInfo.messageId,
        error: errorMessage,
        errorType: errorType,
      } as ErrorEvent);
    } finally {
      // Guaranteed cleanup in all code paths
      // Clear any pending timers to prevent keeping process alive
      if (streamInfo.partialWriteTimer) {
        clearTimeout(streamInfo.partialWriteTimer);
        streamInfo.partialWriteTimer = undefined;
      }

      // Clean up stream temp directory using runtime (fire-and-forget)
      // Don't block stream completion waiting for directory deletion
      // This is especially important for SSH where rm -rf can take 500ms-2s
      if (streamInfo.runtimeTempDir) {
        // Use parent directory as cwd for safety - if runtimeTempDir is malformed,
        // we won't accidentally run rm -rf from root
        const tempDirBasename = PlatformPaths.basename(streamInfo.runtimeTempDir);
        const tempDirParent = path.dirname(streamInfo.runtimeTempDir);
        void streamInfo.runtime
          .exec(`rm -rf "${tempDirBasename}"`, {
            cwd: tempDirParent,
            timeout: 10,
          })
          .then(async (result) => {
            await result.exitCode;
            log.debug(`Cleaned up temp dir: ${streamInfo.runtimeTempDir}`);
          })
          .catch((error) => {
            log.error(`Failed to cleanup temp dir ${streamInfo.runtimeTempDir}:`, error);
          });
      }

      this.workspaceStreams.delete(workspaceId);
    }
  }

  /**
   * Converts errors to strongly-typed SendMessageError
   */
  private convertToSendMessageError(error: unknown): SendMessageError {
    // Check for specific AI SDK errors using type guards
    if (LoadAPIKeyError.isInstance(error)) {
      return {
        type: "api_key_not_found",
        provider: "anthropic", // We can infer this from LoadAPIKeyError context
      };
    }

    // TODO: Add more specific error types as needed
    // if (APICallError.isInstance(error)) {
    //   if (error.statusCode === 401) return { type: "authentication", ... };
    //   if (error.statusCode === 429) return { type: "rate_limit", ... };
    // }
    // if (RetryError.isInstance(error)) {
    //   return { type: "retry_failed", ... };
    // }

    // Fallback for unknown errors
    const message = error instanceof Error ? error.message : String(error);
    return { type: "unknown", raw: message };
  }

  /**
   * Categorizes errors for better error handling (used for event emission)
   */
  private categorizeError(error: unknown): StreamErrorType {
    // Use AI SDK error type guards first
    if (LoadAPIKeyError.isInstance(error)) {
      return "authentication";
    }
    if (APICallError.isInstance(error)) {
      if (error.statusCode === 401) return "authentication";
      if (error.statusCode === 429) return "rate_limit";
      if (error.statusCode && error.statusCode >= 500) return "server_error";

      // Check for model_not_found errors (OpenAI and Anthropic)
      // Type guard for error data structure
      const hasErrorProperty = (
        data: unknown
      ): data is { error: { code?: string; type?: string } } => {
        return (
          typeof data === "object" &&
          data !== null &&
          "error" in data &&
          typeof data.error === "object" &&
          data.error !== null
        );
      };

      // OpenAI: 400 with error.code === 'model_not_found'
      const isOpenAIModelError =
        error.statusCode === 400 &&
        hasErrorProperty(error.data) &&
        error.data.error.code === "model_not_found";

      // Anthropic: 404 with error.type === 'not_found_error'
      const isAnthropicModelError =
        error.statusCode === 404 &&
        hasErrorProperty(error.data) &&
        error.data.error.type === "not_found_error";

      if (isOpenAIModelError || isAnthropicModelError) {
        return "model_not_found";
      }

      // Check for Anthropic context exceeded errors
      if (error.message.includes("prompt is too long:")) {
        return "context_exceeded";
      }

      return "api";
    }
    if (RetryError.isInstance(error)) {
      return "retry_failed";
    }

    // Check for OpenAI/Anthropic structured error format (from error.cause)
    // Structure: { error: { code: 'context_length_exceeded', type: '...', message: '...' } }
    if (
      typeof error === "object" &&
      error !== null &&
      "error" in error &&
      typeof error.error === "object" &&
      error.error !== null
    ) {
      const structuredError = error.error as { code?: string; type?: string };

      // OpenAI context length errors have code: 'context_length_exceeded'
      if (structuredError.code === "context_length_exceeded") {
        return "context_exceeded";
      }

      // Check for other specific error codes/types
      if (structuredError.code === "rate_limit_exceeded") {
        return "rate_limit";
      }
    }

    // Fall back to string matching for other errors
    if (error instanceof Error) {
      const message = error.message.toLowerCase();

      if (error.name === "AbortError" || message.includes("abort")) {
        return "aborted";
      } else if (message.includes("network") || message.includes("fetch")) {
        return "network";
      } else if (
        message.includes("token") ||
        message.includes("context") ||
        message.includes("too long") ||
        message.includes("maximum")
      ) {
        return "context_exceeded";
      } else if (message.includes("quota") || message.includes("limit")) {
        return "quota";
      } else if (message.includes("auth") || message.includes("key")) {
        return "authentication";
      } else {
        return "api";
      }
    }

    return "unknown";
  }

  /**
   * Starts a new stream for a workspace, automatically cancelling any existing stream
   *
   * Uses per-workspace mutex to prevent concurrent streams. The mutex ensures:
   * 1. Only one startStream can execute at a time per workspace
   * 2. Old stream fully exits before new stream starts
   * 3. No race conditions in stream registration or cleanup
   */
  async startStream(
    workspaceId: string,
    messages: ModelMessage[],
    model: LanguageModel,
    modelString: string,
    historySequence: number,
    system: string,
    runtime: Runtime,
    abortSignal?: AbortSignal,
    tools?: Record<string, Tool>,
    initialMetadata?: Partial<MuxMetadata>,
    providerOptions?: Record<string, unknown>,
    maxOutputTokens?: number,
    toolPolicy?: ToolPolicy,
    providedStreamToken?: StreamToken
  ): Promise<Result<StreamToken, SendMessageError>> {
    const typedWorkspaceId = workspaceId as WorkspaceId;

    if (messages.length === 0) {
      return Err({
        type: "unknown",
        raw: "Invalid prompt: messages must not be empty",
      });
    }

    // Get or create mutex for this workspace
    if (!this.streamLocks.has(typedWorkspaceId)) {
      this.streamLocks.set(typedWorkspaceId, new AsyncMutex());
    }
    const mutex = this.streamLocks.get(typedWorkspaceId)!;

    try {
      // Acquire lock - guarantees only one startStream per workspace
      // Lock is automatically released when scope exits via Symbol.asyncDispose
      await using _lock = await mutex.acquire();

      // DEBUG: Log stream start
      log.debug(
        `[STREAM START] workspaceId=${workspaceId} historySequence=${historySequence} model=${modelString}`
      );

      // Step 1: Cancel any existing stream before proceeding
      // This must happen regardless of whether a token was provided
      await this.ensureStreamSafety(typedWorkspaceId);

      // Step 2: Use provided stream token or generate a new one
      const streamToken = providedStreamToken ?? this.generateStreamToken();

      // Step 3: Create temp directory for this stream using runtime
      // If token was provided, temp dir might already exist - mkdir -p handles this
      const runtimeTempDir = await this.createTempDirForStream(streamToken, runtime);

      // Step 4: Atomic stream creation and registration
      const streamInfo = this.createStreamAtomically(
        typedWorkspaceId,
        streamToken,
        runtimeTempDir,
        runtime,
        messages,
        model,
        modelString,
        abortSignal,
        system,
        historySequence,
        tools,
        initialMetadata,
        providerOptions,
        maxOutputTokens,
        toolPolicy
      );

      // Step 5: Track the processing promise for guaranteed cleanup
      // This allows cancelStreamSafely to wait for full exit
      streamInfo.processingPromise = this.processStreamWithCleanup(
        typedWorkspaceId,
        streamInfo,
        historySequence
      ).catch((error) => {
        log.error("Unexpected error in stream processing:", error);
      });

      return Ok(streamToken);
    } catch (error) {
      // Guaranteed cleanup on any failure
      this.workspaceStreams.delete(typedWorkspaceId);
      // Convert to strongly-typed error
      return Err(this.convertToSendMessageError(error));
    }
  }

  /**
   * Record a previousResponseId as lost if the error indicates OpenAI no longer has it
   * Frontend will automatically retry, and buildProviderOptions will filter it out
   */
  private recordLostResponseIdIfApplicable(error: unknown, streamInfo: WorkspaceStreamInfo): void {
    const responseId = this.extractPreviousResponseIdFromError(error);
    if (!responseId) {
      return;
    }

    const errorCode = this.extractErrorCode(error);
    const statusCode = this.extractStatusCode(error);
    const shouldRecord =
      errorCode === "previous_response_not_found" || statusCode === 404 || statusCode === 500;

    if (!shouldRecord || this.lostResponseIds.has(responseId)) {
      return;
    }

    log.info("Recording lost previousResponseId for future filtering", {
      previousResponseId: responseId,
      messageId: streamInfo.messageId,
      model: streamInfo.model,
      statusCode,
      errorCode,
    });

    this.lostResponseIds.add(responseId);
  }

  /**
   * Extract previousResponseId from error response body
   * OpenAI's error message includes the ID: "Previous response with id 'resp_...' not found."
   */
  private extractPreviousResponseIdFromError(error: unknown): string | undefined {
    // Check APICallError.responseBody first
    if (APICallError.isInstance(error) && typeof error.responseBody === "string") {
      const match = /'(resp_[a-f0-9]+)'/.exec(error.responseBody);
      if (match) {
        return match[1];
      }
    }

    // Check error message
    if (error instanceof Error) {
      const match = /'(resp_[a-f0-9]+)'/.exec(error.message);
      if (match) {
        return match[1];
      }
    }

    return undefined;
  }

  /**
   * Check if a previousResponseId has been marked as lost
   * Called by buildProviderOptions to filter out invalid IDs
   */
  public isResponseIdLost(responseId: string): boolean {
    return this.lostResponseIds.has(responseId);
  }

  private extractErrorCode(error: unknown): string | undefined {
    const candidates: unknown[] = [];
    if (APICallError.isInstance(error)) {
      candidates.push(error.data);
    }
    candidates.push(error);
    for (const candidate of candidates) {
      const directCode = this.getStructuredErrorCode(candidate);
      if (directCode) {
        return directCode;
      }
      if (candidate && typeof candidate === "object" && "data" in candidate) {
        const dataCandidate = (candidate as { data?: unknown }).data;
        const nestedCode = this.getStructuredErrorCode(dataCandidate);
        if (nestedCode) {
          return nestedCode;
        }
      }
    }
    return undefined;
  }

  private extractStatusCode(error: unknown): number | undefined {
    if (APICallError.isInstance(error) && typeof error.statusCode === "number") {
      return error.statusCode;
    }

    if (typeof error === "object" && error !== null && "statusCode" in error) {
      const candidate = (error as { statusCode?: unknown }).statusCode;
      if (typeof candidate === "number") {
        return candidate;
      }
    }

    return undefined;
  }

  private getStructuredErrorCode(candidate: unknown): string | undefined {
    if (typeof candidate === "object" && candidate !== null && "error" in candidate) {
      const withError = candidate as { error?: unknown };
      if (withError.error && typeof withError.error === "object") {
        const nested = withError.error as Record<string, unknown>;
        const code = nested.code;
        if (typeof code === "string") {
          return code;
        }
      }
    }
    return undefined;
  }

  /**
   * Stops an active stream for a workspace
   * If soft is true, performs a soft interrupt (cancels at next block boundary)
   */
  async stopStream(
    workspaceId: string,
    options?: { soft?: boolean; abandonPartial?: boolean }
  ): Promise<Result<void>> {
    const typedWorkspaceId = workspaceId as WorkspaceId;

    try {
      const streamInfo = this.workspaceStreams.get(typedWorkspaceId);
      if (!streamInfo) {
        return Ok(undefined); // No active stream
      }

      const soft = options?.soft ?? false;

      if (soft) {
        // Soft interrupt: set flag, will cancel at next block boundary
        streamInfo.softInterrupt = {
          pending: true,
          abandonPartial: options?.abandonPartial ?? false,
        };
      } else {
        // Hard interrupt: cancel immediately
        await this.cancelStreamSafely(typedWorkspaceId, streamInfo, options?.abandonPartial);
      }
      return Ok(undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Err(`Failed to stop stream: ${message}`);
    }
  }

  /**
   * Gets the current stream state for a workspace
   */
  getStreamState(workspaceId: string): StreamState {
    const typedWorkspaceId = workspaceId as WorkspaceId;
    const streamInfo = this.workspaceStreams.get(typedWorkspaceId);
    return streamInfo?.state ?? StreamState.IDLE;
  }

  /**
   * Checks if a workspace currently has an active stream
   */
  isStreaming(workspaceId: string): boolean {
    const state = this.getStreamState(workspaceId);
    return state === StreamState.STARTING || state === StreamState.STREAMING;
  }

  /**
   * Gets all active workspace streams (for debugging/monitoring)
   */
  getActiveStreams(): string[] {
    return Array.from(this.workspaceStreams.keys()).map((id) => id as string);
  }

  /**
   * Gets the current stream info for a workspace if actively streaming
   * Returns undefined if no active stream exists
   * Used to re-establish streaming context on frontend reconnection
   */
  getStreamInfo(
    workspaceId: string
  ):
    | { messageId: string; model: string; historySequence: number; parts: CompletedMessagePart[] }
    | undefined {
    const typedWorkspaceId = workspaceId as WorkspaceId;
    const streamInfo = this.workspaceStreams.get(typedWorkspaceId);

    // Only return info if stream is actively running
    if (
      streamInfo &&
      (streamInfo.state === StreamState.STARTING || streamInfo.state === StreamState.STREAMING)
    ) {
      return {
        messageId: streamInfo.messageId,
        model: streamInfo.model,
        historySequence: streamInfo.historySequence,
        parts: streamInfo.parts,
      };
    }

    return undefined;
  }

  /**
   * Replay stream events
   * Emits the same events (stream-start, stream-delta, etc.) that would be emitted during live streaming
   * This allows replay to flow through the same event path as live streaming (no duplication)
   */
  async replayStream(workspaceId: string): Promise<void> {
    const typedWorkspaceId = workspaceId as WorkspaceId;
    const streamInfo = this.workspaceStreams.get(typedWorkspaceId);

    // Only replay if stream is actively running
    if (
      !streamInfo ||
      (streamInfo.state !== StreamState.STARTING && streamInfo.state !== StreamState.STREAMING)
    ) {
      return;
    }

    // Initialize token tracker for this model (required for tokenization)
    await this.tokenTracker.setModel(streamInfo.model);

    // Emit stream-start event (include mode from initialMetadata if available)
    const replayMode = streamInfo.initialMetadata?.mode as "plan" | "exec" | undefined;
    this.emit("stream-start", {
      type: "stream-start",
      workspaceId,
      messageId: streamInfo.messageId,
      model: streamInfo.model,
      historySequence: streamInfo.historySequence,
      startTime: streamInfo.startTime,
      ...(replayMode && { mode: replayMode }),
    });

    // Replay accumulated parts as events using shared emission logic
    // This guarantees replay produces identical events to the original stream
    for (const part of streamInfo.parts) {
      await this.emitPartAsEvent(typedWorkspaceId, streamInfo.messageId, part);
    }
  }

  /**
   * DEBUG ONLY: Trigger an artificial stream error for testing
   * This method allows integration tests to simulate stream errors without
   * mocking the AI SDK or network layer. It triggers the same error handling
   * path as genuine stream errors by aborting the stream and manually triggering
   * the error event (since abort alone doesn't throw, it just sets a flag that
   * causes the for-await loop to break cleanly).
   */
  async debugTriggerStreamError(workspaceId: string, errorMessage: string): Promise<boolean> {
    const typedWorkspaceId = workspaceId as WorkspaceId;
    const streamInfo = this.workspaceStreams.get(typedWorkspaceId);

    // Only trigger error if stream is actively running
    if (
      !streamInfo ||
      (streamInfo.state !== StreamState.STARTING && streamInfo.state !== StreamState.STREAMING)
    ) {
      return false;
    }

    // Abort the stream first (causes for-await loop to break cleanly)
    streamInfo.abortController.abort(new Error(errorMessage));

    // Mark as error state (same as catch block does)
    streamInfo.state = StreamState.ERROR;

    // Update streamInfo metadata with error (so subsequent flushes preserve it)
    streamInfo.initialMetadata = {
      ...streamInfo.initialMetadata,
      error: errorMessage,
      errorType: "network",
    };

    // Write error state to partial.json (same as real error handling)
    // Wait for any in-flight partial write to complete first
    if (streamInfo.partialWritePromise) {
      await streamInfo.partialWritePromise;
    }
    const errorPartialMessage: MuxMessage = {
      id: streamInfo.messageId,
      role: "assistant",
      metadata: {
        historySequence: streamInfo.historySequence,
        timestamp: streamInfo.startTime,
        model: streamInfo.model,
        partial: true,
        error: errorMessage,
        errorType: "network", // Test errors are network-like
        ...streamInfo.initialMetadata,
      },
      parts: streamInfo.parts,
    };
    await this.partialService.writePartial(workspaceId, errorPartialMessage);

    // Emit error event (same as real error handling)
    this.emit("error", {
      type: "error",
      workspaceId,
      messageId: streamInfo.messageId,
      error: errorMessage,
      errorType: "network",
    } as ErrorEvent);

    // Wait for the stream processing to complete (cleanup)
    await streamInfo.processingPromise;

    return true;
  }
}
