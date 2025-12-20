import assert from "@/common/utils/assert";
import { EventEmitter } from "events";
import * as path from "path";
import { stat, readFile } from "fs/promises";
import { PlatformPaths } from "@/common/utils/paths";
import { log } from "@/node/services/log";
import { createMuxMessage } from "@/common/types/message";
import type { Config } from "@/node/config";
import type { AIService } from "@/node/services/aiService";
import type { HistoryService } from "@/node/services/historyService";
import type { PartialService } from "@/node/services/partialService";
import type { InitStateManager } from "@/node/services/initStateManager";

import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import type { RuntimeConfig } from "@/common/types/runtime";
import { DEFAULT_RUNTIME_CONFIG } from "@/common/constants/workspace";
import type {
  WorkspaceChatMessage,
  StreamErrorMessage,
  SendMessageOptions,
  ImagePart,
} from "@/common/orpc/types";
import type { SendMessageError } from "@/common/types/errors";
import { createUnknownSendMessageError } from "@/node/services/utils/sendMessageError";
import type { Result } from "@/common/types/result";
import { Ok, Err } from "@/common/types/result";
import { enforceThinkingPolicy } from "@/common/utils/thinking/policy";
import type { MuxFrontendMetadata, ContinueMessage } from "@/common/types/message";
import { prepareUserMessageForSend } from "@/common/types/message";
import { createRuntime } from "@/node/runtime/runtimeFactory";
import { MessageQueue } from "./messageQueue";
import type { StreamEndEvent } from "@/common/types/stream";
import { CompactionHandler } from "./compactionHandler";
import type { TelemetryService } from "./telemetryService";
import type { BackgroundProcessManager } from "./backgroundProcessManager";
import { computeDiff } from "@/node/utils/diff";
import { AttachmentService } from "./attachmentService";
import type { PostCompactionAttachment, PostCompactionExclusions } from "@/common/types/attachment";
import { TURNS_BETWEEN_ATTACHMENTS } from "@/common/constants/attachments";
import { extractEditedFileDiffs } from "@/common/utils/messages/extractEditedFiles";
import { isValidModelFormat } from "@/common/utils/ai/models";

/**
 * Tracked file state for detecting external edits.
 * Uses timestamp-based polling with diff injection.
 */
export interface FileState {
  content: string;
  timestamp: number; // mtime in ms
}

/**
 * Attachment for files that were edited externally between messages.
 */
export interface EditedFileAttachment {
  type: "edited_text_file";
  filename: string;
  snippet: string; // diff of changes
}

// Type guard for compaction request metadata
interface CompactionRequestMetadata {
  type: "compaction-request";
  parsed: {
    continueMessage?: ContinueMessage;
  };
}

function isCompactionRequestMetadata(meta: unknown): meta is CompactionRequestMetadata {
  if (typeof meta !== "object" || meta === null) return false;
  const obj = meta as Record<string, unknown>;
  if (obj.type !== "compaction-request") return false;
  if (typeof obj.parsed !== "object" || obj.parsed === null) return false;
  return true;
}

export interface AgentSessionChatEvent {
  workspaceId: string;
  message: WorkspaceChatMessage;
}

export interface AgentSessionMetadataEvent {
  workspaceId: string;
  metadata: FrontendWorkspaceMetadata | null;
}

interface AgentSessionOptions {
  workspaceId: string;
  config: Config;
  historyService: HistoryService;
  partialService: PartialService;
  aiService: AIService;
  initStateManager: InitStateManager;
  telemetryService?: TelemetryService;
  backgroundProcessManager: BackgroundProcessManager;
  /** Called when compaction completes (e.g., to clear idle compaction pending state) */
  onCompactionComplete?: () => void;
  /** Called when post-compaction context state may have changed (plan/file edits) */
  onPostCompactionStateChange?: () => void;
}

export class AgentSession {
  private readonly workspaceId: string;
  private readonly config: Config;
  private readonly historyService: HistoryService;
  private readonly partialService: PartialService;
  private readonly aiService: AIService;
  private readonly initStateManager: InitStateManager;
  private readonly backgroundProcessManager: BackgroundProcessManager;
  private readonly onCompactionComplete?: () => void;
  private readonly onPostCompactionStateChange?: () => void;
  private readonly emitter = new EventEmitter();
  private readonly aiListeners: Array<{ event: string; handler: (...args: unknown[]) => void }> =
    [];
  private readonly initListeners: Array<{ event: string; handler: (...args: unknown[]) => void }> =
    [];
  private disposed = false;
  private readonly messageQueue = new MessageQueue();
  private readonly compactionHandler: CompactionHandler;

  /**
   * Tracked file state for detecting external edits.
   * Key: absolute file path, Value: last known content and mtime.
   */
  private readonly readFileState = new Map<string, FileState>();

  /**
   * Track turns since last post-compaction attachment injection.
   * Start at max to trigger immediate injection on first turn after compaction.
   */
  private turnsSinceLastAttachment = TURNS_BETWEEN_ATTACHMENTS;

  /**
   * Flag indicating compaction has occurred in this session.
   * Used to enable the cooldown-based attachment injection.
   */
  private compactionOccurred = false;
  /**
   * Cache the last-known experiment state so we don't spam metadata refresh
   * when post-compaction context is disabled.
   */
  private postCompactionContextEnabled = false;

  constructor(options: AgentSessionOptions) {
    assert(options, "AgentSession requires options");
    const {
      workspaceId,
      config,
      historyService,
      partialService,
      aiService,
      initStateManager,
      telemetryService,
      backgroundProcessManager,
      onCompactionComplete,
      onPostCompactionStateChange,
    } = options;

    assert(typeof workspaceId === "string", "workspaceId must be a string");
    const trimmedWorkspaceId = workspaceId.trim();
    assert(trimmedWorkspaceId.length > 0, "workspaceId must not be empty");

    this.workspaceId = trimmedWorkspaceId;
    this.config = config;
    this.historyService = historyService;
    this.partialService = partialService;
    this.aiService = aiService;
    this.initStateManager = initStateManager;
    this.backgroundProcessManager = backgroundProcessManager;
    this.onCompactionComplete = onCompactionComplete;
    this.onPostCompactionStateChange = onPostCompactionStateChange;

    this.compactionHandler = new CompactionHandler({
      workspaceId: this.workspaceId,
      historyService: this.historyService,
      telemetryService,
      partialService: this.partialService,
      emitter: this.emitter,
      onCompactionComplete,
    });

    this.attachAiListeners();
    this.attachInitListeners();
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;

    // Stop any active stream (fire and forget - disposal shouldn't block)
    void this.aiService.stopStream(this.workspaceId, { abandonPartial: true });
    // Terminate background processes for this workspace
    void this.backgroundProcessManager.cleanup(this.workspaceId);

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

  emitMetadata(metadata: FrontendWorkspaceMetadata | null): void {
    this.assertNotDisposed("emitMetadata");
    this.emitter.emit("metadata-event", {
      workspaceId: this.workspaceId,
      metadata,
    } satisfies AgentSessionMetadataEvent);
  }

  private async emitHistoricalEvents(
    listener: (event: AgentSessionChatEvent) => void
  ): Promise<void> {
    // try/catch/finally guarantees caught-up is always sent, even if replay fails.
    // Without caught-up, the frontend stays in "Loading workspace..." forever.
    try {
      // Read partial BEFORE iterating history so we can skip the corresponding
      // placeholder message (which has empty parts). The partial has the real content.
      const streamInfo = this.aiService.getStreamInfo(this.workspaceId);
      const partial = await this.partialService.readPartial(this.workspaceId);
      const partialHistorySequence = partial?.metadata?.historySequence;

      // Load chat history (persisted messages from chat.jsonl)
      const historyResult = await this.historyService.getHistory(this.workspaceId);
      if (historyResult.success) {
        for (const message of historyResult.data) {
          // Skip the placeholder message if we have a partial with the same historySequence.
          // The placeholder has empty parts; the partial has the actual content.
          // Without this, both get loaded and the empty placeholder may be shown as "last message".
          if (
            partialHistorySequence !== undefined &&
            message.metadata?.historySequence === partialHistorySequence
          ) {
            continue;
          }
          // Add type: "message" for discriminated union (messages from chat.jsonl don't have it)
          listener({ workspaceId: this.workspaceId, message: { ...message, type: "message" } });
        }
      }

      if (streamInfo) {
        await this.aiService.replayStream(this.workspaceId);
      } else if (partial) {
        // Add type: "message" for discriminated union (partials from disk don't have it)
        listener({ workspaceId: this.workspaceId, message: { ...partial, type: "message" } });
      }

      // Replay init state BEFORE caught-up (treat as historical data)
      // This ensures init events are buffered correctly by the frontend,
      // preserving their natural timing characteristics from the hook execution.
      await this.initStateManager.replayInit(this.workspaceId);
    } catch (error) {
      log.error("Failed to replay history for workspace", {
        workspaceId: this.workspaceId,
        error,
      });
    } finally {
      // Send caught-up after ALL historical data (including init events)
      // This signals frontend that replay is complete and future events are real-time
      listener({
        workspaceId: this.workspaceId,
        message: { type: "caught-up" },
      });
    }
  }

  async ensureMetadata(args: {
    workspacePath: string;
    projectName?: string;
    runtimeConfig?: RuntimeConfig;
  }): Promise<void> {
    this.assertNotDisposed("ensureMetadata");
    assert(args, "ensureMetadata requires arguments");
    const { workspacePath, projectName, runtimeConfig } = args;

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
              metadata.runtimeConfig ?? { type: "local", srcBaseDir: this.config.srcDir },
              { projectPath: metadata.projectPath }
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

    const metadata: FrontendWorkspaceMetadata = {
      id: this.workspaceId,
      name: workspaceName,
      projectName: derivedProjectName,
      projectPath: derivedProjectPath,
      namedWorkspacePath: normalizedWorkspacePath,
      runtimeConfig: runtimeConfig ?? DEFAULT_RUNTIME_CONFIG,
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
      // Interrupt an existing stream or compaction, if active
      if (this.aiService.isStreaming(this.workspaceId)) {
        // MUST use abandonPartial=true to prevent handleAbort from performing partial compaction
        // with mismatched history (since we're about to truncate it)
        const stopResult = await this.interruptStream({ abandonPartial: true });
        if (!stopResult.success) {
          return Err(createUnknownSendMessageError(stopResult.error));
        }
      }
      const truncateResult = await this.historyService.truncateAfterMessage(
        this.workspaceId,
        options.editMessageId
      );
      if (!truncateResult.success) {
        const isMissingEditTarget =
          truncateResult.error.includes("Message with ID") &&
          truncateResult.error.includes("not found in history");
        if (isMissingEditTarget) {
          // This can happen if the frontend is briefly out-of-sync with persisted history
          // (e.g., compaction/truncation completed and removed the message while the UI still
          // shows it as editable). Treat as a no-op truncation so the user can recover.
          log.warn("editMessageId not found in history; proceeding without truncation", {
            workspaceId: this.workspaceId,
            editMessageId: options.editMessageId,
            error: truncateResult.error,
          });
        } else {
          return Err(createUnknownSendMessageError(truncateResult.error));
        }
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

    // toolPolicy is properly typed via Zod schema inference
    const typedToolPolicy = options?.toolPolicy;
    // muxMetadata is z.any() in schema - cast to proper type
    const typedMuxMetadata = options?.muxMetadata as MuxFrontendMetadata | undefined;

    // Validate model BEFORE persisting message to prevent orphaned messages on invalid model
    if (!options?.model || options.model.trim().length === 0) {
      return Err(
        createUnknownSendMessageError("No model specified. Please select a model using /model.")
      );
    }

    // Validate model string format (must be "provider:model-id")
    if (!isValidModelFormat(options.model)) {
      return Err({
        type: "invalid_model_string",
        message: `Invalid model string format: "${options.model}". Expected "provider:model-id"`,
      });
    }

    const userMessage = createMuxMessage(
      messageId,
      "user",
      message,
      {
        timestamp: Date.now(),
        toolPolicy: typedToolPolicy,
        muxMetadata: typedMuxMetadata, // Pass through frontend metadata as black-box
      },
      additionalParts
    );

    const appendResult = await this.historyService.appendToHistory(this.workspaceId, userMessage);
    if (!appendResult.success) {
      return Err(createUnknownSendMessageError(appendResult.error));
    }

    // Workspace may be tearing down while we await filesystem IO.
    // If so, skip event emission + streaming to avoid races with dispose().
    if (this.disposed) {
      return Ok(undefined);
    }

    // Add type: "message" for discriminated union (createMuxMessage doesn't add it)
    this.emitChatEvent({ ...userMessage, type: "message" });

    // If this is a compaction request, terminate background processes first
    // They won't be included in the summary, so continuing with orphaned processes would be confusing
    if (isCompactionRequestMetadata(typedMuxMetadata)) {
      await this.backgroundProcessManager.cleanup(this.workspaceId);

      if (this.disposed) {
        return Ok(undefined);
      }
    }

    // If this is a compaction request with a continue message, queue it for auto-send after compaction
    if (
      isCompactionRequestMetadata(typedMuxMetadata) &&
      typedMuxMetadata.parsed.continueMessage &&
      options
    ) {
      const continueMessage = typedMuxMetadata.parsed.continueMessage;

      // Process the continue message content (handles reviews -> text formatting + metadata)
      const { finalText, metadata } = prepareUserMessageForSend(continueMessage);

      // Build options for the queued message (strip compaction-specific fields)
      const sanitizedOptions: Omit<
        SendMessageOptions,
        "muxMetadata" | "mode" | "editMessageId" | "imageParts" | "maxOutputTokens"
      > & { imageParts?: typeof continueMessage.imageParts; muxMetadata?: typeof metadata } = {
        model: continueMessage.model ?? options.model,
        thinkingLevel: options.thinkingLevel,
        toolPolicy: options.toolPolicy,
        additionalSystemInstructions: options.additionalSystemInstructions,
        providerOptions: options.providerOptions,
        experiments: options.experiments,
      };

      // Add image parts if present
      const continueImageParts = continueMessage.imageParts;
      if (continueImageParts && continueImageParts.length > 0) {
        sanitizedOptions.imageParts = continueImageParts;
      }

      // Add metadata with reviews if present
      if (metadata) {
        sanitizedOptions.muxMetadata = metadata;
      }

      this.messageQueue.add(finalText, sanitizedOptions);
      this.emitQueuedMessageChanged();
    }

    if (this.disposed) {
      return Ok(undefined);
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

  async interruptStream(options?: {
    soft?: boolean;
    abandonPartial?: boolean;
  }): Promise<Result<void>> {
    this.assertNotDisposed("interruptStream");

    if (!this.aiService.isStreaming(this.workspaceId)) {
      return Ok(undefined);
    }

    // For hard interrupts, delete partial BEFORE stopping to prevent abort handler
    // from committing it. For soft interrupts, defer to stream-abort handler since
    // the stream continues running and would recreate the partial.
    if (options?.abandonPartial && !options?.soft) {
      const deleteResult = await this.partialService.deletePartial(this.workspaceId);
      if (!deleteResult.success) {
        return Err(deleteResult.error);
      }
    }

    const stopResult = await this.aiService.stopStream(this.workspaceId, options);
    if (!stopResult.success) {
      return Err(stopResult.error);
    }

    return Ok(undefined);
  }

  private async streamWithHistory(
    modelString: string,
    options?: SendMessageOptions
  ): Promise<Result<void, SendMessageError>> {
    if (this.disposed) {
      return Ok(undefined);
    }

    const commitResult = await this.partialService.commitToHistory(this.workspaceId);
    if (!commitResult.success) {
      return Err(createUnknownSendMessageError(commitResult.error));
    }

    const historyResult = await this.historyService.getHistory(this.workspaceId);
    // Cache whether post-compaction context is enabled for this session.
    // Used to decide whether tool-call-end should trigger metadata refresh.
    this.postCompactionContextEnabled = Boolean(options?.experiments?.postCompactionContext);

    if (!historyResult.success) {
      return Err(createUnknownSendMessageError(historyResult.error));
    }
    if (historyResult.data.length === 0) {
      return Err(
        createUnknownSendMessageError(
          "Cannot resume stream: workspace history is empty. Send a new message instead."
        )
      );
    }

    // Check for external file edits (timestamp-based polling)
    const changedFileAttachments = await this.getChangedFileAttachments();

    // Check if post-compaction attachments should be injected (gated by experiment)
    const postCompactionAttachments = options?.experiments?.postCompactionContext
      ? await this.getPostCompactionAttachmentsIfNeeded()
      : null;

    // Enforce thinking policy for the specified model (single source of truth)
    // This ensures model-specific requirements are met regardless of where the request originates
    const effectiveThinkingLevel = options?.thinkingLevel
      ? enforceThinkingPolicy(modelString, options.thinkingLevel)
      : undefined;

    // Bind recordFileState to this session for the propose_plan tool
    const recordFileState = this.recordFileState.bind(this);

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
      options?.mode,
      recordFileState,
      changedFileAttachments.length > 0 ? changedFileAttachments : undefined,
      postCompactionAttachments,
      options?.experiments
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
    forward("bash-output", (payload) => this.emitChatEvent(payload));
    forward("tool-call-delta", (payload) => this.emitChatEvent(payload));
    forward("tool-call-end", (payload) => {
      this.emitChatEvent(payload);

      // If post-compaction context is enabled, certain tools can change what should
      // be displayed/injected (plan writes, tracked file diffs). Trigger a metadata
      // refresh so the right sidebar updates without requiring an experiment toggle.
      if (
        this.postCompactionContextEnabled &&
        payload.type === "tool-call-end" &&
        (payload.toolName === "propose_plan" || payload.toolName.startsWith("file_edit_"))
      ) {
        this.onPostCompactionStateChange?.();
      }

      // Tool call completed: auto-send queued messages
      this.sendQueuedMessages();
    });
    forward("reasoning-delta", (payload) => this.emitChatEvent(payload));
    forward("reasoning-end", (payload) => this.emitChatEvent(payload));
    forward("usage-delta", (payload) => this.emitChatEvent(payload));
    forward("stream-abort", (payload) => this.emitChatEvent(payload));

    forward("stream-end", async (payload) => {
      const handled = await this.compactionHandler.handleCompletion(payload as StreamEndEvent);
      if (!handled) {
        this.emitChatEvent(payload);
      } else {
        // Compaction completed - notify to trigger metadata refresh
        // This allows the frontend to get updated postCompaction state
        this.onCompactionComplete?.();
      }
      // Stream end: auto-send queued messages
      this.sendQueuedMessages();
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
    // NOTE: Workspace teardown does not await in-flight async work (sendMessage(), stopStream(), etc).
    // Those code paths can still try to emit events after dispose; drop them rather than crashing.
    if (this.disposed) {
      return;
    }

    this.emitter.emit("chat-event", {
      workspaceId: this.workspaceId,
      message,
    } satisfies AgentSessionChatEvent);
  }

  queueMessage(message: string, options?: SendMessageOptions & { imageParts?: ImagePart[] }): void {
    this.assertNotDisposed("queueMessage");
    this.messageQueue.add(message, options);
    this.emitQueuedMessageChanged();
    // Signal to bash_output that it should return early to process the queued message
    this.backgroundProcessManager.setMessageQueued(this.workspaceId, true);
  }

  clearQueue(): void {
    this.assertNotDisposed("clearQueue");
    this.messageQueue.clear();
    this.emitQueuedMessageChanged();
    this.backgroundProcessManager.setMessageQueued(this.workspaceId, false);
  }

  /**
   * Restore queued messages to input box.
   * Called by IPC handler on user-initiated interrupt.
   */
  restoreQueueToInput(): void {
    this.assertNotDisposed("restoreQueueToInput");
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
  }

  private emitQueuedMessageChanged(): void {
    this.emitChatEvent({
      type: "queued-message-changed",
      workspaceId: this.workspaceId,
      queuedMessages: this.messageQueue.getMessages(),
      displayText: this.messageQueue.getDisplayText(),
      imageParts: this.messageQueue.getImageParts(),
      reviews: this.messageQueue.getReviews(),
    });
  }

  /**
   * Send queued messages if any exist.
   * Called when tool execution completes, stream ends, or user clicks send immediately.
   */
  sendQueuedMessages(): void {
    // sendQueuedMessages can race with teardown (e.g. workspace.remove) because we
    // trigger it off stream/tool events and disposal does not await stopStream().
    // If the session is already disposed, do nothing.
    if (this.disposed) {
      return;
    }

    // Clear the queued message flag (even if queue is empty, to handle race conditions)
    this.backgroundProcessManager.setMessageQueued(this.workspaceId, false);

    if (!this.messageQueue.isEmpty()) {
      const { message, options } = this.messageQueue.produceMessage();
      this.messageQueue.clear();
      this.emitQueuedMessageChanged();

      void this.sendMessage(message, options);
    }
  }

  /**
   * Record file state for change detection.
   * Called by tools (e.g., propose_plan) after reading/writing files.
   */
  recordFileState(filePath: string, state: FileState): void {
    this.readFileState.set(filePath, state);
  }

  /**
   * Get the count of tracked files for UI display.
   */
  getTrackedFilesCount(): number {
    return this.readFileState.size;
  }

  /**
   * Get the paths of tracked files for UI display.
   */
  getTrackedFilePaths(): string[] {
    return Array.from(this.readFileState.keys());
  }

  /**
   * Clear all tracked file state (e.g., on /clear).
   */
  clearFileState(): void {
    this.readFileState.clear();
  }

  /**
   * Get post-compaction attachments if they should be injected this turn.
   *
   * Logic:
   * - On first turn after compaction: inject immediately, clear file state cache
   * - Subsequent turns: inject every TURNS_BETWEEN_ATTACHMENTS turns
   *
   * @returns Attachments to inject, or null if none needed
   */
  private async getPostCompactionAttachmentsIfNeeded(): Promise<PostCompactionAttachment[] | null> {
    // Check if compaction just occurred (immediate injection with cached diffs)
    const pendingDiffs = this.compactionHandler.consumePendingDiffs();
    if (pendingDiffs !== null) {
      this.compactionOccurred = true;
      this.turnsSinceLastAttachment = 0;
      // Clear file state cache since history context is gone
      this.readFileState.clear();

      // Get runtime for reading plan file
      const metadataResult = await this.aiService.getWorkspaceMetadata(this.workspaceId);
      if (!metadataResult.success) {
        // Can't get metadata, skip plan reference but still include file diffs
        return [
          AttachmentService.generateEditedFilesAttachment(pendingDiffs) ?? [],
        ].flat() as PostCompactionAttachment[];
      }
      const runtime = createRuntime(
        metadataResult.data.runtimeConfig ?? { type: "local", srcBaseDir: this.config.srcDir },
        { projectPath: metadataResult.data.projectPath }
      );

      // Load exclusions and use cached diffs extracted before history was cleared
      const excludedItems = await this.loadExcludedItems();
      return AttachmentService.generatePostCompactionAttachments(
        metadataResult.data.name,
        metadataResult.data.projectName,
        this.workspaceId,
        pendingDiffs,
        runtime,
        excludedItems
      );
    }

    // Increment turn counter
    this.turnsSinceLastAttachment++;

    // Check cooldown for subsequent injections (re-read from current history)
    if (this.compactionOccurred && this.turnsSinceLastAttachment >= TURNS_BETWEEN_ATTACHMENTS) {
      this.turnsSinceLastAttachment = 0;
      return this.generatePostCompactionAttachments();
    }

    return null;
  }

  /**
   * Generate post-compaction attachments by extracting diffs from message history.
   */
  private async generatePostCompactionAttachments(): Promise<PostCompactionAttachment[]> {
    const historyResult = await this.historyService.getHistory(this.workspaceId);
    if (!historyResult.success) {
      return [];
    }
    const fileDiffs = extractEditedFileDiffs(historyResult.data);

    // Get runtime for reading plan file
    const metadataResult = await this.aiService.getWorkspaceMetadata(this.workspaceId);
    if (!metadataResult.success) {
      // Can't get metadata, skip plan reference but still include file diffs
      const editedFilesRef = AttachmentService.generateEditedFilesAttachment(fileDiffs);
      return editedFilesRef ? [editedFilesRef] : [];
    }
    const runtime = createRuntime(
      metadataResult.data.runtimeConfig ?? { type: "local", srcBaseDir: this.config.srcDir },
      { projectPath: metadataResult.data.projectPath }
    );

    // Load exclusions
    const excludedItems = await this.loadExcludedItems();

    return AttachmentService.generatePostCompactionAttachments(
      metadataResult.data.name,
      metadataResult.data.projectName,
      this.workspaceId,
      fileDiffs,
      runtime,
      excludedItems
    );
  }

  /**
   * Load excluded items from the exclusions file.
   * Returns empty set if file doesn't exist or can't be read.
   */
  private async loadExcludedItems(): Promise<Set<string>> {
    const exclusionsPath = path.join(
      this.config.getSessionDir(this.workspaceId),
      "exclusions.json"
    );
    try {
      const data = await readFile(exclusionsPath, "utf-8");
      const exclusions = JSON.parse(data) as PostCompactionExclusions;
      return new Set(exclusions.excludedItems);
    } catch {
      return new Set();
    }
  }

  /**
   * Check tracked files for external modifications.
   * Returns attachments for files that changed since last recorded state.
   * Uses timestamp-based polling with diff injection.
   */
  async getChangedFileAttachments(): Promise<EditedFileAttachment[]> {
    const checks = Array.from(this.readFileState.entries()).map(
      async ([filePath, state]): Promise<EditedFileAttachment | null> => {
        try {
          const currentMtime = (await stat(filePath)).mtimeMs;
          if (currentMtime <= state.timestamp) return null; // No change

          const currentContent = await readFile(filePath, "utf-8");
          const diff = computeDiff(state.content, currentContent);
          if (!diff) return null; // Content identical despite mtime change

          // Update stored state
          this.readFileState.set(filePath, { content: currentContent, timestamp: currentMtime });

          return {
            type: "edited_text_file",
            filename: filePath,
            snippet: diff,
          };
        } catch {
          // File deleted or inaccessible, skip
          return null;
        }
      }
    );

    const results = await Promise.all(checks);
    return results.filter((r): r is EditedFileAttachment => r !== null);
  }

  /**
   * Peek at cached file paths from pending compaction.
   * Returns paths that will be reinjected, or null if no pending compaction.
   */
  getPendingTrackedFilePaths(): string[] | null {
    return this.compactionHandler.peekCachedFilePaths();
  }

  private assertNotDisposed(operation: string): void {
    assert(!this.disposed, `AgentSession.${operation} called after dispose`);
  }
}
