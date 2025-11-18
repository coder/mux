import assert from "@/common/utils/assert";
import { EventEmitter } from "events";
import * as path from "path";
import { PlatformPaths } from "@/common/utils/paths";
import { createMuxMessage } from "@/common/types/message";
import type { Config } from "@/node/config";
import type { AIService } from "@/node/services/aiService";
import type { HistoryService } from "@/node/services/historyService";
import type { PartialService } from "@/node/services/partialService";
import type { InitStateManager } from "@/node/services/initStateManager";
import type { WorkspaceMetadata } from "@/common/types/workspace";
import { DEFAULT_RUNTIME_CONFIG } from "@/common/constants/workspace";
import type {
  WorkspaceChatMessage,
  StreamErrorMessage,
  SendMessageOptions,
  ImagePart,
  DeleteMessage,
} from "@/common/types/ipc";
import type { SendMessageError } from "@/common/types/errors";
import { createUnknownSendMessageError } from "@/node/services/utils/sendMessageError";
import type { Result } from "@/common/types/result";
import { Ok, Err } from "@/common/types/result";
import { enforceThinkingPolicy } from "@/browser/utils/thinking/policy";
import { createRuntime } from "@/node/runtime/runtimeFactory";
import { MessageQueue } from "./messageQueue";
import type { StreamEndEvent, StreamAbortEvent } from "@/common/types/stream";
import { sumUsageHistory } from "@/common/utils/tokens/usageAggregator";
import type { ChatUsageDisplay } from "@/common/utils/tokens/usageAggregator";
import { createDisplayUsage } from "@/common/utils/tokens/tokenStatsCalculator";
import type { LanguageModelV2Usage } from "@ai-sdk/provider";

export interface AgentSessionChatEvent {
  workspaceId: string;
  message: WorkspaceChatMessage;
}

export interface AgentSessionMetadataEvent {
  workspaceId: string;
  metadata: WorkspaceMetadata | null;
}

interface AgentSessionOptions {
  workspaceId: string;
  config: Config;
  historyService: HistoryService;
  partialService: PartialService;
  aiService: AIService;
  initStateManager: InitStateManager;
}

export class AgentSession {
  private readonly workspaceId: string;
  private readonly config: Config;
  private readonly historyService: HistoryService;
  private readonly partialService: PartialService;
  private readonly aiService: AIService;
  private readonly initStateManager: InitStateManager;
  private readonly emitter = new EventEmitter();
  private readonly aiListeners: Array<{ event: string; handler: (...args: unknown[]) => void }> =
    [];
  private readonly initListeners: Array<{ event: string; handler: (...args: unknown[]) => void }> =
    [];
  private disposed = false;
  private readonly messageQueue = new MessageQueue();
  private readonly processedCompactionRequestIds = new Set<string>();

  constructor(options: AgentSessionOptions) {
    assert(options, "AgentSession requires options");
    const { workspaceId, config, historyService, partialService, aiService, initStateManager } =
      options;

    assert(typeof workspaceId === "string", "workspaceId must be a string");
    const trimmedWorkspaceId = workspaceId.trim();
    assert(trimmedWorkspaceId.length > 0, "workspaceId must not be empty");

    this.workspaceId = trimmedWorkspaceId;
    this.config = config;
    this.historyService = historyService;
    this.partialService = partialService;
    this.aiService = aiService;
    this.initStateManager = initStateManager;

    this.attachAiListeners();
    this.attachInitListeners();
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const { event, handler } of this.aiListeners) {
      this.aiService.off(event, handler as never);
    }
    this.aiListeners.length = 0;
    for (const { event, handler } of this.initListeners) {
      this.initStateManager.off(event, handler as never);
    }
    this.initListeners.length = 0;
    this.emitter.removeAllListeners();
  }

  onChatEvent(listener: (event: AgentSessionChatEvent) => void): () => void {
    assert(typeof listener === "function", "listener must be a function");
    this.emitter.on("chat-event", listener);
    return () => {
      this.emitter.off("chat-event", listener);
    };
  }

  onMetadataEvent(listener: (event: AgentSessionMetadataEvent) => void): () => void {
    assert(typeof listener === "function", "listener must be a function");
    this.emitter.on("metadata-event", listener);
    return () => {
      this.emitter.off("metadata-event", listener);
    };
  }

  async subscribeChat(listener: (event: AgentSessionChatEvent) => void): Promise<() => void> {
    this.assertNotDisposed("subscribeChat");
    assert(typeof listener === "function", "listener must be a function");

    const unsubscribe = this.onChatEvent(listener);
    await this.emitHistoricalEvents(listener);

    return unsubscribe;
  }

  async replayHistory(listener: (event: AgentSessionChatEvent) => void): Promise<void> {
    this.assertNotDisposed("replayHistory");
    assert(typeof listener === "function", "listener must be a function");
    await this.emitHistoricalEvents(listener);
  }

  emitMetadata(metadata: WorkspaceMetadata | null): void {
    this.assertNotDisposed("emitMetadata");
    this.emitter.emit("metadata-event", {
      workspaceId: this.workspaceId,
      metadata,
    } satisfies AgentSessionMetadataEvent);
  }

  private async emitHistoricalEvents(
    listener: (event: AgentSessionChatEvent) => void
  ): Promise<void> {
    // Load chat history (persisted messages from chat.jsonl)
    const historyResult = await this.historyService.getHistory(this.workspaceId);
    if (historyResult.success) {
      for (const message of historyResult.data) {
        listener({ workspaceId: this.workspaceId, message });
      }
    }

    // Check for interrupted streams (active streaming state)
    const streamInfo = this.aiService.getStreamInfo(this.workspaceId);
    const partial = await this.partialService.readPartial(this.workspaceId);

    if (streamInfo) {
      await this.aiService.replayStream(this.workspaceId);
    } else if (partial) {
      listener({ workspaceId: this.workspaceId, message: partial });
    }

    // Replay init state BEFORE caught-up (treat as historical data)
    // This ensures init events are buffered correctly by the frontend,
    // preserving their natural timing characteristics from the hook execution.
    await this.initStateManager.replayInit(this.workspaceId);

    // Send caught-up after ALL historical data (including init events)
    // This signals frontend that replay is complete and future events are real-time
    listener({
      workspaceId: this.workspaceId,
      message: { type: "caught-up" },
    });
  }

  async ensureMetadata(args: { workspacePath: string; projectName?: string }): Promise<void> {
    this.assertNotDisposed("ensureMetadata");
    assert(args, "ensureMetadata requires arguments");
    const { workspacePath, projectName } = args;

    assert(typeof workspacePath === "string", "workspacePath must be a string");
    const trimmedWorkspacePath = workspacePath.trim();
    assert(trimmedWorkspacePath.length > 0, "workspacePath must not be empty");

    const normalizedWorkspacePath = path.resolve(trimmedWorkspacePath);
    const existing = await this.aiService.getWorkspaceMetadata(this.workspaceId);

    if (existing.success) {
      // Metadata already exists, verify workspace path matches
      const metadata = existing.data;
      // For in-place workspaces (projectPath === name), use path directly
      // Otherwise reconstruct using runtime's worktree pattern
      const isInPlace = metadata.projectPath === metadata.name;
      const expectedPath = isInPlace
        ? metadata.projectPath
        : (() => {
            const runtime = createRuntime(
              metadata.runtimeConfig ?? { type: "local", srcBaseDir: this.config.srcDir }
            );
            return runtime.getWorkspacePath(metadata.projectPath, metadata.name);
          })();
      assert(
        expectedPath === normalizedWorkspacePath,
        `Existing metadata workspace path mismatch for ${this.workspaceId}: expected ${expectedPath}, got ${normalizedWorkspacePath}`
      );
      return;
    }

    // Detect in-place workspace: if workspacePath is not under srcBaseDir,
    // it's a direct workspace (e.g., for CLI/benchmarks) rather than a worktree
    const srcBaseDir = this.config.srcDir;
    const normalizedSrcBaseDir = path.resolve(srcBaseDir);
    const isUnderSrcBaseDir = normalizedWorkspacePath.startsWith(normalizedSrcBaseDir + path.sep);

    let derivedProjectPath: string;
    let workspaceName: string;
    let derivedProjectName: string;

    if (isUnderSrcBaseDir) {
      // Standard worktree mode: workspace is under ~/.mux/src/project/branch
      derivedProjectPath = path.dirname(normalizedWorkspacePath);
      workspaceName = PlatformPaths.basename(normalizedWorkspacePath);
      derivedProjectName =
        projectName && projectName.trim().length > 0
          ? projectName.trim()
          : PlatformPaths.basename(derivedProjectPath) || "unknown";
    } else {
      // In-place mode: workspace is a standalone directory
      // Store the workspace path directly by setting projectPath === name
      derivedProjectPath = normalizedWorkspacePath;
      workspaceName = normalizedWorkspacePath;
      derivedProjectName =
        projectName && projectName.trim().length > 0
          ? projectName.trim()
          : PlatformPaths.basename(normalizedWorkspacePath) || "unknown";
    }

    const metadata: WorkspaceMetadata = {
      id: this.workspaceId,
      name: workspaceName,
      projectName: derivedProjectName,
      projectPath: derivedProjectPath,
      runtimeConfig: DEFAULT_RUNTIME_CONFIG,
    };

    // Write metadata directly to config.json (single source of truth)
    await this.config.addWorkspace(derivedProjectPath, metadata);
    this.emitMetadata(metadata);
  }

  async sendMessage(
    message: string,
    options?: SendMessageOptions & { imageParts?: ImagePart[] }
  ): Promise<Result<void, SendMessageError>> {
    this.assertNotDisposed("sendMessage");

    assert(typeof message === "string", "sendMessage requires a string message");
    const trimmedMessage = message.trim();
    const imageParts = options?.imageParts;

    if (trimmedMessage.length === 0 && (!imageParts || imageParts.length === 0)) {
      return Err(
        createUnknownSendMessageError(
          "Empty message not allowed. Use interruptStream() to interrupt active streams."
        )
      );
    }

    if (options?.editMessageId) {
      const truncateResult = await this.historyService.truncateAfterMessage(
        this.workspaceId,
        options.editMessageId
      );
      if (!truncateResult.success) {
        return Err(createUnknownSendMessageError(truncateResult.error));
      }
    }

    const messageId = `user-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
    const additionalParts =
      imageParts && imageParts.length > 0
        ? imageParts.map((img, index) => {
            assert(
              typeof img.url === "string",
              `image part [${index}] must include url string content (got ${typeof img.url}): ${JSON.stringify(img).slice(0, 200)}`
            );
            assert(
              img.url.startsWith("data:"),
              `image part [${index}] url must be a data URL (got: ${img.url.slice(0, 50)}...)`
            );
            assert(
              typeof img.mediaType === "string" && img.mediaType.trim().length > 0,
              `image part [${index}] must include a mediaType (got ${typeof img.mediaType}): ${JSON.stringify(img).slice(0, 200)}`
            );
            return {
              type: "file" as const,
              url: img.url,
              mediaType: img.mediaType,
            };
          })
        : undefined;

    const userMessage = createMuxMessage(
      messageId,
      "user",
      message,
      {
        timestamp: Date.now(),
        toolPolicy: options?.toolPolicy,
        muxMetadata: options?.muxMetadata, // Pass through frontend metadata as black-box
      },
      additionalParts
    );

    const appendResult = await this.historyService.appendToHistory(this.workspaceId, userMessage);
    if (!appendResult.success) {
      return Err(createUnknownSendMessageError(appendResult.error));
    }

    this.emitChatEvent(userMessage);

    // If this is a compaction request with a continue message, queue it for auto-send after compaction
    const muxMeta = options?.muxMetadata;
    if (muxMeta?.type === "compaction-request" && muxMeta.parsed.continueMessage && options) {
      // Strip out edit-specific and compaction-specific fields so the queued message is a fresh user message
      const { muxMetadata, mode, editMessageId, ...continueOptions } = options;
      this.messageQueue.add(muxMeta.parsed.continueMessage, continueOptions);
      this.emitQueuedMessageChanged();
    }

    if (!options?.model || options.model.trim().length === 0) {
      return Err(
        createUnknownSendMessageError("No model specified. Please select a model using /model.")
      );
    }

    return this.streamWithHistory(options.model, options);
  }

  async resumeStream(options: SendMessageOptions): Promise<Result<void, SendMessageError>> {
    this.assertNotDisposed("resumeStream");

    assert(options, "resumeStream requires options");
    const { model } = options;
    assert(typeof model === "string" && model.trim().length > 0, "resumeStream requires a model");

    if (this.aiService.isStreaming(this.workspaceId)) {
      return Ok(undefined);
    }

    return this.streamWithHistory(model, options);
  }

  async interruptStream(abandonPartial?: boolean): Promise<Result<void>> {
    this.assertNotDisposed("interruptStream");

    if (!this.aiService.isStreaming(this.workspaceId)) {
      return Ok(undefined);
    }

    const stopResult = await this.aiService.stopStream(this.workspaceId, abandonPartial);
    if (!stopResult.success) {
      return Err(stopResult.error);
    }

    return Ok(undefined);
  }

  private async streamWithHistory(
    modelString: string,
    options?: SendMessageOptions
  ): Promise<Result<void, SendMessageError>> {
    const commitResult = await this.partialService.commitToHistory(this.workspaceId);
    if (!commitResult.success) {
      return Err(createUnknownSendMessageError(commitResult.error));
    }

    const historyResult = await this.historyService.getHistory(this.workspaceId);
    if (!historyResult.success) {
      return Err(createUnknownSendMessageError(historyResult.error));
    }

    // Enforce thinking policy for the specified model (single source of truth)
    // This ensures model-specific requirements are met regardless of where the request originates
    const effectiveThinkingLevel = options?.thinkingLevel
      ? enforceThinkingPolicy(modelString, options.thinkingLevel)
      : undefined;

    return this.aiService.streamMessage(
      historyResult.data,
      this.workspaceId,
      modelString,
      effectiveThinkingLevel,
      options?.toolPolicy,
      undefined,
      options?.additionalSystemInstructions,
      options?.maxOutputTokens,
      options?.providerOptions,
      options?.mode
    );
  }

  private attachAiListeners(): void {
    const forward = (
      event: string,
      handler: (payload: WorkspaceChatMessage) => Promise<void> | void
    ) => {
      const wrapped = (...args: unknown[]) => {
        const [payload] = args;
        if (
          typeof payload === "object" &&
          payload !== null &&
          "workspaceId" in payload &&
          (payload as { workspaceId: unknown }).workspaceId !== this.workspaceId
        ) {
          return;
        }
        void handler(payload as WorkspaceChatMessage);
      };
      this.aiListeners.push({ event, handler: wrapped });
      this.aiService.on(event, wrapped as never);
    };

    forward("stream-start", (payload) => this.emitChatEvent(payload));
    forward("stream-delta", (payload) => this.emitChatEvent(payload));
    forward("tool-call-start", (payload) => this.emitChatEvent(payload));
    forward("tool-call-delta", (payload) => this.emitChatEvent(payload));
    forward("tool-call-end", (payload) => {
      this.emitChatEvent(payload);
      // Tool call completed: auto-send queued messages
      this.sendQueuedMessages();
    });
    forward("reasoning-delta", (payload) => this.emitChatEvent(payload));
    forward("reasoning-end", (payload) => this.emitChatEvent(payload));

    forward("stream-end", async (payload) => {
      const handled = await this.handleCompactionCompletion(payload as StreamEndEvent);
      if (!handled) {
        this.emitChatEvent(payload);
      }
      // Stream end: auto-send queued messages
      this.sendQueuedMessages();
    });

    forward("stream-abort", async (payload) => {
      const handled = await this.handleCompactionAbort(payload as StreamAbortEvent);
      if (!handled) {
        this.emitChatEvent(payload);
      }

      // Stream aborted: restore queued messages to input
      if (!this.messageQueue.isEmpty()) {
        const displayText = this.messageQueue.getDisplayText();
        const imageParts = this.messageQueue.getImageParts();
        this.messageQueue.clear();
        this.emitQueuedMessageChanged();

        this.emitChatEvent({
          type: "restore-to-input",
          workspaceId: this.workspaceId,
          text: displayText,
          imageParts: imageParts,
        });
      }
    });

    const errorHandler = (...args: unknown[]) => {
      const [raw] = args;
      if (
        typeof raw !== "object" ||
        raw === null ||
        !("workspaceId" in raw) ||
        (raw as { workspaceId: unknown }).workspaceId !== this.workspaceId
      ) {
        return;
      }
      const data = raw as {
        workspaceId: string;
        messageId: string;
        error: string;
        errorType?: string;
      };
      const streamError: StreamErrorMessage = {
        type: "stream-error",
        messageId: data.messageId,
        error: data.error,
        errorType: (data.errorType ?? "unknown") as StreamErrorMessage["errorType"],
      };
      this.emitChatEvent(streamError);
    };

    this.aiListeners.push({ event: "error", handler: errorHandler });
    this.aiService.on("error", errorHandler as never);
  }

  private attachInitListeners(): void {
    const forward = (event: string, handler: (payload: WorkspaceChatMessage) => void) => {
      const wrapped = (...args: unknown[]) => {
        const [payload] = args;
        if (
          typeof payload === "object" &&
          payload !== null &&
          "workspaceId" in payload &&
          (payload as { workspaceId: unknown }).workspaceId !== this.workspaceId
        ) {
          return;
        }
        // Strip workspaceId from payload before forwarding (WorkspaceInitEvent doesn't include it)
        const { workspaceId: _, ...message } = payload as WorkspaceChatMessage & {
          workspaceId: string;
        };
        handler(message as WorkspaceChatMessage);
      };
      this.initListeners.push({ event, handler: wrapped });
      this.initStateManager.on(event, wrapped as never);
    };

    forward("init-start", (payload) => this.emitChatEvent(payload));
    forward("init-output", (payload) => this.emitChatEvent(payload));
    forward("init-end", (payload) => this.emitChatEvent(payload));
  }

  // Public method to emit chat events (used by init hooks and other workspace events)
  emitChatEvent(message: WorkspaceChatMessage): void {
    this.assertNotDisposed("emitChatEvent");
    this.emitter.emit("chat-event", {
      workspaceId: this.workspaceId,
      message,
    } satisfies AgentSessionChatEvent);
  }

  queueMessage(message: string, options?: SendMessageOptions & { imageParts?: ImagePart[] }): void {
    this.assertNotDisposed("queueMessage");
    this.messageQueue.add(message, options);
    this.emitQueuedMessageChanged();
  }

  clearQueue(): void {
    this.assertNotDisposed("clearQueue");
    this.messageQueue.clear();
    this.emitQueuedMessageChanged();
  }

  private emitQueuedMessageChanged(): void {
    this.emitChatEvent({
      type: "queued-message-changed",
      workspaceId: this.workspaceId,
      queuedMessages: this.messageQueue.getMessages(),
      displayText: this.messageQueue.getDisplayText(),
      imageParts: this.messageQueue.getImageParts(),
    });
  }

  /**
   * Send queued messages if any exist.
   * Called when tool execution completes or stream ends.
   */
  private sendQueuedMessages(): void {
    if (!this.messageQueue.isEmpty()) {
      const { message, options } = this.messageQueue.produceMessage();
      this.messageQueue.clear();
      this.emitQueuedMessageChanged();

      void this.sendMessage(message, options);
    }
  }

  private assertNotDisposed(operation: string): void {
    assert(!this.disposed, `AgentSession.${operation} called after dispose`);
  }

  /**
   * Handle compaction stream abort (Ctrl+C cancel or Ctrl+A accept early)
   *
   * Two flows:
   * - Ctrl+C: abandonPartial=true → skip compaction
   * - Ctrl+A: abandonPartial=false/undefined → perform compaction with [truncated]
   */
  private async handleCompactionAbort(event: StreamAbortEvent): Promise<boolean> {
    // Check if the last user message is a compaction-request
    const historyResult = await this.historyService.getHistory(this.workspaceId);
    if (!historyResult.success) {
      return false;
    }

    const messages = historyResult.data;
    const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
    const isCompaction = lastUserMsg?.metadata?.muxMetadata?.type === "compaction-request";

    if (!isCompaction || !lastUserMsg) {
      return false;
    }

    // Ctrl+C flow: abandonPartial=true means user cancelled, skip compaction
    if (event.abandonPartial === true) {
      return false;
    }

    // Ctrl+A flow: Accept early with [truncated] sentinel
    // Get the truncated message from historyResult.data
    const lastMessage = messages[messages.length - 1];
    if (!lastMessage || lastMessage.role !== "assistant") {
      console.warn("[AgentSession] Compaction aborted but last message is not assistant");
      return false;
    }

    const partialSummary = lastMessage.parts
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map((part) => part.text)
      .join("");

    // Append [truncated] sentinel
    const truncatedSummary = partialSummary.trim() + "\n\n[truncated]";

    // Perform compaction with truncated summary
    const result = await this.performCompaction(truncatedSummary, {
      model: lastMessage.metadata?.model ?? "unknown",
      usage: event.metadata?.usage,
      duration: event.metadata?.duration,
      providerMetadata: lastMessage.metadata?.providerMetadata,
      systemMessageTokens: lastMessage.metadata?.systemMessageTokens,
    });
    if (!result.success) {
      console.error("[AgentSession] Early compaction failed:", result.error);
      return false;
    }

    this.emitChatEvent(event);
    return true;
  }

  /**
   * Handle compaction stream completion
   *
   * Detects when a compaction stream finishes, extracts the summary,
   * and performs history replacement atomically.
   */
  private async handleCompactionCompletion(event: StreamEndEvent): Promise<boolean> {
    // Check if the last user message is a compaction-request
    const historyResult = await this.historyService.getHistory(this.workspaceId);
    if (!historyResult.success) {
      return false;
    }

    const messages = historyResult.data;
    const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
    const isCompaction = lastUserMsg?.metadata?.muxMetadata?.type === "compaction-request";

    if (!isCompaction || !lastUserMsg) {
      return false;
    }

    // Dedupe: If we've already processed this compaction-request, skip
    if (this.processedCompactionRequestIds.has(lastUserMsg.id)) {
      return true;
    }

    const summary = event.parts
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map((part) => part.text)
      .join("");

    // Mark as processed before performing compaction
    this.processedCompactionRequestIds.add(lastUserMsg.id);

    const result = await this.performCompaction(summary, event.metadata);
    if (!result.success) {
      console.error("[AgentSession] Compaction failed:", result.error);
      return false;
    }

    // Emit stream-end to frontend so UI knows compaction is complete
    this.emitCompactionStreamEnd(event);
    return true;
  }

  /**
   * Perform history compaction by replacing all messages with a summary
   *
   * Steps:
   * 1. Calculate cumulative usage from all messages (for historicalUsage field)
   * 2. Clear entire history and get deleted sequence numbers
   * 3. Append summary message with metadata
   * 4. Emit delete event for old messages
   * 5. Emit summary message to frontend
   */
  private async performCompaction(
    summary: string,
    metadata: {
      model: string;
      usage?: LanguageModelV2Usage;
      duration?: number;
      providerMetadata?: Record<string, unknown>;
      systemMessageTokens?: number;
    }
  ): Promise<Result<void, string>> {
    // Get all messages to calculate cumulative usage
    const historyResult = await this.historyService.getHistory(this.workspaceId);
    if (!historyResult.success) {
      return Err(`Failed to get history for usage calculation: ${historyResult.error}`);
    }

    // Calculate cumulative historical usage from all messages
    const usageHistory: ChatUsageDisplay[] = [];
    let cumulativeHistorical: ChatUsageDisplay | undefined;

    for (const msg of historyResult.data) {
      if (msg.role === "assistant") {
        // Accumulate historical usage from previous compactions
        if (msg.metadata?.historicalUsage) {
          cumulativeHistorical = msg.metadata.historicalUsage;
        }

        // Add current message's usage
        if (msg.metadata?.usage && msg.metadata.model) {
          const displayUsage = createDisplayUsage(
            msg.metadata.usage,
            msg.metadata.model,
            msg.metadata.providerMetadata
          );
          if (displayUsage) {
            usageHistory.push(displayUsage);
          }
        }
      }
    }

    // If we have historical usage from a compaction, prepend it to history
    // This ensures costs from pre-compaction messages are included in totals
    if (cumulativeHistorical) {
      usageHistory.unshift(cumulativeHistorical);
    }

    const historicalUsage = usageHistory.length > 0 ? sumUsageHistory(usageHistory) : undefined;

    // Clear entire history and get deleted sequences
    const clearResult = await this.historyService.clearHistory(this.workspaceId);
    if (!clearResult.success) {
      return Err(`Failed to clear history: ${clearResult.error}`);
    }
    const deletedSequences = clearResult.data;

    // Create summary message with metadata
    const summaryMessage = createMuxMessage(
      `summary-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
      "assistant",
      summary,
      {
        timestamp: Date.now(),
        compacted: true,
        model: metadata.model,
        usage: metadata.usage,
        historicalUsage,
        providerMetadata: metadata.providerMetadata,
        duration: metadata.duration,
        systemMessageTokens: metadata.systemMessageTokens,
        muxMetadata: { type: "normal" },
      }
    );

    // Append summary to history
    const appendResult = await this.historyService.appendToHistory(
      this.workspaceId,
      summaryMessage
    );
    if (!appendResult.success) {
      return Err(`Failed to append summary: ${appendResult.error}`);
    }

    // Emit delete event for old messages
    if (deletedSequences.length > 0) {
      const deleteMessage: DeleteMessage = {
        type: "delete",
        historySequences: deletedSequences,
      };
      this.emitChatEvent(deleteMessage);
    }

    // Emit summary message to frontend
    this.emitChatEvent(summaryMessage);

    return Ok(undefined);
  }

  /**
   * Emit stream-end event after compaction completes
   * This notifies the frontend that the stream is done
   */
  private emitCompactionStreamEnd(event: StreamEndEvent): void {
    this.emitChatEvent(event);
  }
}
