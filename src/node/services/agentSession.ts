import assert from "@/common/utils/assert";
import { EventEmitter } from "events";
import * as path from "path";
import { createHash } from "crypto";
import { readFile } from "fs/promises";
import YAML from "yaml";
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
import type {
  WorkspaceChatMessage,
  SendMessageOptions,
  FilePart,
  DeleteMessage,
} from "@/common/orpc/types";
import { WORKSPACE_DEFAULTS } from "@/constants/workspaceDefaults";
import type { SendMessageError } from "@/common/types/errors";
import { AgentIdSchema, SkillNameSchema } from "@/common/orpc/schemas";
import {
  buildStreamErrorEventData,
  createStreamErrorMessage,
  createUnknownSendMessageError,
  type StreamErrorPayload,
} from "@/node/services/utils/sendMessageError";
import {
  createUserMessageId,
  createFileSnapshotMessageId,
  createAgentSkillSnapshotMessageId,
} from "@/node/services/utils/messageIds";
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
  type CompactionFollowUpRequest,
  type MuxFrontendMetadata,
  type MuxFilePart,
  type MuxMessage,
  type ReviewNoteDataForDisplay,
} from "@/common/types/message";
import { createRuntime } from "@/node/runtime/runtimeFactory";
import { createRuntimeForWorkspace } from "@/node/runtime/runtimeHelpers";
import { isExecLikeEditingCapableInResolvedChain } from "@/common/utils/agentTools";
import { readAgentDefinition } from "@/node/services/agentDefinitions/agentDefinitionsService";
import { resolveAgentInheritanceChain } from "@/node/services/agentDefinitions/resolveAgentInheritanceChain";
import { MessageQueue } from "./messageQueue";
import type { StreamEndEvent } from "@/common/types/stream";
import { CompactionHandler } from "./compactionHandler";
import type { TelemetryService } from "./telemetryService";
import type { BackgroundProcessManager } from "./backgroundProcessManager";

import { AttachmentService } from "./attachmentService";
import type { TodoItem } from "@/common/types/tools";
import type { PostCompactionAttachment, PostCompactionExclusions } from "@/common/types/attachment";
import { TURNS_BETWEEN_ATTACHMENTS } from "@/common/constants/attachments";

import { extractEditedFileDiffs } from "@/common/utils/messages/extractEditedFiles";
import { getModelCapabilities } from "@/common/utils/ai/modelCapabilities";
import { normalizeGatewayModel, isValidModelFormat } from "@/common/utils/ai/models";
import { readAgentSkill } from "@/node/services/agentSkills/agentSkillsService";
import { materializeFileAtMentions } from "@/node/services/fileAtMentions";

/**
 * Tracked file state for detecting external edits.
 * Uses timestamp-based polling with diff injection.
 */
// Re-export types from FileChangeTracker for backward compatibility
export type { FileState, EditedFileAttachment } from "@/node/services/utils/fileChangeTracker";

// Type guard for compaction request metadata
// Supports both new `followUpContent` and legacy `continueMessage` for backwards compatibility
interface CompactionRequestMetadata {
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
function isCompactionRequestMetadata(meta: unknown): meta is CompactionRequestMetadata {
  if (typeof meta !== "object" || meta === null) return false;
  const obj = meta as Record<string, unknown>;
  if (obj.type !== "compaction-request") return false;
  if (typeof obj.parsed !== "object" || obj.parsed === null) return false;
  return true;
}

const MAX_AGENT_SKILL_SNAPSHOT_CHARS = 50_000;

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
   * When true, clear any persisted post-compaction state after the next successful non-compaction stream.
   *
   * This is intentionally delayed until stream-end so a crash mid-stream doesn't lose the diffs.
   */
  private ackPendingPostCompactionStateOnStreamEnd = false;
  /**
   * Cache the last-known experiment state so we don't spam metadata refresh
   * when post-compaction context is disabled.
   */
  /** Track compaction requests that already retried with truncation. */
  private readonly compactionRetryAttempts = new Set<string>();
  /**
   * Active compaction request metadata for retry decisions (cleared on stream end/abort).
   */

  /** Tracks the user message id that initiated the currently active stream (for retry guards). */
  private activeStreamUserMessageId?: string;

  /** Track user message ids that already retried without post-compaction injection. */
  private readonly postCompactionRetryAttempts = new Set<string>();

  /** Track user message ids that already hard-restarted for exec-like subagents. */
  private readonly execSubagentHardRestartAttempts = new Set<string>();

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

  private activeCompactionRequest?: {
    id: string;
    modelString: string;
    options?: SendMessageOptions;
  };

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

      // Load chat history from the penultimate compaction boundary onward
      // (skip=1) so the user sees the previous epoch plus the current epoch.
      // This provides context for what was summarized in the latest compaction.
      // TODO: support paginated history loading so users can view older epochs on demand.
      const historyResult = await this.historyService.getHistoryFromLatestBoundary(
        this.workspaceId,
        1
      );
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

    // Edits are implemented as truncate+replace. If the frontend omits fileParts,
    // preserve the original message's attachments.
    // Only search the current compaction epoch — edits of pre-boundary messages are
    // blocked (the frontend only shows post-boundary messages).
    let preservedEditFileParts: MuxFilePart[] | undefined;
    if (editMessageId && fileParts === undefined) {
      const historyResult = await this.historyService.getHistoryFromLatestBoundary(
        this.workspaceId
      );
      if (historyResult.success) {
        const targetMessage: MuxMessage | undefined = historyResult.data.find(
          (msg) => msg.id === editMessageId
        );
        const fileParts = targetMessage?.parts.filter(
          (part): part is MuxFilePart => part.type === "file"
        );
        if (fileParts && fileParts.length > 0) {
          preservedEditFileParts = fileParts;
        }
      }
    }

    const hasFiles = (fileParts?.length ?? 0) > 0 || (preservedEditFileParts?.length ?? 0) > 0;

    if (trimmedMessage.length === 0 && !hasFiles) {
      return Err(
        createUnknownSendMessageError(
          "Empty message not allowed. Use interruptStream() to interrupt active streams."
        )
      );
    }

    if (editMessageId) {
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
      // Only search the current compaction epoch — truncating past a compaction boundary
      // would destroy the summary. The frontend only shows post-boundary messages.
      let truncateTargetId = editMessageId;
      const historyResult = await this.historyService.getHistoryFromLatestBoundary(
        this.workspaceId
      );
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

    // Defense-in-depth: reject PDFs for models we know don't support them.
    // (Frontend should also block this, but it's easy to bypass via IPC / older clients.)
    const effectiveFileParts =
      preservedEditFileParts && preservedEditFileParts.length > 0
        ? preservedEditFileParts.map((part) => ({
            url: part.url,
            mediaType: part.mediaType,
            filename: part.filename,
          }))
        : fileParts;

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
    const snapshotResult = await this.materializeFileAtMentionsSnapshot(trimmedMessage);
    let skillSnapshotResult: { snapshotMessage: MuxMessage } | null = null;
    try {
      skillSnapshotResult = await this.materializeAgentSkillSnapshot(
        typedMuxMetadata,
        options?.disableWorkspaceAgents
      );
    } catch (error) {
      return Err(
        createUnknownSendMessageError(error instanceof Error ? error.message : String(error))
      );
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
    this.ackPendingPostCompactionStateOnStreamEnd = false;
    this.activeStreamHadAnyDelta = false;
    this.activeStreamHadPostCompactionInjection = false;
    this.activeStreamContext = {
      modelString,
      options,
      openaiTruncationModeOverride,
    };
    this.activeStreamUserMessageId = undefined;

    const commitResult = await this.partialService.commitToHistory(this.workspaceId);
    if (!commitResult.success) {
      return Err(createUnknownSendMessageError(commitResult.error));
    }

    let historyResult = await this.historyService.getHistoryFromLatestBoundary(this.workspaceId);
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
      const refreshed = await this.historyService.getHistoryFromLatestBoundary(this.workspaceId);
      if (refreshed.success) {
        historyResult = refreshed;
      }
    }

    // Capture the current user message id so retries are stable across assistant message ids.
    const lastUserMessage = [...historyResult.data].reverse().find((m) => m.role === "user");
    this.activeStreamUserMessageId = lastUserMessage?.id;

    this.activeCompactionRequest = this.resolveCompactionRequest(
      historyResult.data,
      modelString,
      options
    );

    // Check for external file edits (timestamp-based polling)
    const changedFileAttachments = await this.fileChangeTracker.getChangedAttachments();

    // Check if post-compaction attachments should be injected.
    const postCompactionAttachments =
      disablePostCompactionAttachments === true
        ? null
        : await this.getPostCompactionAttachmentsIfNeeded();
    this.activeStreamHadPostCompactionInjection =
      postCompactionAttachments !== null && postCompactionAttachments.length > 0;

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
      this.activeCompactionRequest = undefined;

      // If stream startup failed before any stream events were emitted (e.g., missing API key),
      // emit a synthetic stream-error so the UI can surface the failure immediately.
      if (
        streamResult.error.type !== "runtime_not_ready" &&
        streamResult.error.type !== "runtime_start_failed"
      ) {
        const streamError = buildStreamErrorEventData(streamResult.error);
        await this.handleStreamError(streamError);
      }
    }

    return streamResult;
  }

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
    this.emitChatEvent({
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
    this.streamStarting = true;
    let retryResult: Result<void, SendMessageError>;
    try {
      retryResult = await this.streamWithHistory(
        context.modelString,
        retryOptions,
        isGptClass ? "auto" : undefined
      );
    } finally {
      this.streamStarting = false;
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
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // Abort the failed assistant placeholder and clean up persisted partial/history state.
    this.resetActiveStreamState();
    this.emitChatEvent({
      type: "stream-abort",
      workspaceId: this.workspaceId,
      messageId: data.messageId,
    });
    await this.clearFailedAssistantMessage(data.messageId, "post-compaction-retry");

    // Retry the same request, but without post-compaction injection.
    this.streamStarting = true;
    let retryResult: Result<void, SendMessageError>;
    try {
      retryResult = await this.streamWithHistory(
        context.modelString,
        context.options,
        context.openaiTruncationModeOverride,
        true
      );
    } finally {
      this.streamStarting = false;
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

    // Only need the current compaction epoch — if compaction already happened, the
    // original task prompt is summarized in the boundary and pre-boundary messages
    // aren't useful for replaying.
    const historyResult = await this.historyService.getHistoryFromLatestBoundary(this.workspaceId);
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
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // Abort the failed assistant placeholder and clean up partial/history state.
    this.activeCompactionRequest = undefined;
    this.resetActiveStreamState();
    if (!this.disposed) {
      this.clearQueue();
    }

    this.emitChatEvent({
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
      this.emitChatEvent(deleteMessage);
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
      this.emitChatEvent({
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

    this.streamStarting = true;
    let retryResult: Result<void, SendMessageError>;
    try {
      retryResult = await this.streamWithHistory(
        context.modelString,
        retryOptions,
        context.openaiTruncationModeOverride
      );
    } finally {
      this.streamStarting = false;
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

  private resetActiveStreamState(): void {
    this.activeStreamContext = undefined;
    this.activeStreamUserMessageId = undefined;
    this.activeStreamHadPostCompactionInjection = false;
    this.activeStreamHadAnyDelta = false;
    this.ackPendingPostCompactionStateOnStreamEnd = false;
  }

  private async handleStreamError(data: StreamErrorPayload): Promise<void> {
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

    if (hadCompactionRequest && !this.disposed) {
      this.clearQueue();
    }

    this.emitChatEvent(createStreamErrorMessage(data));
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
      this.activeStreamHadAnyDelta = true;
      this.emitChatEvent(payload);
    });
    forward("tool-call-start", (payload) => {
      this.activeStreamHadAnyDelta = true;
      this.emitChatEvent(payload);
    });
    forward("bash-output", (payload) => {
      this.activeStreamHadAnyDelta = true;
      this.emitChatEvent(payload);
    });
    forward("tool-call-delta", (payload) => {
      this.activeStreamHadAnyDelta = true;
      this.emitChatEvent(payload);
    });
    forward("tool-call-end", (payload) => {
      this.activeStreamHadAnyDelta = true;
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
      this.activeStreamHadAnyDelta = true;
      this.emitChatEvent(payload);
    });
    forward("reasoning-end", (payload) => this.emitChatEvent(payload));
    forward("usage-delta", (payload) => this.emitChatEvent(payload));
    forward("stream-abort", (payload) => {
      const hadCompactionRequest = this.activeCompactionRequest !== undefined;
      this.activeCompactionRequest = undefined;
      this.resetActiveStreamState();
      if (hadCompactionRequest && !this.disposed) {
        this.clearQueue();
      }
      this.emitChatEvent(payload);
    });
    forward("runtime-status", (payload) => this.emitChatEvent(payload));

    forward("stream-end", async (payload) => {
      this.activeCompactionRequest = undefined;
      const handled = await this.compactionHandler.handleCompletion(payload as StreamEndEvent);

      if (!handled) {
        this.emitChatEvent(payload);

        if (this.ackPendingPostCompactionStateOnStreamEnd) {
          this.ackPendingPostCompactionStateOnStreamEnd = false;
          try {
            await this.compactionHandler.ackPendingDiffsConsumed();
          } catch (error) {
            log.warn("Failed to ack pending post-compaction state", {
              workspaceId: this.workspaceId,
              error: error instanceof Error ? error.message : String(error),
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

      this.resetActiveStreamState();

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
      void this.handleStreamError({
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

    // Read the last message from history — only need 1 message, avoid full-file read
    const historyResult = await this.historyService.getLastMessages(this.workspaceId, 1);
    if (!historyResult.success || historyResult.data.length === 0) {
      return;
    }

    const lastMessage = historyResult.data[0];
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
    const pendingDiffs = await this.compactionHandler.peekPendingDiffs();
    if (pendingDiffs !== null) {
      this.ackPendingPostCompactionStateOnStreamEnd = true;
      this.compactionOccurred = true;
      this.turnsSinceLastAttachment = 0;
      // Clear file state cache since history context is gone
      this.fileChangeTracker.clear();

      // Load exclusions and persistent TODO state (local workspace session data)
      const excludedItems = await this.loadExcludedItems();
      const todoAttachment = await this.loadTodoListAttachment(excludedItems);

      // Get runtime for reading plan file
      const metadataResult = await this.aiService.getWorkspaceMetadata(this.workspaceId);
      if (!metadataResult.success) {
        // Can't get metadata, skip plan reference but still include other attachments
        const attachments: PostCompactionAttachment[] = [];

        if (todoAttachment) {
          attachments.push(todoAttachment);
        }

        const editedFilesRef = AttachmentService.generateEditedFilesAttachment(pendingDiffs);
        if (editedFilesRef) {
          attachments.push(editedFilesRef);
        }

        return attachments;
      }
      const runtime = createRuntimeForWorkspace(metadataResult.data);

      const attachments = await AttachmentService.generatePostCompactionAttachments(
        metadataResult.data.name,
        metadataResult.data.projectName,
        this.workspaceId,
        pendingDiffs,
        runtime,
        excludedItems
      );

      if (todoAttachment) {
        // Insert TODO after plan (if present), otherwise first.
        const planIndex = attachments.findIndex((att) => att.type === "plan_file_reference");
        const insertIndex = planIndex === -1 ? 0 : planIndex + 1;
        attachments.splice(insertIndex, 0, todoAttachment);
      }

      return attachments;
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
    // getHistoryFromLatestBoundary already returns only the active compaction epoch,
    // so no further boundary slicing is needed.
    const historyResult = await this.historyService.getHistoryFromLatestBoundary(this.workspaceId);
    if (!historyResult.success) {
      return [];
    }

    const fileDiffs = extractEditedFileDiffs(historyResult.data);

    // Load exclusions and persistent TODO state (local workspace session data)
    const excludedItems = await this.loadExcludedItems();
    const todoAttachment = await this.loadTodoListAttachment(excludedItems);

    // Get runtime for reading plan file
    const metadataResult = await this.aiService.getWorkspaceMetadata(this.workspaceId);
    if (!metadataResult.success) {
      // Can't get metadata, skip plan reference but still include other attachments
      const attachments: PostCompactionAttachment[] = [];

      if (todoAttachment) {
        attachments.push(todoAttachment);
      }

      const editedFilesRef = AttachmentService.generateEditedFilesAttachment(fileDiffs);
      if (editedFilesRef) {
        attachments.push(editedFilesRef);
      }

      return attachments;
    }
    const runtime = createRuntimeForWorkspace(metadataResult.data);

    const attachments = await AttachmentService.generatePostCompactionAttachments(
      metadataResult.data.name,
      metadataResult.data.projectName,
      this.workspaceId,
      fileDiffs,
      runtime,
      excludedItems
    );

    if (todoAttachment) {
      // Insert TODO after plan (if present), otherwise first.
      const planIndex = attachments.findIndex((att) => att.type === "plan_file_reference");
      const insertIndex = planIndex === -1 ? 0 : planIndex + 1;
      attachments.splice(insertIndex, 0, todoAttachment);
    }

    return attachments;
  }

  /**
   * Materialize @file mentions from a user message into a persisted snapshot message.
   *
   * This reads the referenced files once and creates a synthetic message containing
   * their content. The snapshot is persisted to history so subsequent sends don't
   * re-read the files (which would bust prompt cache if files changed).
   *
   * Also registers file state for change detection via <system-file-update> diffs.
   *
   * @returns The snapshot message and list of materialized mentions, or null if no mentions found
   */
  private async materializeFileAtMentionsSnapshot(
    messageText: string
  ): Promise<{ snapshotMessage: MuxMessage; materializedTokens: string[] } | null> {
    // Guard for test mocks that may not implement getWorkspaceMetadata
    if (typeof this.aiService.getWorkspaceMetadata !== "function") {
      return null;
    }

    const metadataResult = await this.aiService.getWorkspaceMetadata(this.workspaceId);
    if (!metadataResult.success) {
      log.debug("Cannot materialize @file mentions: workspace metadata not found", {
        workspaceId: this.workspaceId,
      });
      return null;
    }

    const metadata = metadataResult.data;
    const runtime = createRuntimeForWorkspace(metadata);
    const workspacePath = runtime.getWorkspacePath(metadata.projectPath, metadata.name);

    const materialized = await materializeFileAtMentions(messageText, {
      runtime,
      workspacePath,
    });

    if (materialized.length === 0) {
      return null;
    }

    // Register file state for each successfully read file (for change detection)
    for (const mention of materialized) {
      if (
        mention.content !== undefined &&
        mention.modifiedTimeMs !== undefined &&
        mention.resolvedPath
      ) {
        this.recordFileState(mention.resolvedPath, {
          content: mention.content,
          timestamp: mention.modifiedTimeMs,
        });
      }
    }

    // Create a synthetic snapshot message (not persisted here - caller handles persistence)
    const tokens = materialized.map((m) => m.token);
    const blocks = materialized.map((m) => m.block).join("\n\n");

    const snapshotId = createFileSnapshotMessageId();
    const snapshotMessage = createMuxMessage(snapshotId, "user", blocks, {
      timestamp: Date.now(),
      synthetic: true,
      fileAtMentionSnapshot: tokens,
    });

    return { snapshotMessage, materializedTokens: tokens };
  }

  private async materializeAgentSkillSnapshot(
    muxMetadata: MuxFrontendMetadata | undefined,
    disableWorkspaceAgents: boolean | undefined
  ): Promise<{ snapshotMessage: MuxMessage } | null> {
    if (!muxMetadata || muxMetadata.type !== "agent-skill") {
      return null;
    }

    // Guard for test mocks that may not implement getWorkspaceMetadata.
    if (typeof this.aiService.getWorkspaceMetadata !== "function") {
      return null;
    }

    const parsedName = SkillNameSchema.safeParse(muxMetadata.skillName);
    if (!parsedName.success) {
      throw new Error(`Invalid agent skill name: ${muxMetadata.skillName}`);
    }

    const metadataResult = await this.aiService.getWorkspaceMetadata(this.workspaceId);
    if (!metadataResult.success) {
      throw new Error("Cannot materialize agent skill: workspace metadata not found");
    }

    const metadata = metadataResult.data;
    const runtime = createRuntime(metadata.runtimeConfig, {
      projectPath: metadata.projectPath,
      workspaceName: metadata.name,
    });

    // In-place workspaces (CLI/benchmarks) have projectPath === name.
    // Use the path directly instead of reconstructing via getWorkspacePath.
    const isInPlace = metadata.projectPath === metadata.name;
    const workspacePath = isInPlace
      ? metadata.projectPath
      : runtime.getWorkspacePath(metadata.projectPath, metadata.name);

    // When workspace agents are disabled, resolve skills from the project path instead of
    // the worktree so skill invocation uses the same precedence/discovery root as the UI.
    const skillDiscoveryPath = disableWorkspaceAgents ? metadata.projectPath : workspacePath;

    const resolved = await readAgentSkill(runtime, skillDiscoveryPath, parsedName.data);
    const skill = resolved.package;

    const frontmatterYaml = YAML.stringify(skill.frontmatter).trimEnd();

    const body =
      skill.body.length > MAX_AGENT_SKILL_SNAPSHOT_CHARS
        ? `${skill.body.slice(0, MAX_AGENT_SKILL_SNAPSHOT_CHARS)}\n\n[Skill body truncated to ${MAX_AGENT_SKILL_SNAPSHOT_CHARS} characters]`
        : skill.body;

    const snapshotText = `<agent-skill name="${skill.frontmatter.name}" scope="${skill.scope}">\n${body}\n</agent-skill>`;

    // Include the parsed YAML frontmatter in the hash so frontmatter-only edits (e.g. description)
    // generate a new snapshot and keep the UI hover preview in sync.
    const sha256 = createHash("sha256")
      .update(JSON.stringify({ snapshotText, frontmatterYaml }))
      .digest("hex");

    // Dedupe: if we recently persisted the same snapshot, avoid inserting again.
    // Only need last 5 messages — avoid full-file read.
    const historyResult = await this.historyService.getLastMessages(this.workspaceId, 5);
    if (historyResult.success) {
      const recentSnapshot = [...historyResult.data]
        .reverse()
        .find((msg) => msg.metadata?.synthetic && msg.metadata?.agentSkillSnapshot);
      const recentMeta = recentSnapshot?.metadata?.agentSkillSnapshot;

      if (recentMeta?.skillName === skill.frontmatter.name && recentMeta.sha256 === sha256) {
        return null;
      }
    }

    const snapshotId = createAgentSkillSnapshotMessageId();
    const snapshotMessage = createMuxMessage(snapshotId, "user", snapshotText, {
      timestamp: Date.now(),
      synthetic: true,
      agentSkillSnapshot: {
        skillName: skill.frontmatter.name,
        scope: skill.scope,
        sha256,
        frontmatterYaml,
      },
    });

    return { snapshotMessage };
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

  private coerceTodoItems(value: unknown): TodoItem[] {
    if (!Array.isArray(value)) {
      return [];
    }

    const result: TodoItem[] = [];
    for (const item of value) {
      if (!item || typeof item !== "object") continue;

      const content = (item as { content?: unknown }).content;
      const status = (item as { status?: unknown }).status;

      if (typeof content !== "string") continue;
      if (status !== "pending" && status !== "in_progress" && status !== "completed") continue;

      result.push({ content, status });
    }

    return result;
  }

  private async loadTodoListAttachment(
    excludedItems: Set<string>
  ): Promise<PostCompactionAttachment | null> {
    if (excludedItems.has("todo")) {
      return null;
    }

    const todoPath = path.join(this.config.getSessionDir(this.workspaceId), "todos.json");

    try {
      const data = await readFile(todoPath, "utf-8");
      const parsed: unknown = JSON.parse(data);
      const todos = this.coerceTodoItems(parsed);
      if (todos.length === 0) {
        return null;
      }

      return {
        type: "todo_list",
        todos,
      };
    } catch {
      // File missing or unreadable
      return null;
    }
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
