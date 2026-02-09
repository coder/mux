/**
 * Handles all context-exceeded retry strategies for AgentSession.
 *
 * Owns the retry-related state (attempt tracking, active stream context) and
 * implements three progressive strategies:
 * 1. Compaction retry (OpenAI truncation / Anthropic 1M context)
 * 2. Post-compaction retry (strip post-compaction attachments)
 * 3. Hard restart exec subagent (clear history, replay seed prompt)
 */
import { log } from "@/node/services/log";
import type { HistoryService } from "@/node/services/historyService";
import type { PartialService } from "@/node/services/partialService";
import type { AIService } from "@/node/services/aiService";
import type {
  WorkspaceChatMessage,
  SendMessageOptions,
  FilePart,
  DeleteMessage,
} from "@/common/orpc/types";
import type { SendMessageError } from "@/common/types/errors";
import {
  createStreamErrorMessage,
  type StreamErrorPayload,
} from "@/node/services/utils/sendMessageError";
import {
  createMuxMessage,
  type CompactionFollowUpRequest,
  type MuxFrontendMetadata,
  type MuxMessage,
  type ReviewNoteDataForDisplay,
} from "@/common/types/message";
import { createUserMessageId } from "@/node/services/utils/messageIds";
import { WORKSPACE_DEFAULTS } from "@/constants/workspaceDefaults";
import { normalizeGatewayModel } from "@/common/utils/ai/models";
import { getErrorMessage } from "@/common/utils/errors";
import type { Result } from "@/common/types/result";
import { AgentIdSchema } from "@/common/orpc/schemas";
import { createRuntimeForWorkspace } from "@/node/runtime/runtimeHelpers";
import { isExecLikeEditingCapableInResolvedChain } from "@/common/utils/agentTools";
import { readAgentDefinition } from "@/node/services/agentDefinitions/agentDefinitionsService";
import { resolveAgentInheritanceChain } from "@/node/services/agentDefinitions/resolveAgentInheritanceChain";
import type { CompactionHandler } from "./compactionHandler";

// Type guard for compaction request metadata
// Supports both new `followUpContent` and legacy `continueMessage` for backwards compatibility
export interface CompactionRequestMetadata {
  type: "compaction-request";
  parsed: {
    followUpContent?: CompactionFollowUpRequest;
    // Legacy field - older persisted requests may use this instead of followUpContent
    continueMessage?: {
      text?: string;
      imageParts?: FilePart[];
      reviews?: ReviewNoteDataForDisplay[];
      muxMetadata?: MuxFrontendMetadata;
      model?: string;
      agentId?: string;
      mode?: "exec" | "plan"; // Legacy: older versions stored mode instead of agentId
    };
  };
}

export function isCompactionRequestMetadata(meta: unknown): meta is CompactionRequestMetadata {
  if (typeof meta !== "object" || meta === null) return false;
  const obj = meta as Record<string, unknown>;
  if (obj.type !== "compaction-request") return false;
  if (typeof obj.parsed !== "object" || obj.parsed === null) return false;
  return true;
}

export { type StreamErrorPayload } from "@/node/services/utils/sendMessageError";

export interface ContextExceededRetryHandlerOptions {
  workspaceId: string;
  historyService: HistoryService;
  partialService: PartialService;
  aiService: AIService;
  compactionHandler: CompactionHandler;
  onPostCompactionStateChange?: () => void;
}

export interface ContextExceededRetryCallbacks {
  emitChatEvent: (message: WorkspaceChatMessage) => void;
  clearQueue: () => void;
  streamWithHistory: (
    modelString: string,
    options?: SendMessageOptions,
    openaiTruncationModeOverride?: "auto" | "disabled",
    disablePostCompactionAttachments?: boolean
  ) => Promise<Result<void, SendMessageError>>;
  isDisposed: () => boolean;
  setStreamStarting: (value: boolean) => void;
}

export class ContextExceededRetryHandler {
  private readonly workspaceId: string;
  private readonly historyService: HistoryService;
  private readonly partialService: PartialService;
  private readonly aiService: AIService;
  private readonly compactionHandler: CompactionHandler;
  private readonly onPostCompactionStateChange?: () => void;
  private readonly callbacks: ContextExceededRetryCallbacks;

  /** Track compaction requests that already retried with truncation. */
  private readonly compactionRetryAttempts = new Set<string>();

  /** Track user message ids that already retried without post-compaction injection. */
  private readonly postCompactionRetryAttempts = new Set<string>();

  /** Track user message ids that already hard-restarted for exec-like subagents. */
  private readonly execSubagentHardRestartAttempts = new Set<string>();

  /** Tracks the user message id that initiated the currently active stream (for retry guards). */
  private activeStreamUserMessageId?: string;

  /** True once we see any model/tool output for the current stream (retry guard). */
  private activeStreamHadAnyDelta = false;

  /** Tracks whether the current stream included post-compaction attachments. */
  private activeStreamHadPostCompactionInjection = false;

  /** Context needed to retry the current stream (cleared on stream end/abort/error). */
  private activeStreamContext?: {
    modelString: string;
    options?: SendMessageOptions;
    openaiTruncationModeOverride?: "auto" | "disabled";
  };

  /**
   * Active compaction request metadata for retry decisions (cleared on stream end/abort).
   */
  private activeCompactionRequest?: {
    id: string;
    modelString: string;
    options?: SendMessageOptions;
  };

  constructor(
    options: ContextExceededRetryHandlerOptions,
    callbacks: ContextExceededRetryCallbacks
  ) {
    this.workspaceId = options.workspaceId;
    this.historyService = options.historyService;
    this.partialService = options.partialService;
    this.aiService = options.aiService;
    this.compactionHandler = options.compactionHandler;
    this.onPostCompactionStateChange = options.onPostCompactionStateChange;
    this.callbacks = callbacks;
  }

  // ── Public API for AgentSession state management ──

  /**
   * Initialize per-stream state. Called at the start of each streamWithHistory.
   */
  initStreamState(params: {
    modelString: string;
    options?: SendMessageOptions;
    openaiTruncationModeOverride?: "auto" | "disabled";
  }): void {
    this.activeStreamHadAnyDelta = false;
    this.activeStreamHadPostCompactionInjection = false;
    this.activeStreamContext = {
      modelString: params.modelString,
      options: params.options,
      openaiTruncationModeOverride: params.openaiTruncationModeOverride,
    };
    this.activeStreamUserMessageId = undefined;
  }

  /** Set the user message ID that initiated the current stream. */
  setActiveStreamUserMessageId(id: string | undefined): void {
    this.activeStreamUserMessageId = id;
  }

  /** Resolve and set the active compaction request from history. */
  resolveAndSetCompactionRequest(
    history: MuxMessage[],
    modelString: string,
    options?: SendMessageOptions
  ): void {
    this.activeCompactionRequest = this.resolveCompactionRequest(history, modelString, options);
  }

  /** Set whether the current stream included post-compaction attachments. */
  setPostCompactionInjection(had: boolean): void {
    this.activeStreamHadPostCompactionInjection = had;
  }

  /** Mark that the current stream has received meaningful output. */
  markStreamHadDelta(): void {
    this.activeStreamHadAnyDelta = true;
  }

  /** Clear the active compaction request (e.g., on stream end/abort/failure). */
  clearActiveCompactionRequest(): void {
    this.activeCompactionRequest = undefined;
  }

  /** Whether a compaction request is currently active. */
  hasActiveCompactionRequest(): boolean {
    return this.activeCompactionRequest !== undefined;
  }

  /** Reset all per-stream state fields owned by this handler. */
  resetActiveStreamState(): void {
    this.activeStreamContext = undefined;
    this.activeStreamUserMessageId = undefined;
    this.activeStreamHadPostCompactionInjection = false;
    this.activeStreamHadAnyDelta = false;
  }

  // ── Error handling entry point ──

  async handleStreamError(data: StreamErrorPayload): Promise<void> {
    const hadCompactionRequest = this.activeCompactionRequest !== undefined;
    if (
      await this.maybeRetryCompactionOnContextExceeded({
        messageId: data.messageId,
        errorType: data.errorType,
      })
    ) {
      return;
    }

    if (
      await this.maybeRetryWithoutPostCompactionOnContextExceeded({
        messageId: data.messageId,
        errorType: data.errorType,
      })
    ) {
      return;
    }

    if (
      await this.maybeHardRestartExecSubagentOnContextExceeded({
        messageId: data.messageId,
        errorType: data.errorType,
      })
    ) {
      return;
    }

    this.activeCompactionRequest = undefined;
    this.resetActiveStreamState();

    if (hadCompactionRequest && !this.callbacks.isDisposed()) {
      this.callbacks.clearQueue();
    }

    this.callbacks.emitChatEvent(createStreamErrorMessage(data));
  }

  // ── Private retry strategies ──

  private resolveCompactionRequest(
    history: MuxMessage[],
    modelString: string,
    options?: SendMessageOptions
  ): { id: string; modelString: string; options?: SendMessageOptions } | undefined {
    for (let index = history.length - 1; index >= 0; index -= 1) {
      const message = history[index];
      if (message.role !== "user") {
        continue;
      }
      if (!isCompactionRequestMetadata(message.metadata?.muxMetadata)) {
        return undefined;
      }
      return {
        id: message.id,
        modelString,
        options,
      };
    }
    return undefined;
  }

  private async clearFailedAssistantMessage(messageId: string, reason: string): Promise<void> {
    const [partialResult, deleteMessageResult] = await Promise.all([
      this.partialService.deletePartial(this.workspaceId),
      this.historyService.deleteMessage(this.workspaceId, messageId),
    ]);

    if (!partialResult.success) {
      log.warn("Failed to clear partial before retry", {
        workspaceId: this.workspaceId,
        reason,
        error: partialResult.error,
      });
    }

    if (
      !deleteMessageResult.success &&
      !(
        typeof deleteMessageResult.error === "string" &&
        deleteMessageResult.error.includes("not found in history")
      )
    ) {
      log.warn("Failed to delete failed assistant placeholder", {
        workspaceId: this.workspaceId,
        reason,
        error: deleteMessageResult.error,
      });
    }
  }

  private async finalizeCompactionRetry(messageId: string): Promise<void> {
    this.activeCompactionRequest = undefined;
    this.resetActiveStreamState();
    this.callbacks.emitChatEvent({
      type: "stream-abort",
      workspaceId: this.workspaceId,
      messageId,
    });
    await this.clearFailedAssistantMessage(messageId, "compaction-retry");
  }

  private supports1MContextRetry(modelString: string): boolean {
    const normalized = normalizeGatewayModel(modelString);
    const [provider, modelName] = normalized.split(":", 2);
    const lower = modelName?.toLowerCase() ?? "";
    return (
      provider === "anthropic" &&
      (lower.startsWith("claude-sonnet-4-5") || lower.startsWith("claude-opus-4-6"))
    );
  }

  private withAnthropic1MContext(
    modelString: string,
    options: SendMessageOptions | undefined
  ): SendMessageOptions {
    if (options) {
      const existingModels = options.providerOptions?.anthropic?.use1MContextModels ?? [];
      return {
        ...options,
        providerOptions: {
          ...options.providerOptions,
          anthropic: {
            ...options.providerOptions?.anthropic,
            use1MContext: true,
            use1MContextModels: existingModels.includes(modelString)
              ? existingModels
              : [...existingModels, modelString],
          },
        },
      };
    }

    return {
      model: modelString,
      agentId: WORKSPACE_DEFAULTS.agentId,
      providerOptions: {
        anthropic: {
          use1MContext: true,
          use1MContextModels: [modelString],
        },
      },
    };
  }

  private isGptClassModel(modelString: string): boolean {
    const normalized = normalizeGatewayModel(modelString);
    const [provider, modelName] = normalized.split(":", 2);
    return provider === "openai" && modelName?.toLowerCase().startsWith("gpt-");
  }

  private async maybeRetryCompactionOnContextExceeded(data: {
    messageId: string;
    errorType?: string;
  }): Promise<boolean> {
    if (data.errorType !== "context_exceeded") {
      return false;
    }

    const context = this.activeCompactionRequest;
    if (!context) {
      return false;
    }

    const isGptClass = this.isGptClassModel(context.modelString);
    const is1MCapable = this.supports1MContextRetry(context.modelString);

    if (!isGptClass && !is1MCapable) {
      return false;
    }

    if (is1MCapable) {
      // Skip retry if 1M context is already enabled (via legacy global flag or per-model list)
      const anthropicOpts = context.options?.providerOptions?.anthropic;
      const already1M =
        anthropicOpts?.use1MContext === true ||
        (anthropicOpts?.use1MContextModels?.includes(context.modelString) ?? false);
      if (already1M) {
        return false;
      }
    }

    if (this.compactionRetryAttempts.has(context.id)) {
      return false;
    }

    this.compactionRetryAttempts.add(context.id);

    const retryLabel = is1MCapable ? "Anthropic 1M context" : "OpenAI truncation";
    log.info(`Compaction hit context limit; retrying once with ${retryLabel}`, {
      workspaceId: this.workspaceId,
      model: context.modelString,
      compactionRequestId: context.id,
    });

    await this.finalizeCompactionRetry(data.messageId);

    const retryOptions = is1MCapable
      ? this.withAnthropic1MContext(context.modelString, context.options)
      : context.options;
    this.callbacks.setStreamStarting(true);
    let retryResult: Result<void, SendMessageError>;
    try {
      retryResult = await this.callbacks.streamWithHistory(
        context.modelString,
        retryOptions,
        isGptClass ? "auto" : undefined
      );
    } finally {
      this.callbacks.setStreamStarting(false);
    }
    if (!retryResult.success) {
      log.error("Compaction retry failed to start", {
        workspaceId: this.workspaceId,
        error: retryResult.error,
      });
      return false;
    }

    return true;
  }

  private async maybeRetryWithoutPostCompactionOnContextExceeded(data: {
    messageId: string;
    errorType?: string;
  }): Promise<boolean> {
    if (data.errorType !== "context_exceeded") {
      return false;
    }

    // Only retry if we actually injected post-compaction context.
    if (!this.activeStreamHadPostCompactionInjection) {
      return false;
    }

    // Guardrail: don't retry if we've already emitted any meaningful output.
    if (this.activeStreamHadAnyDelta) {
      return false;
    }

    const requestId = this.activeStreamUserMessageId;
    const context = this.activeStreamContext;
    if (!requestId || !context) {
      return false;
    }

    if (this.postCompactionRetryAttempts.has(requestId)) {
      return false;
    }

    this.postCompactionRetryAttempts.add(requestId);

    log.info("Post-compaction context hit context limit; retrying once without it", {
      workspaceId: this.workspaceId,
      requestId,
      model: context.modelString,
    });

    // The post-compaction diffs are likely the culprit; discard them so we don't loop.
    try {
      await this.compactionHandler.discardPendingDiffs("context_exceeded");
      this.onPostCompactionStateChange?.();
    } catch (error) {
      log.warn("Failed to discard pending post-compaction state", {
        workspaceId: this.workspaceId,
        error: getErrorMessage(error),
      });
    }

    // Abort the failed assistant placeholder and clean up persisted partial/history state.
    this.resetActiveStreamState();
    this.callbacks.emitChatEvent({
      type: "stream-abort",
      workspaceId: this.workspaceId,
      messageId: data.messageId,
    });
    await this.clearFailedAssistantMessage(data.messageId, "post-compaction-retry");

    // Retry the same request, but without post-compaction injection.
    this.callbacks.setStreamStarting(true);
    let retryResult: Result<void, SendMessageError>;
    try {
      retryResult = await this.callbacks.streamWithHistory(
        context.modelString,
        context.options,
        context.openaiTruncationModeOverride,
        true
      );
    } finally {
      this.callbacks.setStreamStarting(false);
    }

    if (!retryResult.success) {
      log.error("Post-compaction retry failed to start", {
        workspaceId: this.workspaceId,
        error: retryResult.error,
      });
      return false;
    }

    return true;
  }

  private async maybeHardRestartExecSubagentOnContextExceeded(data: {
    messageId: string;
    errorType?: string;
  }): Promise<boolean> {
    if (data.errorType !== "context_exceeded") {
      return false;
    }

    // Only enabled via experiment (and only when we still have a valid retry context).
    const context = this.activeStreamContext;
    const requestId = this.activeStreamUserMessageId;
    const experimentEnabled = context?.options?.experiments?.execSubagentHardRestart === true;
    if (!experimentEnabled || !context || !requestId) {
      return false;
    }

    // Guardrail: don't hard-restart after any meaningful output.
    // This is intended to recover from "prompt too long" cases before the model starts streaming.
    if (this.activeStreamHadAnyDelta) {
      return false;
    }

    if (this.execSubagentHardRestartAttempts.has(requestId)) {
      return false;
    }

    // Guard for test mocks that may not implement getWorkspaceMetadata.
    if (typeof this.aiService.getWorkspaceMetadata !== "function") {
      return false;
    }

    const metadataResult = await this.aiService.getWorkspaceMetadata(this.workspaceId);
    if (!metadataResult.success) {
      return false;
    }

    const metadata = metadataResult.data;
    if (!metadata.parentWorkspaceId) {
      return false;
    }

    const agentIdRaw = (metadata.agentId ?? metadata.agentType ?? WORKSPACE_DEFAULTS.agentId)
      .trim()
      .toLowerCase();
    const parsedAgentId = AgentIdSchema.safeParse(agentIdRaw);
    const agentId = parsedAgentId.success ? parsedAgentId.data : ("exec" as const);

    // Prefer resolving agent inheritance from the parent workspace: project agents may be untracked
    // (and therefore absent from child worktrees), but they are always present in the parent that
    // spawned the task.
    const metadataCandidates: Array<typeof metadata> = [metadata];

    try {
      const parentMetadataResult = await this.aiService.getWorkspaceMetadata(
        metadata.parentWorkspaceId
      );
      if (parentMetadataResult.success) {
        metadataCandidates.unshift(parentMetadataResult.data);
      }
    } catch {
      // ignore - fall back to child metadata
    }

    let chain: Awaited<ReturnType<typeof resolveAgentInheritanceChain>> | undefined;
    for (const agentMetadata of metadataCandidates) {
      try {
        const runtime = createRuntimeForWorkspace(agentMetadata);

        // In-place workspaces (CLI/benchmarks) have projectPath === name.
        // Use path directly instead of reconstructing via getWorkspacePath.
        const isInPlace = agentMetadata.projectPath === agentMetadata.name;
        const workspacePath = isInPlace
          ? agentMetadata.projectPath
          : runtime.getWorkspacePath(agentMetadata.projectPath, agentMetadata.name);

        const agentDiscoveryPath =
          context.options?.disableWorkspaceAgents === true
            ? agentMetadata.projectPath
            : workspacePath;

        const agentDefinition = await readAgentDefinition(runtime, agentDiscoveryPath, agentId);
        chain = await resolveAgentInheritanceChain({
          runtime,
          workspacePath: agentDiscoveryPath,
          agentId,
          agentDefinition,
          workspaceId: this.workspaceId,
        });
        break;
      } catch {
        // ignore - try next candidate
      }
    }

    if (!chain) {
      // If we fail to resolve tool policy/inheritance, treat as non-exec-like.
      return false;
    }

    if (!isExecLikeEditingCapableInResolvedChain(chain)) {
      return false;
    }

    this.execSubagentHardRestartAttempts.add(requestId);

    const continuationNotice =
      "Context limit reached. Mux restarted this agent's chat history and will replay your original prompt below. " +
      "Continue using only the current workspace state (files, git history, command output); " +
      "re-inspect the repo as needed.";

    log.info("Exec-like subagent hit context limit; hard-restarting history and retrying", {
      workspaceId: this.workspaceId,
      requestId,
      model: context.modelString,
      agentId,
    });

    const historyResult = await this.historyService.getHistory(this.workspaceId);
    if (!historyResult.success) {
      return false;
    }

    const messages = historyResult.data;

    const firstPromptIndex = messages.findIndex(
      (msg) => msg.role === "user" && msg.metadata?.synthetic !== true
    );
    if (firstPromptIndex === -1) {
      return false;
    }

    // Include any synthetic snapshots that were persisted immediately before the task prompt.
    let seedStartIndex = firstPromptIndex;
    for (let i = firstPromptIndex - 1; i >= 0; i -= 1) {
      const msg = messages[i];
      const isSnapshot =
        msg.role === "user" &&
        msg.metadata?.synthetic === true &&
        (msg.metadata?.fileAtMentionSnapshot ?? msg.metadata?.agentSkillSnapshot);
      if (!isSnapshot) {
        break;
      }
      seedStartIndex = i;
    }

    const seedMessages = messages.slice(seedStartIndex, firstPromptIndex + 1);
    if (seedMessages.length === 0) {
      return false;
    }

    // Best-effort: discard pending post-compaction state so we don't immediately re-inject it.
    try {
      await this.compactionHandler.discardPendingDiffs("execSubagentHardRestart");
      this.onPostCompactionStateChange?.();
    } catch (error) {
      log.warn("Failed to discard pending post-compaction state before hard restart", {
        workspaceId: this.workspaceId,
        error: getErrorMessage(error),
      });
    }

    // Abort the failed assistant placeholder and clean up partial/history state.
    this.activeCompactionRequest = undefined;
    this.resetActiveStreamState();
    if (!this.callbacks.isDisposed()) {
      this.callbacks.clearQueue();
    }

    this.callbacks.emitChatEvent({
      type: "stream-abort",
      workspaceId: this.workspaceId,
      messageId: data.messageId,
    });

    const partialDeleteResult = await this.partialService.deletePartial(this.workspaceId);
    if (!partialDeleteResult.success) {
      log.warn("Failed to delete partial before exec subagent hard restart", {
        workspaceId: this.workspaceId,
        error: partialDeleteResult.error,
      });
    }

    const clearResult = await this.historyService.clearHistory(this.workspaceId);
    if (!clearResult.success) {
      log.warn("Failed to clear history for exec subagent hard restart", {
        workspaceId: this.workspaceId,
        error: clearResult.error,
      });
      return false;
    }

    const deletedSequences = clearResult.data;
    if (deletedSequences.length > 0) {
      const deleteMessage: DeleteMessage = {
        type: "delete",
        historySequences: deletedSequences,
      };
      this.callbacks.emitChatEvent(deleteMessage);
    }

    const cloneForAppend = (msg: MuxMessage): MuxMessage => {
      const metadataCopy = msg.metadata ? { ...msg.metadata } : undefined;
      if (metadataCopy) {
        metadataCopy.historySequence = undefined;
        metadataCopy.partial = undefined;
        metadataCopy.error = undefined;
        metadataCopy.errorType = undefined;
      }

      return {
        ...msg,
        metadata: metadataCopy,
        parts: [...msg.parts],
      };
    };

    const continuationMessage = createMuxMessage(
      createUserMessageId(),
      "user",
      continuationNotice,
      {
        timestamp: Date.now(),
        synthetic: true,
        uiVisible: true,
      }
    );

    const messagesToAppend = [continuationMessage, ...seedMessages.map(cloneForAppend)];
    for (const message of messagesToAppend) {
      const appendResult = await this.historyService.appendToHistory(this.workspaceId, message);
      if (!appendResult.success) {
        log.error("Failed to append message during exec subagent hard restart", {
          workspaceId: this.workspaceId,
          messageId: message.id,
          error: appendResult.error,
        });
        return false;
      }

      // Add type: "message" for discriminated union (MuxMessage doesn't have it)
      this.callbacks.emitChatEvent({
        ...message,
        type: "message" as const,
      });
    }

    const existingInstructions = context.options?.additionalSystemInstructions;
    const mergedAdditionalSystemInstructions = existingInstructions
      ? `${continuationNotice}\n\n${existingInstructions}`
      : continuationNotice;

    const retryOptions: SendMessageOptions | undefined = context.options
      ? {
          ...context.options,
          additionalSystemInstructions: mergedAdditionalSystemInstructions,
        }
      : {
          model: context.modelString,
          agentId: WORKSPACE_DEFAULTS.agentId,
          additionalSystemInstructions: mergedAdditionalSystemInstructions,
          experiments: {
            execSubagentHardRestart: true,
          },
        };

    this.callbacks.setStreamStarting(true);
    let retryResult: Result<void, SendMessageError>;
    try {
      retryResult = await this.callbacks.streamWithHistory(
        context.modelString,
        retryOptions,
        context.openaiTruncationModeOverride
      );
    } finally {
      this.callbacks.setStreamStarting(false);
    }

    if (!retryResult.success) {
      log.error("Exec subagent hard restart retry failed to start", {
        workspaceId: this.workspaceId,
        error: retryResult.error,
      });
      return false;
    }

    return true;
  }
}
