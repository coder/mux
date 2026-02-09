import assert from "@/common/utils/assert";
import { EventEmitter } from "events";
import * as path from "path";
import { PlatformPaths } from "@/common/utils/paths";
import { log } from "@/node/services/log";
import type { Config } from "@/node/config";
import type { AIService } from "@/node/services/aiService";
import type { HistoryService } from "@/node/services/historyService";
import type { PartialService } from "@/node/services/partialService";
import type { InitStateManager } from "@/node/services/initStateManager";

import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import type { RuntimeConfig } from "@/common/types/runtime";
import { DEFAULT_RUNTIME_CONFIG } from "@/common/constants/workspace";
import { DEFAULT_MODEL } from "@/common/constants/knownModels";
import type { WorkspaceChatMessage, SendMessageOptions, FilePart } from "@/common/orpc/types";
import type { SendMessageError } from "@/common/types/errors";
import {
  buildStreamErrorEventData,
  createUnknownSendMessageError,
} from "@/node/services/utils/sendMessageError";
import {
  ContextExceededRetryHandler,
  isCompactionRequestMetadata,
  type StreamErrorPayload,
} from "./contextExceededRetry";
import { createUserMessageId } from "@/node/services/utils/messageIds";
import {
  FileChangeTracker,
  type FileState,
  type EditedFileAttachment,
} from "@/node/services/utils/fileChangeTracker";
import type { Result } from "@/common/types/result";
import { Ok, Err } from "@/common/types/result";
import { enforceThinkingPolicy } from "@/common/utils/thinking/policy";
import {
  createMuxMessage,
  isCompactionSummaryMetadata,
  prepareUserMessageForSend,
  type MuxFrontendMetadata,
  type MuxFilePart,
  type MuxMessage,
} from "@/common/types/message";
import { createRuntime } from "@/node/runtime/runtimeFactory";
import {
  materializeFileAtMentionsSnapshot,
  materializeAgentSkillSnapshot,
} from "@/node/services/snapshotMaterializer";
import { MessageQueue } from "./messageQueue";
import type { StreamEndEvent } from "@/common/types/stream";
import { CompactionHandler } from "./compactionHandler";
import type { TelemetryService } from "./telemetryService";
import type { BackgroundProcessManager } from "./backgroundProcessManager";

import { PostCompactionAttachmentBuilder } from "./postCompactionAttachments";
import { getModelCapabilities } from "@/common/utils/ai/modelCapabilities";
import { normalizeGatewayModel, isValidModelFormat } from "@/common/utils/ai/models";

import { getErrorMessage } from "@/common/utils/errors";

/**
 * Tracked file state for detecting external edits.
 * Uses timestamp-based polling with diff injection.
 */
// Re-export types from FileChangeTracker for backward compatibility
export type { FileState, EditedFileAttachment } from "@/node/services/utils/fileChangeTracker";

const PDF_MEDIA_TYPE = "application/pdf";

function normalizeMediaType(mediaType: string): string {
  return mediaType.toLowerCase().trim().split(";")[0];
}

function estimateBase64DataUrlBytes(dataUrl: string): number | null {
  if (!dataUrl.startsWith("data:")) return null;

  const commaIndex = dataUrl.indexOf(",");
  if (commaIndex === -1) return null;

  const header = dataUrl.slice("data:".length, commaIndex);
  if (!header.includes(";base64")) return null;

  const base64 = dataUrl.slice(commaIndex + 1);
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
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
  /** When true, skip terminating background processes on dispose/compaction (for bench/CI) */
  keepBackgroundProcesses?: boolean;
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
  private readonly keepBackgroundProcesses: boolean;
  private readonly onCompactionComplete?: () => void;
  private readonly onPostCompactionStateChange?: () => void;
  private readonly emitter = new EventEmitter();
  private readonly aiListeners: Array<{ event: string; handler: (...args: unknown[]) => void }> =
    [];
  private readonly initListeners: Array<{ event: string; handler: (...args: unknown[]) => void }> =
    [];
  private disposed = false;
  private streamStarting = false;
  private readonly messageQueue = new MessageQueue();
  private readonly compactionHandler: CompactionHandler;

  /** Tracks file state for detecting external edits. */
  private readonly fileChangeTracker = new FileChangeTracker();

  /** Builds post-compaction context (plan refs, TODOs, edited-file diffs) for prompt injection. */
  private readonly attachmentBuilder: PostCompactionAttachmentBuilder;

  /** Handles all context-exceeded retry strategies (compaction, post-compaction, hard restart). */
  private readonly retryHandler: ContextExceededRetryHandler;

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
      keepBackgroundProcesses,
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
    this.keepBackgroundProcesses = keepBackgroundProcesses ?? false;
    this.onCompactionComplete = onCompactionComplete;
    this.onPostCompactionStateChange = onPostCompactionStateChange;

    this.compactionHandler = new CompactionHandler({
      workspaceId: this.workspaceId,
      historyService: this.historyService,
      partialService: this.partialService,
      sessionDir: this.config.getSessionDir(this.workspaceId),
      telemetryService,
      emitter: this.emitter,
      onCompactionComplete,
    });

    this.attachmentBuilder = new PostCompactionAttachmentBuilder(
      this.workspaceId,
      this.config,
      this.aiService,
      this.historyService,
      this.compactionHandler,
      this.fileChangeTracker
    );

    this.retryHandler = new ContextExceededRetryHandler(
      {
        workspaceId: this.workspaceId,
        historyService: this.historyService,
        partialService: this.partialService,
        aiService: this.aiService,
        compactionHandler: this.compactionHandler,
        onPostCompactionStateChange,
      },
      {
        emitChatEvent: (msg) => this.emitChatEvent(msg),
        clearQueue: () => this.clearQueue(),
        streamWithHistory: (m, o, t, d) => this.streamWithHistory(m, o, t, d),
        isDisposed: () => this.disposed,
        setStreamStarting: (v) => {
          this.streamStarting = v;
        },
      }
    );

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
    // Terminate background processes for this workspace (skip when flagged for bench/CI)
    if (!this.keepBackgroundProcesses) {
      void this.backgroundProcessManager.cleanup(this.workspaceId);
    }

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

    // Crash recovery: check if the last message is a compaction summary with
    // a pending follow-up that was never dispatched. If so, dispatch it now.
    // This handles the case where the app crashed after compaction completed
    // but before the follow-up was sent.
    void this.dispatchPendingFollowUp();

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
            const runtime = createRuntime(metadata.runtimeConfig, {
              projectPath: metadata.projectPath,
              workspaceName: metadata.name,
            });
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

  /**
   * Handle edit-specific logic: preserve file parts from the original message,
   * interrupt any active stream, walk back over preceding snapshots, and
   * truncate history at the edit target.
   *
   * @returns preserved file parts (if the frontend omitted them), or an error
   */
  private async handleEditTruncation(
    editMessageId: string,
    fileParts: FilePart[] | undefined
  ): Promise<Result<{ preservedFileParts?: MuxFilePart[] }, SendMessageError>> {
    let preservedFileParts: MuxFilePart[] | undefined;

    // If the frontend omits fileParts, preserve the original message's attachments.
    if (fileParts === undefined) {
      const historyResult = await this.historyService.getHistory(this.workspaceId);
      if (historyResult.success) {
        const targetMessage = historyResult.data.find((msg) => msg.id === editMessageId);
        const parts = targetMessage?.parts.filter(
          (part): part is MuxFilePart => part.type === "file"
        );
        if (parts && parts.length > 0) {
          preservedFileParts = parts;
        }
      }
    }

    // Interrupt an existing stream or compaction, if active
    if (this.aiService.isStreaming(this.workspaceId)) {
      // MUST use abandonPartial=true to prevent handleAbort from performing partial compaction
      // with mismatched history (since we're about to truncate it)
      const stopResult = await this.interruptStream({ abandonPartial: true });
      if (!stopResult.success) {
        return Err(createUnknownSendMessageError(stopResult.error));
      }
    }

    // Find the truncation target: the edited message or any immediately-preceding snapshots.
    // (snapshots are persisted immediately before their corresponding user message)
    let truncateTargetId = editMessageId;
    const historyResult = await this.historyService.getHistory(this.workspaceId);
    if (historyResult.success) {
      const messages = historyResult.data;
      const editIndex = messages.findIndex((m) => m.id === editMessageId);
      if (editIndex > 0) {
        // Walk backwards over contiguous synthetic snapshots so we don't orphan them.
        for (let i = editIndex - 1; i >= 0; i--) {
          const msg = messages[i];
          const isSnapshot =
            msg.metadata?.synthetic &&
            (msg.metadata?.fileAtMentionSnapshot ?? msg.metadata?.agentSkillSnapshot);
          if (!isSnapshot) break;
          truncateTargetId = msg.id;
        }
      }
    }

    const truncateResult = await this.historyService.truncateAfterMessage(
      this.workspaceId,
      truncateTargetId
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
          editMessageId,
          error: truncateResult.error,
        });
      } else {
        return Err(createUnknownSendMessageError(truncateResult.error));
      }
    }

    return Ok({ preservedFileParts });
  }

  /**
   * Validate model string and file parts against model capabilities.
   * Returns normalized options or an error.
   */
  private validateModelAndFiles(
    options: SendMessageOptions,
    effectiveFileParts: Array<{ url: string; mediaType: string; filename?: string }> | undefined
  ): Result<void, SendMessageError> {
    // Defense-in-depth: reject PDFs for models we know don't support them.
    if (effectiveFileParts && effectiveFileParts.length > 0) {
      const pdfParts = effectiveFileParts.filter(
        (part) => normalizeMediaType(part.mediaType) === PDF_MEDIA_TYPE
      );

      if (pdfParts.length > 0) {
        const caps = getModelCapabilities(options.model);

        if (caps && !caps.supportsPdfInput) {
          return Err(
            createUnknownSendMessageError(`Model ${options.model} does not support PDF input.`)
          );
        }

        if (caps?.maxPdfSizeMb !== undefined) {
          const maxBytes = caps.maxPdfSizeMb * 1024 * 1024;
          for (const part of pdfParts) {
            const bytes = estimateBase64DataUrlBytes(part.url);
            if (bytes !== null && bytes > maxBytes) {
              const actualMb = (bytes / (1024 * 1024)).toFixed(1);
              const label = part.filename ?? "PDF";
              return Err(
                createUnknownSendMessageError(
                  `${label} is ${actualMb}MB, but ${options.model} allows up to ${caps.maxPdfSizeMb}MB per PDF.`
                )
              );
            }
          }
        }
      }
    }

    // Validate model string format (must be "provider:model-id")
    if (!isValidModelFormat(options.model)) {
      return Err({
        type: "invalid_model_string",
        message: `Invalid model string format: "${options.model}". Expected "provider:model-id"`,
      });
    }

    return Ok(undefined);
  }

  async sendMessage(
    message: string,
    options?: SendMessageOptions & { fileParts?: FilePart[] },
    internal?: { synthetic?: boolean }
  ): Promise<Result<void, SendMessageError>> {
    this.assertNotDisposed("sendMessage");

    assert(typeof message === "string", "sendMessage requires a string message");
    const trimmedMessage = message.trim();
    const fileParts = options?.fileParts;
    const editMessageId = options?.editMessageId;

    // Handle edit: preserve file parts, interrupt stream, truncate history at edit target.
    let preservedEditFileParts: MuxFilePart[] | undefined;
    if (editMessageId) {
      const editResult = await this.handleEditTruncation(editMessageId, fileParts);
      if (!editResult.success) return Err(editResult.error);
      preservedEditFileParts = editResult.data.preservedFileParts;
    }

    const hasFiles = (fileParts?.length ?? 0) > 0 || (preservedEditFileParts?.length ?? 0) > 0;

    if (trimmedMessage.length === 0 && !hasFiles) {
      return Err(
        createUnknownSendMessageError(
          "Empty message not allowed. Use interruptStream() to interrupt active streams."
        )
      );
    }

    const messageId = createUserMessageId();
    const additionalParts =
      preservedEditFileParts && preservedEditFileParts.length > 0
        ? preservedEditFileParts
        : fileParts && fileParts.length > 0
          ? fileParts.map((part, index) => {
              assert(
                typeof part.url === "string",
                `file part [${index}] must include url string content (got ${typeof part.url}): ${JSON.stringify(part).slice(0, 200)}`
              );
              assert(
                part.url.startsWith("data:"),
                `file part [${index}] url must be a data URL (got: ${part.url.slice(0, 50)}...)`
              );
              assert(
                typeof part.mediaType === "string" && part.mediaType.trim().length > 0,
                `file part [${index}] must include a mediaType (got ${typeof part.mediaType}): ${JSON.stringify(part).slice(0, 200)}`
              );
              if (part.filename !== undefined) {
                assert(
                  typeof part.filename === "string",
                  `file part [${index}] filename must be a string if present (got ${typeof part.filename}): ${JSON.stringify(part).slice(0, 200)}`
                );
              }
              return {
                type: "file" as const,
                url: part.url,
                mediaType: part.mediaType,
                filename: part.filename,
              };
            })
          : undefined;

    // toolPolicy is properly typed via Zod schema inference
    const typedToolPolicy = options?.toolPolicy;
    // muxMetadata is z.any() in schema - cast to proper type
    const typedMuxMetadata = options?.muxMetadata as MuxFrontendMetadata | undefined;
    const isCompactionRequest = isCompactionRequestMetadata(typedMuxMetadata);

    // Validate model BEFORE persisting message to prevent orphaned messages on invalid model
    if (!options?.model || options.model.trim().length === 0) {
      return Err(
        createUnknownSendMessageError("No model specified. Please select a model using /model.")
      );
    }

    const rawModelString = options.model.trim();
    const rawSystem1Model = options.system1Model?.trim();

    options = this.normalizeGatewaySendOptions(options);

    // Preserve explicit mux-gateway prefixes from legacy clients so backend routing can
    // honor the opt-in even before muxGatewayModels has synchronized.
    const modelForStream = rawModelString.startsWith("mux-gateway:")
      ? rawModelString
      : options.model;
    const optionsForStream = rawSystem1Model?.startsWith("mux-gateway:")
      ? { ...options, system1Model: rawSystem1Model }
      : options;

    // Validate model capabilities (PDF support, size limits) and model string format.
    const effectiveFileParts =
      preservedEditFileParts && preservedEditFileParts.length > 0
        ? preservedEditFileParts.map((part) => ({
            url: part.url,
            mediaType: part.mediaType,
            filename: part.filename,
          }))
        : fileParts;

    const validationResult = this.validateModelAndFiles(options, effectiveFileParts);
    if (!validationResult.success) return Err(validationResult.error);

    const userMessage = createMuxMessage(
      messageId,
      "user",
      message,
      {
        timestamp: Date.now(),
        toolPolicy: typedToolPolicy,
        muxMetadata: typedMuxMetadata, // Pass through frontend metadata as black-box
        // Auto-resume and other system-generated messages are synthetic + UI-visible
        ...(internal?.synthetic && { synthetic: true, uiVisible: true }),
      },
      additionalParts
    );

    // Materialize @file mentions from the user message into a snapshot.
    // This ensures prompt-cache stability: we read files once and persist the content,
    // so subsequent turns don't re-read (which would change the prompt prefix if files changed).
    // File changes after this point are surfaced via <system-file-update> diffs instead.
    const snapshotResult = await materializeFileAtMentionsSnapshot(
      trimmedMessage,
      this.workspaceId,
      this.aiService,
      this.fileChangeTracker.record.bind(this.fileChangeTracker)
    );
    let skillSnapshotResult: { snapshotMessage: MuxMessage } | null = null;
    try {
      skillSnapshotResult = await materializeAgentSkillSnapshot(
        typedMuxMetadata,
        options?.disableWorkspaceAgents,
        this.workspaceId,
        this.aiService,
        this.historyService
      );
    } catch (error) {
      return Err(createUnknownSendMessageError(getErrorMessage(error)));
    }

    // Persist snapshots (if any) BEFORE the user message so they precede it in the prompt.
    // Order matters: @file snapshot first, then agent-skill snapshot.
    if (snapshotResult?.snapshotMessage) {
      const snapshotAppendResult = await this.historyService.appendToHistory(
        this.workspaceId,
        snapshotResult.snapshotMessage
      );
      if (!snapshotAppendResult.success) {
        return Err(createUnknownSendMessageError(snapshotAppendResult.error));
      }
    }

    if (skillSnapshotResult?.snapshotMessage) {
      const skillSnapshotAppendResult = await this.historyService.appendToHistory(
        this.workspaceId,
        skillSnapshotResult.snapshotMessage
      );
      if (!skillSnapshotAppendResult.success) {
        return Err(createUnknownSendMessageError(skillSnapshotAppendResult.error));
      }
    }

    const appendResult = await this.historyService.appendToHistory(this.workspaceId, userMessage);
    if (!appendResult.success) {
      // Note: If we get here with snapshots, one or more snapshots may already be persisted but user message
      // failed. This is a rare edge case (disk full mid-operation). The next edit will clean up
      // the orphan via the truncation logic that removes preceding snapshots.
      return Err(createUnknownSendMessageError(appendResult.error));
    }

    // Workspace may be tearing down while we await filesystem IO.
    // If so, skip event emission + streaming to avoid races with dispose().
    if (this.disposed) {
      return Ok(undefined);
    }

    // Emit snapshots first (if any), then user message - maintains prompt ordering in UI
    if (snapshotResult?.snapshotMessage) {
      this.emitChatEvent({ ...snapshotResult.snapshotMessage, type: "message" });
    }

    if (skillSnapshotResult?.snapshotMessage) {
      this.emitChatEvent({ ...skillSnapshotResult.snapshotMessage, type: "message" });
    }

    // Add type: "message" for discriminated union (createMuxMessage doesn't add it)
    this.emitChatEvent({ ...userMessage, type: "message" });

    this.streamStarting = true;

    try {
      // If this is a compaction request, terminate background processes first
      // They won't be included in the summary, so continuing with orphaned processes would be confusing
      if (isCompactionRequest && !this.keepBackgroundProcesses) {
        await this.backgroundProcessManager.cleanup(this.workspaceId);

        if (this.disposed) {
          return Ok(undefined);
        }
      }

      // Note: Follow-up content for compaction is now stored on the summary message
      // and dispatched via dispatchPendingFollowUp() after compaction completes.
      // This provides crash safety - the follow-up survives app restarts.

      if (this.disposed) {
        return Ok(undefined);
      }

      // Must await here so the finally block runs after streaming completes,
      // not immediately when the Promise is returned. This keeps streamStarting=true
      // for the entire duration of streaming, allowing follow-up messages to be queued.
      const result = await this.streamWithHistory(modelForStream, optionsForStream);
      return result;
    } finally {
      this.streamStarting = false;
    }
  }

  async resumeStream(options: SendMessageOptions): Promise<Result<void, SendMessageError>> {
    this.assertNotDisposed("resumeStream");

    assert(options, "resumeStream requires options");
    const { model } = options;
    assert(typeof model === "string" && model.trim().length > 0, "resumeStream requires a model");

    const rawModelString = options.model.trim();
    const rawSystem1Model = options.system1Model?.trim();
    const normalizedOptions = this.normalizeGatewaySendOptions(options);

    // Preserve explicit mux-gateway prefixes from legacy clients so backend routing can
    // honor the opt-in even before muxGatewayModels has synchronized.
    const modelForStream = rawModelString.startsWith("mux-gateway:")
      ? rawModelString
      : normalizedOptions.model;
    const optionsForStream = rawSystem1Model?.startsWith("mux-gateway:")
      ? { ...normalizedOptions, system1Model: rawSystem1Model }
      : normalizedOptions;

    // Guard against auto-retry starting a second stream while the initial send is
    // still waiting for init hooks to complete.
    if (this.streamStarting || this.aiService.isStreaming(this.workspaceId)) {
      return Ok(undefined);
    }

    this.streamStarting = true;
    try {
      // Must await here so the finally block runs after streaming completes,
      // not immediately when the Promise is returned.
      const result = await this.streamWithHistory(modelForStream, optionsForStream);
      return result;
    } finally {
      this.streamStarting = false;
    }
  }

  private normalizeGatewaySendOptions(options: SendMessageOptions): SendMessageOptions {
    // Keep persisted model IDs canonical; gateway routing is now backend-authoritative (issue #1769).
    const normalizedModel = normalizeGatewayModel(options.model.trim());
    const system1Model = options.system1Model?.trim();
    const normalizedSystem1Model =
      system1Model && system1Model.length > 0 ? normalizeGatewayModel(system1Model) : undefined;

    return {
      ...options,
      model: normalizedModel,
      system1Model: normalizedSystem1Model,
    };
  }

  async interruptStream(options?: {
    soft?: boolean;
    abandonPartial?: boolean;
  }): Promise<Result<void>> {
    this.assertNotDisposed("interruptStream");

    // For hard interrupts, delete partial BEFORE stopping to prevent abort handler
    // from committing it. For soft interrupts, defer to stream-abort handler since
    // the stream continues running and would recreate the partial.
    if (options?.abandonPartial && !options?.soft) {
      const deleteResult = await this.partialService.deletePartial(this.workspaceId);
      if (!deleteResult.success) {
        return Err(deleteResult.error);
      }
    }

    const stopResult = await this.aiService.stopStream(this.workspaceId, {
      ...options,
      abortReason: "user",
    });
    if (!stopResult.success) {
      return Err(stopResult.error);
    }

    return Ok(undefined);
  }

  private async streamWithHistory(
    modelString: string,
    options?: SendMessageOptions,
    openaiTruncationModeOverride?: "auto" | "disabled",
    disablePostCompactionAttachments?: boolean
  ): Promise<Result<void, SendMessageError>> {
    if (this.disposed) {
      return Ok(undefined);
    }

    // Reset per-stream flags (used for retries / crash-safe bookkeeping).
    this.attachmentBuilder.ackPendingOnStreamEnd = false;
    this.retryHandler.initStreamState({ modelString, options, openaiTruncationModeOverride });

    const commitResult = await this.partialService.commitToHistory(this.workspaceId);
    if (!commitResult.success) {
      return Err(createUnknownSendMessageError(commitResult.error));
    }

    let historyResult = await this.historyService.getHistory(this.workspaceId);
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

    // Structural invariant: API requests must not end with a non-partial assistant message.
    // Partial assistants are handled by addInterruptedSentinel at transform time.
    // Non-partial trailing assistants indicate a missing user message upstream — inject a
    // [CONTINUE] sentinel so the model has a valid conversation to respond to. This is
    // defense-in-depth; callers should prefer sendMessage() which persists a real user message.
    const lastMsg = historyResult.data[historyResult.data.length - 1];
    if (lastMsg?.role === "assistant" && !lastMsg.metadata?.partial) {
      log.warn("streamWithHistory: trailing non-partial assistant detected, injecting [CONTINUE]", {
        workspaceId: this.workspaceId,
        messageId: lastMsg.id,
      });
      const sentinelMessage = createMuxMessage(createUserMessageId(), "user", "[CONTINUE]", {
        timestamp: Date.now(),
        synthetic: true,
      });
      await this.historyService.appendToHistory(this.workspaceId, sentinelMessage);
      const refreshed = await this.historyService.getHistory(this.workspaceId);
      if (refreshed.success) {
        historyResult = refreshed;
      }
    }

    // Capture the current user message id so retries are stable across assistant message ids.
    const lastUserMessage = [...historyResult.data].reverse().find((m) => m.role === "user");
    this.retryHandler.setActiveStreamUserMessageId(lastUserMessage?.id);

    this.retryHandler.resolveAndSetCompactionRequest(historyResult.data, modelString, options);

    // Check for external file edits (timestamp-based polling)
    const changedFileAttachments = await this.fileChangeTracker.getChangedAttachments();

    // Check if post-compaction attachments should be injected.
    const postCompactionAttachments =
      disablePostCompactionAttachments === true
        ? null
        : await this.attachmentBuilder.getAttachmentsIfNeeded();
    this.retryHandler.setPostCompactionInjection(
      postCompactionAttachments !== null && postCompactionAttachments.length > 0
    );

    // Enforce thinking policy for the specified model (single source of truth)
    // This ensures model-specific requirements are met regardless of where the request originates
    const effectiveThinkingLevel = options?.thinkingLevel
      ? enforceThinkingPolicy(modelString, options.thinkingLevel)
      : undefined;

    // Bind recordFileState to this session for the propose_plan tool
    const recordFileState = this.fileChangeTracker.record.bind(this.fileChangeTracker);

    const streamResult = await this.aiService.streamMessage({
      messages: historyResult.data,
      workspaceId: this.workspaceId,
      modelString,
      thinkingLevel: effectiveThinkingLevel,
      toolPolicy: options?.toolPolicy,
      additionalSystemInstructions: options?.additionalSystemInstructions,
      maxOutputTokens: options?.maxOutputTokens,
      muxProviderOptions: options?.providerOptions,
      agentId: options?.agentId,
      recordFileState,
      changedFileAttachments:
        changedFileAttachments.length > 0 ? changedFileAttachments : undefined,
      postCompactionAttachments,
      experiments: options?.experiments,
      system1Model: options?.system1Model,
      system1ThinkingLevel: options?.system1ThinkingLevel,
      disableWorkspaceAgents: options?.disableWorkspaceAgents,
      hasQueuedMessage: () => !this.messageQueue.isEmpty(),
      openaiTruncationModeOverride,
    });

    if (!streamResult.success) {
      this.retryHandler.clearActiveCompactionRequest();

      // If stream startup failed before any stream events were emitted (e.g., missing API key),
      // emit a synthetic stream-error so the UI can surface the failure immediately.
      if (
        streamResult.error.type !== "runtime_not_ready" &&
        streamResult.error.type !== "runtime_start_failed"
      ) {
        const streamError = buildStreamErrorEventData(streamResult.error);
        await this.retryHandler.handleStreamError(streamError);
      }
    }

    return streamResult;
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
    forward("stream-delta", (payload) => {
      this.retryHandler.markStreamHadDelta();
      this.emitChatEvent(payload);
    });
    forward("tool-call-start", (payload) => {
      this.retryHandler.markStreamHadDelta();
      this.emitChatEvent(payload);
    });
    forward("bash-output", (payload) => {
      this.retryHandler.markStreamHadDelta();
      this.emitChatEvent(payload);
    });
    forward("tool-call-delta", (payload) => {
      this.retryHandler.markStreamHadDelta();
      this.emitChatEvent(payload);
    });
    forward("tool-call-end", (payload) => {
      this.retryHandler.markStreamHadDelta();
      this.emitChatEvent(payload);

      // Post-compaction context state depends on plan writes + tracked file diffs.
      // Trigger a metadata refresh so the right sidebar updates immediately.
      if (
        payload.type === "tool-call-end" &&
        (payload.toolName === "propose_plan" || payload.toolName.startsWith("file_edit_"))
      ) {
        this.onPostCompactionStateChange?.();
      }
    });
    forward("reasoning-delta", (payload) => {
      this.retryHandler.markStreamHadDelta();
      this.emitChatEvent(payload);
    });
    forward("reasoning-end", (payload) => this.emitChatEvent(payload));
    forward("usage-delta", (payload) => this.emitChatEvent(payload));
    forward("stream-abort", (payload) => {
      const hadCompactionRequest = this.retryHandler.hasActiveCompactionRequest();
      this.retryHandler.clearActiveCompactionRequest();
      this.retryHandler.resetActiveStreamState();
      this.attachmentBuilder.ackPendingOnStreamEnd = false;
      if (hadCompactionRequest && !this.disposed) {
        this.clearQueue();
      }
      this.emitChatEvent(payload);
    });
    forward("runtime-status", (payload) => this.emitChatEvent(payload));

    forward("stream-end", async (payload) => {
      this.retryHandler.clearActiveCompactionRequest();
      const handled = await this.compactionHandler.handleCompletion(payload as StreamEndEvent);

      if (!handled) {
        this.emitChatEvent(payload);

        if (this.attachmentBuilder.ackPendingOnStreamEnd) {
          this.attachmentBuilder.ackPendingOnStreamEnd = false;
          try {
            await this.compactionHandler.ackPendingDiffsConsumed();
          } catch (error) {
            log.warn("Failed to ack pending post-compaction state", {
              workspaceId: this.workspaceId,
              error: getErrorMessage(error),
            });
          }
          this.onPostCompactionStateChange?.();
        }
      } else {
        // Compaction completed - notify to trigger metadata refresh
        // This allows the frontend to get updated postCompaction state
        this.onCompactionComplete?.();

        // Dispatch any pending follow-up from the compaction summary.
        // The follow-up is stored on the summary for crash safety - if the app
        // crashes after compaction but before this dispatch, startup recovery
        // will detect the pending follow-up and dispatch it.
        //
        // IMPORTANT: await to ensure the follow-up message is persisted before
        // sendQueuedMessages runs. Otherwise a queued message could append first,
        // causing dispatchPendingFollowUp to skip (since summary would no longer
        // be the last message).
        await this.dispatchPendingFollowUp();
      }

      this.retryHandler.resetActiveStreamState();
      this.attachmentBuilder.ackPendingOnStreamEnd = false;

      // Stream end: auto-send queued messages (for user messages typed during streaming)
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
      const data = raw as StreamErrorPayload & { workspaceId: string };
      void this.retryHandler.handleStreamError({
        messageId: data.messageId,
        error: data.error,
        errorType: data.errorType,
      });
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

  isStreamStarting(): boolean {
    return this.streamStarting;
  }

  queueMessage(message: string, options?: SendMessageOptions & { fileParts?: FilePart[] }): void {
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
      const fileParts = this.messageQueue.getFileParts();
      const reviews = this.messageQueue.getReviews();
      this.messageQueue.clear();
      this.emitQueuedMessageChanged();

      this.emitChatEvent({
        type: "restore-to-input",
        workspaceId: this.workspaceId,
        text: displayText,
        fileParts: fileParts,
        reviews: reviews,
      });
    }
  }

  private emitQueuedMessageChanged(): void {
    this.emitChatEvent({
      type: "queued-message-changed",
      workspaceId: this.workspaceId,
      queuedMessages: this.messageQueue.getMessages(),
      displayText: this.messageQueue.getDisplayText(),
      fileParts: this.messageQueue.getFileParts(),
      reviews: this.messageQueue.getReviews(),
      hasCompactionRequest: this.messageQueue.hasCompactionRequest(),
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
   * Dispatch the pending follow-up from a compaction summary message.
   * Called after compaction completes - the follow-up is stored on the summary
   * for crash safety. The user message persisted by sendMessage() serves as
   * proof of dispatch (no history rewrite needed).
   */
  private async dispatchPendingFollowUp(): Promise<void> {
    if (this.disposed) {
      return;
    }

    // Read the last message from history
    const historyResult = await this.historyService.getHistory(this.workspaceId);
    if (!historyResult.success || historyResult.data.length === 0) {
      return;
    }

    const lastMessage = historyResult.data[historyResult.data.length - 1];
    const muxMeta = lastMessage.metadata?.muxMetadata;

    // Check if it's a compaction summary with a pending follow-up
    if (!isCompactionSummaryMetadata(muxMeta) || !muxMeta.pendingFollowUp) {
      return;
    }

    // Handle legacy formats: older persisted requests may have `mode` instead of `agentId`,
    // and `imageParts` instead of `fileParts`.
    const followUp = muxMeta.pendingFollowUp as typeof muxMeta.pendingFollowUp & {
      mode?: "exec" | "plan";
      imageParts?: FilePart[];
    };

    // Derive agentId: new field has it directly, legacy may use `mode` field.
    // Legacy `mode` was "exec" | "plan" and maps directly to agentId.
    const effectiveAgentId = followUp.agentId ?? followUp.mode ?? "exec";

    // Normalize attachments: newer metadata uses `fileParts`, older persisted entries used `imageParts`.
    const effectiveFileParts = followUp.fileParts ?? followUp.imageParts;

    // Model fallback for legacy follow-ups that may lack the model field.
    // DEFAULT_MODEL is a safe fallback that's always available.
    const effectiveModel = followUp.model ?? DEFAULT_MODEL;

    log.debug("Dispatching pending follow-up from compaction summary", {
      workspaceId: this.workspaceId,
      hasText: Boolean(followUp.text),
      hasFileParts: Boolean(effectiveFileParts?.length),
      hasReviews: Boolean(followUp.reviews?.length),
      model: effectiveModel,
      agentId: effectiveAgentId,
    });

    // Process the follow-up content (handles reviews -> text formatting + metadata)
    const { finalText, metadata } = prepareUserMessageForSend(
      {
        text: followUp.text,
        fileParts: effectiveFileParts,
        reviews: followUp.reviews,
      },
      followUp.muxMetadata
    );

    // Build options for the follow-up message.
    // Spread the followUp to include preserved send options (thinkingLevel, providerOptions, etc.)
    // that were captured from the original user message in prepareCompactionMessage().
    const options: SendMessageOptions & {
      fileParts?: FilePart[];
      muxMetadata?: MuxFrontendMetadata;
    } = {
      ...followUp,
      model: effectiveModel,
      agentId: effectiveAgentId,
    };

    if (effectiveFileParts && effectiveFileParts.length > 0) {
      options.fileParts = effectiveFileParts;
    }

    if (metadata) {
      options.muxMetadata = metadata;
    }

    // Await sendMessage to ensure the follow-up is persisted before returning.
    // This guarantees ordering: the follow-up message is written to history
    // before sendQueuedMessages() runs, preventing race conditions.
    await this.sendMessage(finalText, options);
  }

  /**
   * Record file state for change detection.
   * Called by tools (e.g., propose_plan) after reading/writing files.
   */
  recordFileState(filePath: string, state: FileState): void {
    this.fileChangeTracker.record(filePath, state);
  }

  /** Get the count of tracked files for UI display. */
  getTrackedFilesCount(): number {
    return this.fileChangeTracker.count;
  }

  /** Get the paths of tracked files for UI display. */
  getTrackedFilePaths(): string[] {
    return this.fileChangeTracker.paths;
  }

  /** Clear all tracked file state (e.g., on /clear). */
  clearFileState(): void {
    this.fileChangeTracker.clear();
  }

  /** Delegate to FileChangeTracker for external file change detection. */
  async getChangedFileAttachments(): Promise<EditedFileAttachment[]> {
    return this.fileChangeTracker.getChangedAttachments();
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
