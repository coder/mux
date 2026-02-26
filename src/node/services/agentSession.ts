import assert from "@/common/utils/assert";
import { EventEmitter } from "events";
import * as path from "path";
import { createHash } from "crypto";
import { mkdir, readFile, unlink, writeFile } from "fs/promises";
import type { LanguageModelV2Usage } from "@ai-sdk/provider";
import YAML from "yaml";
import { PlatformPaths } from "@/common/utils/paths";
import { log } from "@/node/services/log";
import type { Config } from "@/node/config";
import type { AIService } from "@/node/services/aiService";
import type { HistoryService } from "@/node/services/historyService";
import type { InitStateManager } from "@/node/services/initStateManager";

import type { FrontendWorkspaceMetadata, WorkspaceMetadata } from "@/common/types/workspace";
import type { RuntimeConfig } from "@/common/types/runtime";
import { DEFAULT_RUNTIME_CONFIG } from "@/common/constants/workspace";
import { DEFAULT_MODEL } from "@/common/constants/knownModels";
import { computePriorHistoryFingerprint } from "@/common/orpc/onChatCursorFingerprint";
import type {
  WorkspaceChatMessage,
  SendMessageOptions,
  FilePart,
  DeleteMessage,
  OnChatMode,
  OnChatCursor,
  ProvidersConfigMap,
} from "@/common/orpc/types";
import { WORKSPACE_DEFAULTS } from "@/constants/workspaceDefaults";
import type { SendMessageError } from "@/common/types/errors";
import type { StreamAbortReason } from "@/common/types/stream";
import { AgentIdSchema, SkillNameSchema } from "@/common/orpc/schemas";
import {
  buildStreamErrorEventData,
  createStreamErrorMessage,
  createUnknownSendMessageError,
  type StreamErrorPayload,
} from "@/node/services/utils/sendMessageError";
import {
  createAssistantMessageId,
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
import { coerceThinkingLevel } from "@/common/types/thinking";
import { enforceThinkingPolicy } from "@/common/utils/thinking/policy";
import {
  createMuxMessage,
  isCompactionSummaryMetadata,
  pickPreservedSendOptions,
  pickStartupRetrySendOptions,
  prepareUserMessageForSend,
  type CompactionFollowUpRequest,
  type MuxMessageMetadata,
  type MuxFilePart,
  type MuxMessage,
  type ReviewNoteDataForDisplay,
} from "@/common/types/message";
import { createRuntime } from "@/node/runtime/runtimeFactory";
import { createRuntimeForWorkspace } from "@/node/runtime/runtimeHelpers";
import { hasNonEmptyPlanFile } from "@/node/utils/runtime/helpers";
import { isExecLikeEditingCapableInResolvedChain } from "@/common/utils/agentTools";
import {
  readAgentDefinition,
  resolveAgentFrontmatter,
} from "@/node/services/agentDefinitions/agentDefinitionsService";
import { isAgentEffectivelyDisabled } from "@/node/services/agentDefinitions/agentEnablement";
import { resolveAgentInheritanceChain } from "@/node/services/agentDefinitions/resolveAgentInheritanceChain";
import { MessageQueue } from "./messageQueue";
import type { StreamEndEvent } from "@/common/types/stream";
import { CompactionHandler } from "./compactionHandler";
import { RetryManager, type RetryFailureError, type RetryStatusEvent } from "./retryManager";
import type { TelemetryService } from "./telemetryService";
import type { BackgroundProcessManager } from "./backgroundProcessManager";

import { AttachmentService } from "./attachmentService";
import type { TodoItem } from "@/common/types/tools";
import type { PostCompactionAttachment, PostCompactionExclusions } from "@/common/types/attachment";
import { TURNS_BETWEEN_ATTACHMENTS } from "@/common/constants/attachments";

import { extractEditedFileDiffs } from "@/common/utils/messages/extractEditedFiles";
import { buildCompactionMessageText } from "@/common/utils/compaction/compactionPrompt";
import type { AutoCompactionUsageState } from "@/common/utils/compaction/autoCompactionCheck";
import { getModelCapabilitiesResolved } from "@/common/utils/ai/modelCapabilities";
import {
  normalizeGatewayModel,
  isValidModelFormat,
  supports1MContext,
} from "@/common/utils/ai/models";
import {
  isNonRetryableSendError,
  isNonRetryableStreamError,
} from "@/common/utils/messages/retryEligibility";
import { createDisplayUsage } from "@/common/utils/tokens/displayUsage";
import { readAgentSkill } from "@/node/services/agentSkills/agentSkillsService";
import { materializeFileAtMentions } from "@/node/services/fileAtMentions";
import { getErrorMessage } from "@/common/utils/errors";
import { CompactionMonitor, type CompactionStatusEvent } from "./compactionMonitor";
import { coerceNonEmptyString } from "@/node/services/taskUtils";

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
  source?: "idle-compaction" | "auto-compaction";
  parsed: {
    followUpContent?: CompactionFollowUpRequest;
    // Legacy field - older persisted requests may use this instead of followUpContent
    continueMessage?: {
      text?: string;
      imageParts?: FilePart[];
      reviews?: ReviewNoteDataForDisplay[];
      muxMetadata?: MuxMessageMetadata;
      model?: string;
      agentId?: string;
      mode?: "exec" | "plan"; // Legacy: older versions stored mode instead of agentId
    };
  };
}

interface SwitchAgentResult {
  agentId: string;
  reason?: string;
  followUp?: string;
}

const MAX_CONSECUTIVE_AGENT_SWITCHES = 3;

const SAFE_AGENT_SWITCH_FALLBACK_CANDIDATES = ["exec", "ask", "plan"] as const;
const SWITCH_AGENT_TARGET_UNAVAILABLE_ERROR =
  "Agent handoff failed because the requested target is unavailable. Please retry or choose a different mode.";

const PDF_MEDIA_TYPE = "application/pdf";
const ACP_PROMPT_ID_METADATA_KEY = "acpPromptId";
const ACP_DELEGATED_TOOLS_METADATA_KEY = "acpDelegatedTools";

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

function normalizeAcpPromptId(candidate: unknown): string | undefined {
  if (typeof candidate !== "string") {
    return undefined;
  }

  const trimmed = candidate.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeDelegatedToolNames(candidate: unknown): string[] | undefined {
  if (!Array.isArray(candidate)) {
    return undefined;
  }

  const normalizedTools = candidate
    .filter((toolName): toolName is string => typeof toolName === "string")
    .map((toolName) => toolName.trim())
    .filter((toolName) => toolName.length > 0);

  if (normalizedTools.length === 0) {
    return undefined;
  }

  return [...new Set(normalizedTools)];
}

function extractAcpPromptId(muxMetadata: unknown): string | undefined {
  if (typeof muxMetadata !== "object" || muxMetadata == null || Array.isArray(muxMetadata)) {
    return undefined;
  }

  return normalizeAcpPromptId((muxMetadata as Record<string, unknown>)[ACP_PROMPT_ID_METADATA_KEY]);
}

function extractAcpDelegatedTools(muxMetadata: unknown): string[] | undefined {
  if (typeof muxMetadata !== "object" || muxMetadata == null || Array.isArray(muxMetadata)) {
    return undefined;
  }

  return normalizeDelegatedToolNames(
    (muxMetadata as Record<string, unknown>)[ACP_DELEGATED_TOOLS_METADATA_KEY]
  );
}
function isCompactionRequestMetadata(meta: unknown): meta is CompactionRequestMetadata {
  if (typeof meta !== "object" || meta === null) return false;
  const obj = meta as Record<string, unknown>;
  if (obj.type !== "compaction-request") return false;
  if (typeof obj.parsed !== "object" || obj.parsed === null) return false;
  return true;
}

const MAX_AGENT_SKILL_SNAPSHOT_CHARS = 50_000;
const AUTO_RETRY_PREFERENCE_FILE = "auto-retry-preference.json";
const STARTUP_AUTO_RETRY_HISTORY_FAILURE_BASE_DELAY_MS = 1_000;
const STARTUP_AUTO_RETRY_HISTORY_FAILURE_MAX_DELAY_MS = 30_000;

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

enum TurnPhase {
  IDLE = "idle",
  PREPARING = "preparing",
  STREAMING = "streaming",
  COMPLETING = "completing",
}

type StartupAutoRetryCheckOutcome = "completed" | "deferred";

export class AgentSession {
  private readonly workspaceId: string;
  private readonly config: Config;
  private readonly historyService: HistoryService;
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
  private turnPhase: TurnPhase = TurnPhase.IDLE;
  // When true, stream-end skips auto-flushing queued messages so an edit can truncate first.
  private deferQueuedFlushUntilAfterEdit = false;
  /** Guardrail against synthetic switch_agent ping-pong loops. */
  private consecutiveAgentSwitches = 0;

  private idleWaiters: Array<() => void> = [];
  private readonly messageQueue = new MessageQueue();
  private readonly compactionHandler: CompactionHandler;
  private readonly compactionMonitor: CompactionMonitor;

  private readonly retryManager: RetryManager;
  private lastAutoRetryOptions?: SendMessageOptions;
  /** Startup recovery should run once per session to avoid duplicate retry timers on reconnect. */
  private startupRecoveryScheduled = false;
  private startupRecoveryPromise: Promise<void> | null = null;
  private startupAutoRetryCheckScheduled = false;
  private startupAutoRetryCheckPromise: Promise<void> | null = null;
  private startupAutoRetryHistoryReadFailureCount = 0;
  private startupAutoRetryDeferredRetryDelayMs = 0;
  private autoRetryEnabledPreference: boolean | null = null;
  private legacyAutoRetryEnabledHint: boolean | null = null;
  private startupAutoRetryAbandon: { reason: string; userMessageId?: string } | null = null;

  /** Latest context-usage snapshot used for on-send compaction checks. */
  private lastUsageState?: AutoCompactionUsageState;

  /** Prevent duplicate mid-stream compaction interrupts while we are already transitioning. */
  private midStreamCompactionPending = false;

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

  /**
   * True when AIService has already emitted an `error` event for the current stream attempt.
   * Used to avoid duplicate retry scheduling when streamMessage later returns the same failure.
   */
  private activeStreamErrorEventReceived = false;

  /**
   * True when the latest streamWithHistory() failure path already updated retry/abandon state.
   * retryActiveStream() uses this to avoid double-processing handled failures.
   */
  private activeStreamFailureHandled = false;

  /** Tracks whether the current stream included post-compaction attachments. */
  private activeStreamHadPostCompactionInjection = false;

  /** Context needed to retry the current stream (cleared on stream end/abort/error). */
  private activeStreamContext?: {
    modelString: string;
    options?: SendMessageOptions;
    openaiTruncationModeOverride?: "auto" | "disabled";
    providersConfig: ProvidersConfigMap | null;
  };

  private activeCompactionRequest?: {
    id: string;
    modelString: string;
    options?: SendMessageOptions;
    source?: "idle-compaction" | "auto-compaction";
  };

  constructor(options: AgentSessionOptions) {
    assert(options, "AgentSession requires options");
    const {
      workspaceId,
      config,
      historyService,
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
    this.aiService = aiService;
    this.initStateManager = initStateManager;
    this.backgroundProcessManager = backgroundProcessManager;
    this.keepBackgroundProcesses = keepBackgroundProcesses ?? false;
    this.onCompactionComplete = onCompactionComplete;
    this.onPostCompactionStateChange = onPostCompactionStateChange;

    this.compactionHandler = new CompactionHandler({
      workspaceId: this.workspaceId,
      historyService: this.historyService,
      sessionDir: this.config.getSessionDir(this.workspaceId),
      telemetryService,
      emitter: this.emitter,
      onCompactionComplete,
    });

    this.compactionMonitor = new CompactionMonitor(
      this.workspaceId,
      (event: CompactionStatusEvent) => this.emitChatEvent(event)
    );

    this.retryManager = new RetryManager(
      this.workspaceId,
      async () => {
        await this.retryActiveStream();
      },
      (event) => this.emitRetryEvent(event)
    );

    this.attachAiListeners();
    this.attachInitListeners();
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;

    // Ensure any callers blocked on waitForIdle() can continue during teardown.
    this.setTurnPhase(TurnPhase.IDLE);

    this.retryManager.dispose();

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

    this.scheduleStartupRecovery();

    return unsubscribe;
  }

  async replayHistory(
    listener: (event: AgentSessionChatEvent) => void,
    mode?: OnChatMode
  ): Promise<void> {
    this.assertNotDisposed("replayHistory");
    assert(typeof listener === "function", "listener must be a function");
    await this.emitHistoricalEvents(listener, mode);
  }

  emitMetadata(metadata: FrontendWorkspaceMetadata | null): void {
    this.assertNotDisposed("emitMetadata");
    this.emitter.emit("metadata-event", {
      workspaceId: this.workspaceId,
      metadata,
    } satisfies AgentSessionMetadataEvent);
  }

  private getStreamLastTimestamp(streamInfo: {
    startTime?: number;
    parts: Array<{ timestamp?: number }>;
    toolCompletionTimestamps: Map<string, number>;
  }): number {
    // Use a nonzero floor so live-mode replay never sends afterTimestamp=0 when a
    // stream has started but no parts/completions are recorded yet.
    let streamLastTimestamp = streamInfo.startTime ?? 1;
    for (let index = streamInfo.parts.length - 1; index >= 0; index -= 1) {
      const timestamp = streamInfo.parts[index]?.timestamp;
      if (timestamp === undefined) {
        continue;
      }
      streamLastTimestamp = timestamp;
      break;
    }

    for (const completionTimestamp of streamInfo.toolCompletionTimestamps.values()) {
      if (completionTimestamp > streamLastTimestamp) {
        streamLastTimestamp = completionTimestamp;
      }
    }

    return streamLastTimestamp;
  }

  private emitRetryEvent(event: RetryStatusEvent): void {
    if (this.disposed) {
      return;
    }
    this.emitChatEvent(event);
  }

  private async handleStreamFailureForAutoRetry(error: RetryFailureError): Promise<void> {
    assert(
      typeof error.type === "string" && error.type.length > 0,
      "handleStreamFailureForAutoRetry requires a non-empty error.type"
    );

    // Load persisted preference before scheduling retries so an on-disk opt-out is
    // honored even when the first failure happens before startup recovery runs.
    await this.loadAutoRetryEnabledPreference();
    this.retryManager.handleStreamFailure(error);
  }

  private extractRetryFailureMessage(error: SendMessageError): string | undefined {
    if ("message" in error && typeof error.message === "string") {
      return error.message;
    }

    if ("raw" in error && typeof error.raw === "string") {
      return error.raw;
    }

    return undefined;
  }

  private async retryActiveStream(): Promise<void> {
    const options = this.lastAutoRetryOptions;
    if (!options) {
      this.emitRetryEvent({ type: "auto-retry-abandoned", reason: "missing_retry_options" });
      return;
    }

    const result = await this.resumeStream(options);
    if (result.success) {
      if (!result.data.started) {
        // resumeStream can defer when a turn is still PREPARING/COMPLETING.
        // Treat this as retriable so auto-retry keeps progressing instead of
        // stalling after the "auto-retry-starting" status event.
        await this.handleStreamFailureForAutoRetry({
          type: "unknown",
          message: "retry_deferred_busy",
        });
        return;
      }

      // Retry resumed the stream successfully. Clear stale startup-abandon markers now
      // (not only on stream-end) so a crash/restart mid-stream doesn't suppress recovery.
      await this.clearStartupAutoRetryAbandon();
      return;
    }

    if (this.activeStreamFailureHandled) {
      // resumeStream() failure paths already flowed through streamWithHistory() /
      // handleStreamError(), which scheduled retry and persisted abandon state.
      // Re-processing here would double-increment backoff attempts.
      return;
    }

    // Fallback: resumeStream() can fail before stream error handlers run
    // (for example commitPartial/history read failures). Handle those here so
    // auto-retry continues instead of stalling after auto-retry-starting.
    await this.handleStreamFailureForAutoRetry({
      type: result.error.type,
      message: this.extractRetryFailureMessage(result.error),
    });
    await this.updateStartupAutoRetryAbandonFromFailure(
      result.error.type,
      this.activeStreamUserMessageId
    );
  }

  private getAutoRetryPreferencePath(): string {
    return path.join(this.config.getSessionDir(this.workspaceId), AUTO_RETRY_PREFERENCE_FILE);
  }

  setLegacyAutoRetryEnabledHint(enabled: boolean): void {
    this.assertNotDisposed("setLegacyAutoRetryEnabledHint");
    assert(typeof enabled === "boolean", "setLegacyAutoRetryEnabledHint requires a boolean");

    if (this.autoRetryEnabledPreference !== null) {
      return;
    }

    this.legacyAutoRetryEnabledHint = enabled;
  }

  private parseStartupAutoRetryAbandon(
    value: unknown
  ): { reason: string; userMessageId?: string } | null {
    if (typeof value !== "object" || value === null) {
      return null;
    }

    const parsed = value as { reason?: unknown; userMessageId?: unknown };
    if (typeof parsed.reason !== "string" || parsed.reason.trim().length === 0) {
      return null;
    }

    const userMessageId =
      typeof parsed.userMessageId === "string" && parsed.userMessageId.trim().length > 0
        ? parsed.userMessageId
        : undefined;

    return {
      reason: parsed.reason,
      ...(userMessageId ? { userMessageId } : {}),
    };
  }

  private async loadAutoRetryEnabledPreference(): Promise<boolean> {
    if (this.autoRetryEnabledPreference !== null) {
      return this.autoRetryEnabledPreference;
    }

    const preferencePath = this.getAutoRetryPreferencePath();
    try {
      const raw = await readFile(preferencePath, "utf-8");
      const parsed = JSON.parse(raw) as {
        enabled?: unknown;
        startupAutoRetryAbandon?: unknown;
      };
      const enabled = parsed.enabled !== false;
      this.autoRetryEnabledPreference = enabled;
      this.legacyAutoRetryEnabledHint = null;
      this.startupAutoRetryAbandon = this.parseStartupAutoRetryAbandon(
        parsed.startupAutoRetryAbandon
      );
      this.retryManager.setEnabled(enabled);
      return enabled;
    } catch (error) {
      // Missing preference file is the default path. Use any legacy frontend hint
      // (captured at onChat subscribe time) before falling back to enabled.
      const errno =
        typeof error === "object" && error !== null && "code" in error
          ? (error as { code?: unknown }).code
          : undefined;
      const defaultEnabled =
        errno === "ENOENT" && this.legacyAutoRetryEnabledHint === false ? false : true;

      this.autoRetryEnabledPreference = defaultEnabled;
      this.legacyAutoRetryEnabledHint = null;
      this.startupAutoRetryAbandon = null;
      this.retryManager.setEnabled(defaultEnabled);

      if (errno === "ENOENT" && defaultEnabled === false) {
        // Persist migrated legacy opt-out so restart behavior no longer depends
        // on renderer localStorage keys.
        await this.persistAutoRetryState();
      } else if (errno !== "ENOENT") {
        log.warn("Failed to load auto-retry preference; defaulting to enabled", {
          workspaceId: this.workspaceId,
          error: getErrorMessage(error),
        });
      }

      return defaultEnabled;
    }
  }

  private async persistAutoRetryState(): Promise<void> {
    const preferencePath = this.getAutoRetryPreferencePath();
    const enabled = this.autoRetryEnabledPreference !== false;
    const hasStartupAbandonState = this.startupAutoRetryAbandon !== null;

    if (enabled && !hasStartupAbandonState) {
      try {
        await unlink(preferencePath);
      } catch (error) {
        const errno =
          typeof error === "object" && error !== null && "code" in error
            ? (error as { code?: unknown }).code
            : undefined;
        if (errno !== "ENOENT") {
          log.debug("Failed to clear auto-retry preference file", {
            workspaceId: this.workspaceId,
            error: getErrorMessage(error),
          });
        }
      }
      return;
    }

    const payload: {
      enabled?: false;
      startupAutoRetryAbandon?: { reason: string; userMessageId?: string };
    } = {};

    if (!enabled) {
      payload.enabled = false;
    }

    if (this.startupAutoRetryAbandon) {
      payload.startupAutoRetryAbandon = this.startupAutoRetryAbandon;
    }

    try {
      await mkdir(path.dirname(preferencePath), { recursive: true });
      await writeFile(preferencePath, JSON.stringify(payload) + "\n", "utf-8");
    } catch (error) {
      log.warn("Failed to persist auto-retry preference", {
        workspaceId: this.workspaceId,
        error: getErrorMessage(error),
      });
    }
  }

  private async persistAutoRetryEnabledPreference(enabled: boolean): Promise<void> {
    this.autoRetryEnabledPreference = enabled;
    await this.persistAutoRetryState();
  }

  private async persistStartupAutoRetryAbandon(
    reason: string,
    userMessageId?: string
  ): Promise<void> {
    this.startupAutoRetryAbandon = {
      reason,
      ...(userMessageId ? { userMessageId } : {}),
    };
    await this.persistAutoRetryState();
  }

  private async clearStartupAutoRetryAbandon(): Promise<void> {
    if (this.startupAutoRetryAbandon === null) {
      return;
    }

    this.startupAutoRetryAbandon = null;
    await this.persistAutoRetryState();
  }

  private async updateStartupAutoRetryAbandonFromFailure(
    errorType: string,
    userMessageId?: string
  ): Promise<void> {
    if (
      isNonRetryableSendError({ type: errorType }) ||
      isNonRetryableStreamError({ type: errorType })
    ) {
      await this.persistStartupAutoRetryAbandon(errorType, userMessageId);
      return;
    }

    await this.clearStartupAutoRetryAbandon();
  }

  private async updateStartupAutoRetryAbandonFromAbort(
    abortReason: StreamAbortReason | undefined,
    userMessageId?: string
  ): Promise<void> {
    // "system" and "startup" aborts come from backend-orchestrated flows
    // (for example, mid-stream auto-compaction or canceling a pending startup).
    // They are not user intent and must not poison startup recovery with a
    // persisted non-retryable "aborted" marker.
    if (abortReason === "system" || abortReason === "startup") {
      return;
    }

    await this.updateStartupAutoRetryAbandonFromFailure("aborted", userMessageId);
  }

  private isAiStreaming(): boolean {
    const aiService = this.aiService as Partial<Pick<AIService, "isStreaming">>;
    if (typeof aiService.isStreaming !== "function") {
      return false;
    }
    return aiService.isStreaming(this.workspaceId);
  }

  private normalizeStartupModel(model: unknown): string | undefined {
    if (typeof model !== "string") {
      return undefined;
    }

    const trimmed = model.trim();
    if (trimmed.length === 0) {
      return undefined;
    }

    const normalized = normalizeGatewayModel(trimmed);
    if (!isValidModelFormat(normalized)) {
      return undefined;
    }

    return normalized;
  }

  private normalizeAgentIdForRetry(agentId: unknown): string | undefined {
    if (typeof agentId !== "string") {
      return undefined;
    }

    const normalized = agentId.trim().toLowerCase();
    if (normalized.length === 0) {
      return undefined;
    }

    const parsed = AgentIdSchema.safeParse(normalized);
    return parsed.success ? parsed.data : undefined;
  }

  private isPendingAskUserQuestion(message: MuxMessage | null | undefined): boolean {
    if (!message || message.role !== "assistant") {
      return false;
    }

    return message.parts.some(
      (part) =>
        part.type === "dynamic-tool" &&
        part.toolName === "ask_user_question" &&
        part.state === "input-available"
    );
  }

  private isSyntheticSnapshotUserMessage(message: MuxMessage): boolean {
    return (
      message.role === "user" &&
      message.metadata?.synthetic === true &&
      (message.metadata.fileAtMentionSnapshot !== undefined ||
        message.metadata.agentSkillSnapshot !== undefined)
    );
  }

  private getLastNonSystemHistoryMessage(historyTail: MuxMessage[]): MuxMessage | undefined {
    for (let index = historyTail.length - 1; index >= 0; index -= 1) {
      const candidate = historyTail[index];
      if (candidate.role === "system") {
        continue;
      }
      if (this.isSyntheticSnapshotUserMessage(candidate)) {
        continue;
      }
      return candidate;
    }
    return undefined;
  }

  private async getWorkspaceMetadataForRetry(): Promise<WorkspaceMetadata | undefined> {
    const aiService = this.aiService as Partial<Pick<AIService, "getWorkspaceMetadata">>;
    if (typeof aiService.getWorkspaceMetadata !== "function") {
      return undefined;
    }

    const metadataResult = await aiService.getWorkspaceMetadata(this.workspaceId);
    if (!metadataResult.success) {
      return undefined;
    }

    return metadataResult.data;
  }

  private shouldUseUserMessageForRetry(message: MuxMessage): boolean {
    if (message.role !== "user") {
      return false;
    }

    if (this.isSyntheticSnapshotUserMessage(message)) {
      return false;
    }

    // Include UI-visible synthetic rows (e.g., crash-recovered compaction follow-ups)
    // so retries continue the most recent pending user intent.
    if (message.metadata?.synthetic === true) {
      return (
        message.metadata?.uiVisible === true ||
        isCompactionRequestMetadata(message.metadata?.muxMetadata)
      );
    }

    return true;
  }

  private async deriveStartupAutoRetryOptions(params: {
    partial: MuxMessage | null;
    historyTail: MuxMessage[];
  }): Promise<SendMessageOptions | undefined> {
    const lastUserMessage = [...params.historyTail]
      .reverse()
      .find((message): message is MuxMessage & { role: "user" } =>
        this.shouldUseUserMessageForRetry(message)
      );

    const lastAssistantMessage =
      params.partial?.role === "assistant"
        ? params.partial
        : [...params.historyTail]
            .reverse()
            .find(
              (message): message is MuxMessage & { role: "assistant" } =>
                message.role === "assistant"
            );

    const workspaceMetadata = await this.getWorkspaceMetadataForRetry();

    const persistedRetrySendOptions = lastUserMessage?.metadata?.retrySendOptions;

    const workspaceAgentId =
      this.normalizeAgentIdForRetry(workspaceMetadata?.agentId ?? workspaceMetadata?.agentType) ??
      WORKSPACE_DEFAULTS.agentId;
    const persistedAgentId = this.normalizeAgentIdForRetry(persistedRetrySendOptions?.agentId);
    const assistantAgentId = this.normalizeAgentIdForRetry(lastAssistantMessage?.metadata?.agentId);
    const baseAgentId = persistedAgentId ?? assistantAgentId ?? workspaceAgentId;

    const agentSettings =
      workspaceMetadata?.aiSettingsByAgent?.[baseAgentId] ??
      workspaceMetadata?.aiSettingsByAgent?.[workspaceAgentId] ??
      workspaceMetadata?.aiSettings;
    const compactSettings = workspaceMetadata?.aiSettingsByAgent?.compact;

    const persistedModel = this.normalizeStartupModel(persistedRetrySendOptions?.model);
    const baseModel =
      persistedModel ??
      this.normalizeStartupModel(lastAssistantMessage?.metadata?.model) ??
      this.normalizeStartupModel(agentSettings?.model) ??
      DEFAULT_MODEL;

    const persistedThinkingLevel = coerceThinkingLevel(persistedRetrySendOptions?.thinkingLevel);
    const baseThinkingLevel =
      persistedThinkingLevel ??
      coerceThinkingLevel(lastAssistantMessage?.metadata?.thinkingLevel) ??
      coerceThinkingLevel(agentSettings?.thinkingLevel);

    const persistedSystem1ThinkingLevel = coerceThinkingLevel(
      persistedRetrySendOptions?.system1ThinkingLevel
    );
    const persistedSystem1Model = this.normalizeStartupModel(
      persistedRetrySendOptions?.system1Model
    );

    const persistedToolPolicy =
      lastUserMessage?.metadata?.toolPolicy ?? persistedRetrySendOptions?.toolPolicy;
    const persistedDisableWorkspaceAgents =
      lastUserMessage?.metadata?.disableWorkspaceAgents ??
      persistedRetrySendOptions?.disableWorkspaceAgents;
    const persistedAdditionalSystemInstructions =
      persistedRetrySendOptions?.additionalSystemInstructions;
    const persistedMaxOutputTokens =
      typeof persistedRetrySendOptions?.maxOutputTokens === "number"
        ? persistedRetrySendOptions.maxOutputTokens
        : undefined;
    const persistedProviderOptions = persistedRetrySendOptions?.providerOptions;
    const persistedExperiments = persistedRetrySendOptions?.experiments;

    const lastUserMuxMetadata = lastUserMessage?.metadata?.muxMetadata;
    if (isCompactionRequestMetadata(lastUserMuxMetadata)) {
      const compactionModel =
        this.normalizeStartupModel(lastUserMuxMetadata.parsed.model) ?? baseModel;
      const requestedThinkingLevel =
        baseThinkingLevel ?? coerceThinkingLevel(compactSettings?.thinkingLevel) ?? "off";

      const compactionOptions: SendMessageOptions = {
        model: compactionModel,
        agentId: "compact",
        thinkingLevel: enforceThinkingPolicy(compactionModel, requestedThinkingLevel),
        maxOutputTokens:
          typeof lastUserMuxMetadata.parsed.maxOutputTokens === "number"
            ? lastUserMuxMetadata.parsed.maxOutputTokens
            : persistedMaxOutputTokens,
        toolPolicy: [{ regex_match: ".*", action: "disable" }],
        skipAiSettingsPersistence: true,
        disableWorkspaceAgents: persistedDisableWorkspaceAgents,
      };

      if (persistedAdditionalSystemInstructions !== undefined) {
        compactionOptions.additionalSystemInstructions = persistedAdditionalSystemInstructions;
      }
      if (persistedProviderOptions) {
        compactionOptions.providerOptions = persistedProviderOptions;
      }
      if (persistedExperiments) {
        compactionOptions.experiments = persistedExperiments;
      }
      if (persistedSystem1ThinkingLevel) {
        compactionOptions.system1ThinkingLevel = persistedSystem1ThinkingLevel;
      }
      if (persistedSystem1Model) {
        compactionOptions.system1Model = persistedSystem1Model;
      }

      return compactionOptions;
    }

    const retryOptions: SendMessageOptions = {
      model: baseModel,
      agentId: baseAgentId,
    };
    if (baseThinkingLevel) {
      retryOptions.thinkingLevel = baseThinkingLevel;
    }
    if (persistedSystem1ThinkingLevel) {
      retryOptions.system1ThinkingLevel = persistedSystem1ThinkingLevel;
    }
    if (persistedSystem1Model) {
      retryOptions.system1Model = persistedSystem1Model;
    }
    if (persistedToolPolicy) {
      retryOptions.toolPolicy = persistedToolPolicy;
    }
    if (persistedAdditionalSystemInstructions !== undefined) {
      retryOptions.additionalSystemInstructions = persistedAdditionalSystemInstructions;
    }
    if (persistedMaxOutputTokens !== undefined) {
      retryOptions.maxOutputTokens = persistedMaxOutputTokens;
    }
    if (persistedProviderOptions) {
      retryOptions.providerOptions = persistedProviderOptions;
    }
    if (persistedExperiments) {
      retryOptions.experiments = persistedExperiments;
    }
    if (typeof persistedDisableWorkspaceAgents === "boolean") {
      retryOptions.disableWorkspaceAgents = persistedDisableWorkspaceAgents;
    }

    return retryOptions;
  }

  async getStartupAutoRetryModelHint(): Promise<string | null> {
    this.assertNotDisposed("getStartupAutoRetryModelHint");

    if (this.lastAutoRetryOptions?.model) {
      return this.lastAutoRetryOptions.model;
    }

    const [partial, historyResult] = await Promise.all([
      this.historyService.readPartial(this.workspaceId),
      this.historyService.getLastMessages(this.workspaceId, 20),
    ]);
    if (!historyResult.success) {
      return null;
    }

    if (partial && this.isPendingAskUserQuestion(partial)) {
      return null;
    }

    const lastHistoryMessage = this.getLastNonSystemHistoryMessage(historyResult.data);
    const interruptedByPartial = partial?.role === "assistant";
    const interruptedByHistory =
      lastHistoryMessage?.role === "user" ||
      (lastHistoryMessage?.role === "assistant" &&
        lastHistoryMessage.metadata?.partial === true &&
        !this.isPendingAskUserQuestion(lastHistoryMessage));

    if (!interruptedByPartial && !interruptedByHistory) {
      return null;
    }

    const retryOptions = await this.deriveStartupAutoRetryOptions({
      partial,
      historyTail: historyResult.data,
    });
    return retryOptions?.model ?? null;
  }

  private resetStartupAutoRetryHistoryReadBackoff(): void {
    this.startupAutoRetryHistoryReadFailureCount = 0;
    this.startupAutoRetryDeferredRetryDelayMs = 0;
  }

  private markStartupAutoRetryHistoryReadFailure(): void {
    this.startupAutoRetryHistoryReadFailureCount += 1;
    const attempt = this.startupAutoRetryHistoryReadFailureCount - 1;
    const exponentialDelay =
      STARTUP_AUTO_RETRY_HISTORY_FAILURE_BASE_DELAY_MS * 2 ** Math.max(0, attempt);
    this.startupAutoRetryDeferredRetryDelayMs = Math.min(
      exponentialDelay,
      STARTUP_AUTO_RETRY_HISTORY_FAILURE_MAX_DELAY_MS
    );
  }

  private async scheduleStartupAutoRetryIfNeeded(): Promise<StartupAutoRetryCheckOutcome> {
    if (this.disposed || this.isBusy() || this.isAiStreaming()) {
      // Busy/streaming deferrals are state-driven; do not carry history-error backoff.
      this.startupAutoRetryDeferredRetryDelayMs = 0;
      return "deferred";
    }

    const autoRetryEnabled = await this.loadAutoRetryEnabledPreference();
    if (!autoRetryEnabled) {
      this.resetStartupAutoRetryHistoryReadBackoff();
      return "completed";
    }

    const [partial, historyResult] = await Promise.all([
      this.historyService.readPartial(this.workspaceId),
      this.historyService.getLastMessages(this.workspaceId, 20),
    ]);

    if (!historyResult.success) {
      this.markStartupAutoRetryHistoryReadFailure();
      log.warn("Failed to inspect history for startup auto-retry", {
        workspaceId: this.workspaceId,
        error: historyResult.error,
        retryDelayMs: this.startupAutoRetryDeferredRetryDelayMs,
        consecutiveHistoryReadFailures: this.startupAutoRetryHistoryReadFailureCount,
      });
      return "deferred";
    }

    this.resetStartupAutoRetryHistoryReadBackoff();

    if (partial && this.isPendingAskUserQuestion(partial)) {
      return "completed";
    }

    const lastHistoryMessage = this.getLastNonSystemHistoryMessage(historyResult.data);
    const interruptedByPartial = partial?.role === "assistant";
    const interruptedByHistory =
      lastHistoryMessage?.role === "user" ||
      (lastHistoryMessage?.role === "assistant" &&
        lastHistoryMessage.metadata?.partial === true &&
        !this.isPendingAskUserQuestion(lastHistoryMessage));

    if (!interruptedByPartial && !interruptedByHistory) {
      return "completed";
    }

    const startupRetryUserMessage = [...historyResult.data]
      .reverse()
      .find((message): message is MuxMessage & { role: "user" } =>
        this.shouldUseUserMessageForRetry(message)
      );

    if (this.startupAutoRetryAbandon) {
      const abandonReason = this.startupAutoRetryAbandon.reason;
      const abandonMatchesCurrentTail =
        this.startupAutoRetryAbandon.userMessageId === undefined ||
        this.startupAutoRetryAbandon.userMessageId === startupRetryUserMessage?.id;

      if (
        abandonMatchesCurrentTail &&
        (isNonRetryableSendError({ type: abandonReason }) ||
          isNonRetryableStreamError({ type: abandonReason }))
      ) {
        this.emitRetryEvent({ type: "auto-retry-abandoned", reason: abandonReason });
        return "completed";
      }
    }

    const retryOptions =
      this.lastAutoRetryOptions ??
      (await this.deriveStartupAutoRetryOptions({
        partial,
        historyTail: historyResult.data,
      }));

    if (!retryOptions) {
      this.emitRetryEvent({ type: "auto-retry-abandoned", reason: "missing_retry_options" });
      return "completed";
    }

    // Disk reads above may race with user actions; retry once the current work settles
    // instead of permanently suppressing startup auto-retry for this session.
    if (this.disposed || this.isBusy() || this.isAiStreaming()) {
      this.startupAutoRetryDeferredRetryDelayMs = 0;
      return "deferred";
    }

    this.lastAutoRetryOptions = retryOptions;
    await this.handleStreamFailureForAutoRetry({
      type: "unknown",
      message: "startup_interrupted_stream",
    });
    return "completed";
  }

  private async waitForStartupAutoRetryRerunWindow(retryDelayMs = 0): Promise<void> {
    const delayMs = Math.max(0, Math.trunc(retryDelayMs));
    if (delayMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      if (this.disposed) {
        return;
      }
    }

    while (!this.disposed) {
      await this.waitForIdle();
      if (!this.isAiStreaming()) {
        return;
      }

      await new Promise<void>((resolve) => {
        const maybeResolve = (...args: unknown[]) => {
          const [payload] = args;
          if (
            typeof payload === "object" &&
            payload !== null &&
            "workspaceId" in payload &&
            (payload as { workspaceId: unknown }).workspaceId !== this.workspaceId
          ) {
            return;
          }

          if (this.disposed || !this.isAiStreaming()) {
            cleanup();
            resolve();
          }
        };

        const cleanup = () => {
          this.aiService.off("stream-end", maybeResolve as never);
          this.aiService.off("stream-abort", maybeResolve as never);
          this.aiService.off("error", maybeResolve as never);
        };

        this.aiService.on("stream-end", maybeResolve as never);
        this.aiService.on("stream-abort", maybeResolve as never);
        this.aiService.on("error", maybeResolve as never);

        // Defensive: stream state may have changed between waitForIdle() and listener setup.
        maybeResolve({ workspaceId: this.workspaceId });
      });
    }
  }

  ensureStartupAutoRetryCheck(): void {
    if (this.disposed || this.startupAutoRetryCheckScheduled || this.startupAutoRetryCheckPromise) {
      return;
    }

    let rerunWhenIdle = false;

    this.startupAutoRetryCheckPromise = this.scheduleStartupAutoRetryIfNeeded()
      .then((outcome) => {
        if (outcome === "deferred") {
          this.startupAutoRetryCheckScheduled = false;
          rerunWhenIdle = true;
          return;
        }

        this.startupAutoRetryCheckScheduled = true;
      })
      .catch((error: unknown) => {
        this.startupAutoRetryCheckScheduled = true;
        log.warn("Startup auto-retry check failed", {
          workspaceId: this.workspaceId,
          error: getErrorMessage(error),
        });
      })
      .finally(() => {
        this.startupAutoRetryCheckPromise = null;

        if (!rerunWhenIdle || this.disposed) {
          return;
        }

        const rerunDelayMs = this.startupAutoRetryDeferredRetryDelayMs;
        this.startupAutoRetryDeferredRetryDelayMs = 0;

        void this.waitForStartupAutoRetryRerunWindow(rerunDelayMs).then(() => {
          if (!this.disposed) {
            this.ensureStartupAutoRetryCheck();
          }
        });
      });
  }

  scheduleStartupRecovery(): void {
    if (this.disposed || this.startupRecoveryScheduled || this.startupRecoveryPromise) {
      return;
    }

    // Crash recovery: check if the last message is a compaction summary with
    // a pending follow-up that was never dispatched. If so, dispatch it now.
    // This handles the case where the app crashed after compaction completed
    // but before the follow-up was sent.
    this.startupRecoveryPromise = this.dispatchPendingFollowUp()
      .then(() => {
        this.startupRecoveryScheduled = true;
      })
      .catch((error) => {
        this.startupRecoveryScheduled = false;
        log.warn("Failed to dispatch pending follow-up during startup recovery", {
          workspaceId: this.workspaceId,
          error: getErrorMessage(error),
        });
      })
      .finally(() => {
        this.startupRecoveryPromise = null;
        this.ensureStartupAutoRetryCheck();
      });
  }

  private async emitHistoricalEvents(
    listener: (event: AgentSessionChatEvent) => void,
    mode?: OnChatMode
  ): Promise<void> {
    let replayMode: "full" | "since" | "live" = "full";
    let hasOlderHistory: boolean | undefined;
    let serverCursor: OnChatCursor | undefined;
    let emittedReplayMessages = false;

    const emitReplayMessage = (message: WorkspaceChatMessage): void => {
      emittedReplayMessages = true;
      listener({ workspaceId: this.workspaceId, message });
    };

    let emittedReplayStreamEvents = false;
    const replayStreamEventTracker = (event: AgentSessionChatEvent) => {
      if (event.workspaceId !== this.workspaceId) {
        return;
      }

      const message = event.message;
      if (typeof message !== "object" || message === null) {
        return;
      }

      if (!("replay" in message) || message.replay !== true) {
        return;
      }

      emittedReplayStreamEvents = true;
    };
    this.emitter.on("chat-event", replayStreamEventTracker);

    // try/catch/finally guarantees caught-up is always sent, even if replay fails.
    // Without caught-up, the frontend stays in "Loading workspace..." forever.
    try {
      if (mode?.type === "live") {
        replayMode = "live";

        // Live mode still needs stream context when a response is currently active.
        // Replay only stream-start (no historical deltas/tool updates) so clients can
        // attach future live events to the correct message.
        const liveStreamInfo = this.aiService.getStreamInfo(this.workspaceId);
        if (liveStreamInfo) {
          const streamLastTimestamp = this.getStreamLastTimestamp(liveStreamInfo);
          await this.aiService.replayStream(this.workspaceId, {
            afterTimestamp: streamLastTimestamp,
          });

          // Stream can end while replayStream runs; only expose cursor when still active.
          const liveStreamInfoAfterReplay = this.aiService.getStreamInfo(this.workspaceId);
          if (liveStreamInfoAfterReplay) {
            serverCursor = {
              ...serverCursor,
              stream: {
                messageId: liveStreamInfoAfterReplay.messageId,
                lastTimestamp: this.getStreamLastTimestamp(liveStreamInfoAfterReplay),
              },
            };
          }
        }

        // Re-emit current init state in live mode too. If init finished while the
        // client was disconnected, replaying init-end clears stale "running" UI.
        await this.initStateManager.replayInit(this.workspaceId);

        return;
      }

      // Read partial BEFORE iterating history so we can skip the corresponding
      // placeholder message (which has empty parts). The partial has the real content.
      const streamInfo = this.aiService.getStreamInfo(this.workspaceId);
      const partial = await this.historyService.readPartial(this.workspaceId);
      const partialHistorySequence = partial?.metadata?.historySequence;

      // Load chat history from the latest compaction boundary onward (skip=0).
      // Older compaction epochs are fetched on demand through workspace.history.loadMore.
      const historyResult = await this.historyService.getHistoryFromLatestBoundary(
        this.workspaceId,
        0
      );

      let sinceHistorySequence: number | undefined;
      let afterTimestamp: number | undefined;

      if (historyResult.success) {
        const history = historyResult.data;

        // Cursor-based replay: only use incremental mode when all provided cursor segments are valid.
        const historyCursor = mode?.type === "since" ? mode.cursor.history : undefined;
        const streamCursor = mode?.type === "since" ? mode.cursor.stream : undefined;

        let oldestHistorySequence: number | undefined;
        for (const message of history) {
          const historySequence = message.metadata?.historySequence;
          if (historySequence === undefined) {
            continue;
          }

          if (oldestHistorySequence === undefined || historySequence < oldestHistorySequence) {
            oldestHistorySequence = historySequence;
          }
        }

        if (historyCursor) {
          const matchedHistoryCursor = history.find(
            (message) =>
              message.id === historyCursor.messageId &&
              message.metadata?.historySequence === historyCursor.historySequence
          );

          // Incremental history replay is safe only when we can prove no older
          // rows were truncated while disconnected. Require oldestHistorySequence
          // from the client cursor and match it against current server history.
          const oldestHistoryMatches =
            historyCursor.oldestHistorySequence !== undefined &&
            oldestHistorySequence !== undefined &&
            historyCursor.oldestHistorySequence === oldestHistorySequence;

          const hasRowsBeforeCursor =
            oldestHistorySequence !== undefined &&
            historyCursor.historySequence > oldestHistorySequence;

          // Defensively verify rows below the cursor are unchanged. Without this,
          // deleting or rewriting an older row while disconnected could leave stale
          // client state when since-mode append replay skips those older sequences.
          const priorHistoryFingerprint = computePriorHistoryFingerprint(
            history,
            historyCursor.historySequence
          );
          const priorHistoryMatches =
            !hasRowsBeforeCursor ||
            (historyCursor.priorHistoryFingerprint !== undefined &&
              priorHistoryFingerprint !== undefined &&
              historyCursor.priorHistoryFingerprint === priorHistoryFingerprint);

          if (matchedHistoryCursor && oldestHistoryMatches && priorHistoryMatches) {
            sinceHistorySequence = historyCursor.historySequence;
          }
        }

        if (streamCursor && streamInfo && streamCursor.messageId === streamInfo.messageId) {
          // Stream cursor is advisory: only apply it when the same stream is still active.
          // If the stream ended or rotated while offline, keep since-mode history replay
          // and skip stream filtering by leaving afterTimestamp undefined.
          const streamLastTimestamp = this.getStreamLastTimestamp(streamInfo);

          // Reconnect cursors can be ahead of server stream timestamps (e.g. replay events
          // stamped on the client clock). Clamp to server state so we never skip unseen
          // buffered deltas/tool completions on the next reconnect.
          afterTimestamp = Math.min(streamCursor.lastTimestamp, streamLastTimestamp);
        }

        // Since replay safety is anchored by a valid persisted-history cursor.
        // Stream cursor mismatches must not force a full replay when history is continuous.
        const canReplaySince = mode?.type === "since" && sinceHistorySequence !== undefined;

        if (canReplaySince) {
          replayMode = "since";
        } else {
          sinceHistorySequence = undefined;
          afterTimestamp = undefined;
        }

        if (replayMode === "full") {
          if (oldestHistorySequence === undefined) {
            // Empty full replay means there is no older page to request.
            hasOlderHistory = false;
          } else {
            hasOlderHistory = await this.historyService.hasHistoryBeforeSequence(
              this.workspaceId,
              oldestHistorySequence
            );
          }
        }

        for (const message of history) {
          // Skip the placeholder message if we have a partial with the same historySequence.
          // The placeholder has empty parts; the partial has the actual content.
          // Without this, both get loaded and the empty placeholder may be shown as "last message".
          if (
            partialHistorySequence !== undefined &&
            message.metadata?.historySequence === partialHistorySequence
          ) {
            continue;
          }

          // Incremental replay skips strictly older persisted messages.
          // We intentionally keep the cursor-boundary sequence (==) so reconnects can
          // replace an in-flight placeholder with the finalized turn when the stream
          // completed while the client was offline.
          if (sinceHistorySequence !== undefined) {
            const messageHistorySequence = message.metadata?.historySequence;
            if (
              messageHistorySequence !== undefined &&
              messageHistorySequence < sinceHistorySequence
            ) {
              continue;
            }
          }

          // Add type: "message" for discriminated union (messages from chat.jsonl don't have it)
          emitReplayMessage({ ...message, type: "message" });
        }

        for (let index = history.length - 1; index >= 0; index -= 1) {
          const message = history[index];
          const historySequence = message.metadata?.historySequence;
          if (historySequence === undefined) {
            continue;
          }

          const priorHistoryFingerprint = computePriorHistoryFingerprint(history, historySequence);

          serverCursor = {
            ...serverCursor,
            history: {
              messageId: message.id,
              historySequence,
              ...(oldestHistorySequence !== undefined ? { oldestHistorySequence } : {}),
              ...(priorHistoryFingerprint !== undefined ? { priorHistoryFingerprint } : {}),
            },
          };
          break;
        }
      }

      const attemptedStreamReplay = streamInfo !== undefined;
      if (streamInfo) {
        await this.aiService.replayStream(this.workspaceId, { afterTimestamp });
      }

      // Re-read stream state after replay. The stream can end while we are
      // replaying history, and caught-up cursor metadata must reflect that
      // latest backend state to avoid phantom active streams in the client.
      const streamInfoAfterReplay = this.aiService.getStreamInfo(this.workspaceId);
      if (streamInfoAfterReplay) {
        serverCursor = {
          ...serverCursor,
          stream: {
            messageId: streamInfoAfterReplay.messageId,
            lastTimestamp: this.getStreamLastTimestamp(streamInfoAfterReplay),
          },
        };
      } else if (!attemptedStreamReplay && partial) {
        // Only emit disk partial when we did not replay an active stream.
        // If a stream was replayed and then ended, this stale pre-replay partial can
        // duplicate text/tool output when combined with replayed stream events.
        emitReplayMessage({ ...partial, type: "message" });
      }

      // Re-emit current init state for all replay modes. Incremental reconnects can
      // otherwise miss init-end while disconnected and remain stuck in running state.
      await this.initStateManager.replayInit(this.workspaceId);
    } catch (error) {
      log.error("Failed to replay history for workspace", {
        workspaceId: this.workspaceId,
        error,
      });

      // Keep append/live semantics when we've already emitted incremental payload.
      // Downgrading to full at that point would make the frontend apply replace-mode to
      // a partial replay buffer and temporarily hide older transcript rows.
      if (replayMode !== "full" && !emittedReplayMessages && !emittedReplayStreamEvents) {
        replayMode = "full";
      }

      // Replay failed, so do not advertise a trustworthy reconnect cursor.
      serverCursor = undefined;
    } finally {
      this.emitter.off("chat-event", replayStreamEventTracker);

      // Replay queued-message snapshot before caught-up so reconnect clients can
      // rebuild queue UI state even when history replay errored mid-flight.
      listener({
        workspaceId: this.workspaceId,
        message: {
          type: "queued-message-changed",
          workspaceId: this.workspaceId,
          queuedMessages: this.messageQueue.getMessages(),
          displayText: this.messageQueue.getDisplayText(),
          fileParts: this.messageQueue.getFileParts(),
          reviews: this.messageQueue.getReviews(),
          hasCompactionRequest: this.messageQueue.hasCompactionRequest(),
        },
      });

      // Rehydrate pending auto-retry countdown state on reconnect/reload so
      // RetryBarrier keeps showing "Stop" while a backend timer is already armed.
      const pendingRetrySnapshot = this.retryManager.getScheduledStatusSnapshot();
      if (pendingRetrySnapshot) {
        listener({
          workspaceId: this.workspaceId,
          message: pendingRetrySnapshot,
        });
      }

      // Send caught-up after ALL historical data (including init events)
      // This signals frontend that replay is complete and future events are real-time
      listener({
        workspaceId: this.workspaceId,
        message: {
          type: "caught-up",
          replay: replayMode,
          ...(hasOlderHistory !== undefined ? { hasOlderHistory } : {}),
          cursor: serverCursor,
        },
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
    // Real user sends break any synthetic switch chain.
    if (!internal?.synthetic) {
      this.consecutiveAgentSwitches = 0;
    }

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
      // Ensure no in-flight completion code can append after we truncate.
      if (this.isBusy()) {
        // If a turn is still PREPARING/STREAMING, interrupt aggressively — history is about to be
        // truncated.
        //
        // If we're already COMPLETING, do NOT call stopStream(): StreamManager will emit a
        // synthetic stream-abort when no stream is active, which can incorrectly transition us to
        // IDLE while completion cleanup is still in-flight.
        if (this.turnPhase !== TurnPhase.COMPLETING) {
          // MUST use abandonPartial=true to prevent handleAbort from performing partial compaction
          // with mismatched history (since we're about to truncate it).
          const stopResult = await this.interruptStream({ abandonPartial: true });
          if (!stopResult.success) {
            log.warn("Failed to interrupt stream before edit", {
              workspaceId: this.workspaceId,
              editMessageId,
              error: stopResult.error,
            });
            return Err(createUnknownSendMessageError(stopResult.error));
          }
        }

        // Tell stream-end to skip sendQueuedMessages() so the edit truncates first.
        this.deferQueuedFlushUntilAfterEdit = true;
        try {
          await this.waitForIdle();

          // Workspace teardown does not await in-flight async work; bail out if the session was
          // disposed while waiting for completion cleanup.
          if (this.disposed) {
            return Ok(undefined);
          }
        } finally {
          this.deferQueuedFlushUntilAfterEdit = false;
        }
      }

      // The edit is about to truncate and rewrite history. Any queued content from
      // the previous turn was written in the old context — return it to the input
      // so the user can re-evaluate, and start the edit stream with an empty queue.
      this.restoreQueueToInput();

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
    const typedMuxMetadata = options?.muxMetadata as MuxMessageMetadata | undefined;
    const acpPromptId =
      normalizeAcpPromptId(options?.acpPromptId) ?? extractAcpPromptId(typedMuxMetadata);
    const delegatedToolNames =
      normalizeDelegatedToolNames(options?.delegatedToolNames) ??
      extractAcpDelegatedTools(typedMuxMetadata);
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
    let modelForStream = rawModelString.startsWith("mux-gateway:") ? rawModelString : options.model;
    const baseOptionsForStream = rawSystem1Model?.startsWith("mux-gateway:")
      ? { ...options, system1Model: rawSystem1Model }
      : options;
    let optionsForStream: SendMessageOptions = {
      ...baseOptionsForStream,
      ...(acpPromptId != null ? { acpPromptId } : {}),
      ...(delegatedToolNames != null ? { delegatedToolNames } : {}),
    };

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
        const caps = getModelCapabilitiesResolved(
          options.model,
          this.aiService.getProvidersConfig()
        );

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
        disableWorkspaceAgents: options?.disableWorkspaceAgents,
        retrySendOptions: pickStartupRetrySendOptions(optionsForStream),
        muxMetadata: typedMuxMetadata, // Pass through frontend metadata as black-box
        ...(acpPromptId != null ? { acpPromptId } : {}),
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
      return Err(createUnknownSendMessageError(getErrorMessage(error)));
    }

    // Check compaction threshold BEFORE persisting the user message.
    // Note: snapshots are materialized above, but persistence is deferred until after
    // this decision so on-send compaction can run against the pre-turn context.
    // Persisting snapshots too early can bloat the compaction request context and
    // make compaction itself fail near the context limit.
    // If on-send compaction is needed, we skip persisting the user's message now — it becomes
    // the follow-up content sent after compaction completes. This avoids duplicating the user
    // turn in model context (the compaction would otherwise summarize a transcript that already
    // contains the new prompt, then replay it again post-compaction).
    let autoCompactionMessage: MuxMessage | null = null;
    if (!isCompactionRequest && !editMessageId) {
      // Seed usage state from persisted history on the first send after restart
      // so the compaction monitor can detect context limits even before any live
      // stream events have populated lastUsageState.
      await this.seedUsageStateFromHistory();

      const providersConfigForCompaction = this.getProvidersConfigForCompaction();
      const compactionResult = this.compactionMonitor.checkBeforeSend({
        model: modelForStream,
        usage: this.getUsageState(),
        use1MContext: this.is1MContextEnabledForModel(modelForStream, optionsForStream),
        providersConfig: providersConfigForCompaction,
      });

      // On-send compaction uses the configured threshold directly so we compact
      // before dispatching a risky user turn near the context limit.
      // `shouldForceCompact` remains a stricter (threshold + buffer) signal for
      // mid-stream forcing where we want to avoid abrupt interruptions too early.
      const shouldCompactBeforeSend =
        compactionResult.usagePercentage >= compactionResult.thresholdPercentage;
      if (shouldCompactBeforeSend) {
        const followUpFileParts = effectiveFileParts?.map((part) => ({
          url: part.url,
          mediaType: part.mediaType,
          filename: part.filename,
        }));

        const followUpContent = this.buildAutoCompactionFollowUp({
          messageText: message,
          options: optionsForStream,
          modelForStream,
          fileParts: followUpFileParts,
          muxMetadata: typedMuxMetadata,
        });

        const autoCompactionRequest = this.buildAutoCompactionRequest({
          followUpContent,
          baseOptions: optionsForStream,
          reason: "on-send",
        });

        autoCompactionMessage = createMuxMessage(
          createUserMessageId(),
          "user",
          autoCompactionRequest.messageText,
          {
            timestamp: Date.now(),
            toolPolicy: autoCompactionRequest.sendOptions.toolPolicy,
            disableWorkspaceAgents: optionsForStream.disableWorkspaceAgents,
            retrySendOptions: pickStartupRetrySendOptions(autoCompactionRequest.sendOptions),
            muxMetadata: autoCompactionRequest.metadata,
            synthetic: true,
            uiVisible: true,
          }
        );

        // Persist compaction request (NOT the user message — it's the follow-up)
        const appendCompactionResult = await this.historyService.appendToHistory(
          this.workspaceId,
          autoCompactionMessage
        );
        if (!appendCompactionResult.success) {
          return Err(createUnknownSendMessageError(appendCompactionResult.error));
        }

        this.emitChatEvent({
          type: "auto-compaction-triggered",
          reason: "on-send",
          usagePercent: Math.round(compactionResult.usagePercentage),
        });

        modelForStream = autoCompactionRequest.sendOptions.model;
        optionsForStream = {
          ...autoCompactionRequest.sendOptions,
          muxMetadata: autoCompactionRequest.metadata,
        };
      }
    }

    // Persist snapshots only when this turn will be sent immediately.
    // On on-send compaction paths, snapshots are deferred with the follow-up turn.
    const shouldPersistTurnSnapshots = autoCompactionMessage === null;

    if (shouldPersistTurnSnapshots && snapshotResult?.snapshotMessage) {
      const snapshotAppendResult = await this.historyService.appendToHistory(
        this.workspaceId,
        snapshotResult.snapshotMessage
      );
      if (!snapshotAppendResult.success) {
        return Err(createUnknownSendMessageError(snapshotAppendResult.error));
      }
    }

    if (shouldPersistTurnSnapshots && skillSnapshotResult?.snapshotMessage) {
      const skillSnapshotAppendResult = await this.historyService.appendToHistory(
        this.workspaceId,
        skillSnapshotResult.snapshotMessage
      );
      if (!skillSnapshotAppendResult.success) {
        return Err(createUnknownSendMessageError(skillSnapshotAppendResult.error));
      }
    }

    // When on-send compaction triggers, the user message is NOT persisted to history
    // (it's sent as follow-up after compaction). Otherwise, persist normally.
    if (!autoCompactionMessage) {
      const appendResult = await this.historyService.appendToHistory(this.workspaceId, userMessage);
      if (!appendResult.success) {
        // Note: If we get here with snapshots, one or more snapshots may already be persisted but user message
        // failed. This is a rare edge case (disk full mid-operation). The next edit will clean up
        // the orphan via the truncation logic that removes preceding snapshots.
        return Err(createUnknownSendMessageError(appendResult.error));
      }
    }

    // Workspace may be tearing down while we await filesystem IO.
    // If so, skip event emission + streaming to avoid races with dispose().
    if (this.disposed) {
      return Ok(undefined);
    }

    // Emit snapshots only for immediately-sent turns. On on-send compaction paths,
    // snapshots are deferred with the follow-up message to avoid duplicate ephemeral
    // snapshot rows that were never persisted.
    if (shouldPersistTurnSnapshots && snapshotResult?.snapshotMessage) {
      this.emitChatEvent({ ...snapshotResult.snapshotMessage, type: "message" });
    }

    if (shouldPersistTurnSnapshots && skillSnapshotResult?.snapshotMessage) {
      this.emitChatEvent({ ...skillSnapshotResult.snapshotMessage, type: "message" });
    }

    // When on-send compaction triggers, the original user message is NOT emitted now —
    // it was not persisted and will be dispatched (persisted + emitted) as a follow-up
    // after compaction completes. Emitting it here would cause a duplicate in the
    // live transcript once the follow-up path re-sends the same text.
    if (autoCompactionMessage) {
      this.emitChatEvent({ ...autoCompactionMessage, type: "message" });
    } else {
      this.emitChatEvent({ ...userMessage, type: "message" });
    }

    // Only explicit user sends should reset auto-retry intent, and only after the
    // send has passed validation + been accepted into history.
    // Synthetic/system sends (mid-stream compaction, task recovery prompts, etc.)
    // must not silently opt users back into auto-retry after they've disabled it.
    if (internal?.synthetic !== true) {
      // A fresh accepted user send supersedes any persisted startup-abandon
      // classification from previous turns.
      await this.clearStartupAutoRetryAbandon();
      this.retryManager.cancel();
      this.retryManager.setEnabled(true);
      await this.persistAutoRetryEnabledPreference(true);
    }

    this.setTurnPhase(TurnPhase.PREPARING);

    try {
      // If this is a compaction request, terminate background processes first.
      // They won't be included in the summary, so continuing with orphaned processes would be confusing.
      const isCompactionStreamRequest = isCompactionRequest || autoCompactionMessage !== null;
      if (isCompactionStreamRequest && !this.keepBackgroundProcesses) {
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

      // Must await here so errors propagate back to sendMessage() callers.
      // Turn-phase transitions for success are driven by stream events.
      const result = await this.streamWithHistory(modelForStream, optionsForStream);
      return result;
    } finally {
      // Only transition to IDLE on failure; success transitions are driven by stream events.
      if (this.turnPhase === TurnPhase.PREPARING) {
        this.setTurnPhase(TurnPhase.IDLE);
      }
    }
  }

  async resumeStream(
    options: SendMessageOptions
  ): Promise<Result<{ started: boolean }, SendMessageError>> {
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
    // still waiting for init hooks to complete (or while completion cleanup is running).
    if (this.isBusy()) {
      return Ok({ started: false });
    }

    this.setTurnPhase(TurnPhase.PREPARING);
    try {
      // Must await here so the finally block runs after streaming completes,
      // not immediately when the Promise is returned.
      const result = await this.streamWithHistory(modelForStream, optionsForStream);
      if (!result.success) {
        return result;
      }

      return Ok({ started: true });
    } finally {
      if (this.turnPhase === TurnPhase.PREPARING) {
        this.setTurnPhase(TurnPhase.IDLE);
      }
    }
  }

  async setAutoRetryEnabled(
    enabled: boolean,
    options?: { persist?: boolean }
  ): Promise<{ previousEnabled: boolean; enabled: boolean }> {
    this.assertNotDisposed("setAutoRetryEnabled");
    assert(typeof enabled === "boolean", "setAutoRetryEnabled requires a boolean");

    const previousEnabled = await this.loadAutoRetryEnabledPreference();

    this.retryManager.setEnabled(enabled);
    if (!enabled) {
      this.retryManager.cancel();
    }

    if (options?.persist ?? true) {
      await this.persistAutoRetryEnabledPreference(enabled);
    }

    return { previousEnabled, enabled };
  }

  setAutoCompactionThreshold(threshold: number): void {
    this.assertNotDisposed("setAutoCompactionThreshold");
    this.compactionMonitor.setThreshold(threshold);
  }

  private getUsageState(): AutoCompactionUsageState | undefined {
    return this.lastUsageState;
  }

  private getProvidersConfigForCompaction(): ProvidersConfigMap | null {
    try {
      // Some unit tests provide a minimal Config mock without providers helpers.
      const maybeConfig = this.config as Config & {
        loadProvidersConfig?: () => ProvidersConfigMap | null;
      };
      if (typeof maybeConfig.loadProvidersConfig !== "function") {
        return null;
      }

      const providersConfig = maybeConfig.loadProvidersConfig();
      if (!providersConfig) {
        return null;
      }

      // Compaction limit resolution only reads provider model overrides (models[*].contextWindow*).
      // Runtime config stores these in providers.jsonc, so the raw config shape is sufficient here.
      return providersConfig as unknown as ProvidersConfigMap;
    } catch {
      // Best-effort read: if config cannot be loaded, keep null and rely on
      // built-in model limits. This matches prior behavior without crashing.
      return null;
    }
  }

  private is1MContextEnabledForModel(modelString: string, options?: SendMessageOptions): boolean {
    const normalizedModel = normalizeGatewayModel(modelString);
    if (!supports1MContext(normalizedModel)) {
      return false;
    }

    const anthropicOptions = options?.providerOptions?.anthropic;
    if (!anthropicOptions) {
      return false;
    }

    return (
      anthropicOptions.use1MContext === true ||
      anthropicOptions.use1MContextModels?.includes(normalizedModel) === true ||
      anthropicOptions.use1MContextModels?.includes(modelString) === true
    );
  }

  private updateUsageStateFromModelUsage(params: {
    model: string;
    usage: LanguageModelV2Usage | undefined;
    providerMetadata?: Record<string, unknown>;
    live: boolean;
  }): void {
    if (!params.usage) {
      return;
    }

    const usageForDisplay = createDisplayUsage(params.usage, params.model, params.providerMetadata);
    if (!usageForDisplay) {
      return;
    }

    const totalTokens = params.usage.totalTokens ?? this.lastUsageState?.totalTokens;
    if (params.live) {
      this.lastUsageState = {
        ...this.lastUsageState,
        liveUsage: usageForDisplay,
        totalTokens,
      };
      return;
    }

    this.lastUsageState = {
      ...this.lastUsageState,
      lastContextUsage: usageForDisplay,
      liveUsage: undefined,
      totalTokens,
    };
  }

  private clearLiveUsageState(): void {
    if (!this.lastUsageState?.liveUsage) {
      return;
    }

    this.lastUsageState = {
      ...this.lastUsageState,
      liveUsage: undefined,
    };
  }

  /**
   * Seed `lastUsageState` from persisted history so the compaction monitor
   * can trigger on-send compaction even when no live stream has occurred yet
   * (e.g., after an app restart). Walks the last N messages backwards to find
   * the most recent assistant message carrying `contextUsage` metadata.
   *
   * This is a lazy one-shot: called from `sendMessage` only when
   * `lastUsageState` is still undefined.
   */
  private async seedUsageStateFromHistory(): Promise<void> {
    if (this.lastUsageState !== undefined) {
      return;
    }

    try {
      // Seed from the active compaction epoch only. Using a generic tail read can
      // accidentally pull context usage from pre-boundary assistant rows after
      // compaction, which makes post-compaction turns immediately re-compact.
      const historyResult = await this.historyService.getHistoryFromLatestBoundary(
        this.workspaceId
      );
      if (!historyResult.success) {
        return;
      }

      // Walk backwards to find the most recent message with contextUsage.
      for (let i = historyResult.data.length - 1; i >= 0; i--) {
        const msg = historyResult.data[i];
        const meta = msg.metadata;
        if (!meta?.contextUsage || !meta.model) {
          continue;
        }

        this.updateUsageStateFromModelUsage({
          model: meta.model,
          usage: meta.contextUsage,
          providerMetadata: meta.contextProviderMetadata ?? meta.providerMetadata,
          live: false,
        });
        return;
      }
    } catch {
      // Best-effort: seeding is an optimization so the compaction monitor
      // works after restart. If it fails, the first live stream-end will
      // populate lastUsageState and compaction kicks in from then on.
    }
  }

  private buildAutoCompactionFollowUp(params: {
    messageText: string;
    options: SendMessageOptions;
    modelForStream: string;
    fileParts?: FilePart[];
    muxMetadata?: MuxMessageMetadata;
  }): CompactionFollowUpRequest {
    const followUp: CompactionFollowUpRequest = {
      text: params.messageText,
      model: params.modelForStream,
      agentId: params.options.agentId,
      ...pickPreservedSendOptions(params.options),
    };

    if (params.fileParts && params.fileParts.length > 0) {
      followUp.fileParts = params.fileParts;
    }

    if (params.muxMetadata) {
      followUp.muxMetadata = params.muxMetadata;
    }

    return followUp;
  }

  private getPreferredCompactionModel(): string | null {
    try {
      const maybeConfig = this.config as Config & {
        loadConfigOrDefault?: () => { preferredCompactionModel?: string } | null;
      };
      if (typeof maybeConfig.loadConfigOrDefault !== "function") {
        return null;
      }

      const preferredCompactionModel = maybeConfig.loadConfigOrDefault()?.preferredCompactionModel;
      if (typeof preferredCompactionModel !== "string") {
        return null;
      }

      const normalized = normalizeGatewayModel(preferredCompactionModel.trim());
      if (!isValidModelFormat(normalized)) {
        return null;
      }

      return normalized;
    } catch {
      return null;
    }
  }

  private buildAutoCompactionRequest(params: {
    followUpContent: CompactionFollowUpRequest;
    baseOptions: SendMessageOptions;
    reason: "on-send" | "mid-stream";
  }): {
    messageText: string;
    metadata: MuxMessageMetadata;
    sendOptions: SendMessageOptions;
  } {
    const compactionModel = this.getPreferredCompactionModel() ?? params.baseOptions.model;
    assert(
      typeof compactionModel === "string" && compactionModel.trim().length > 0,
      "auto-compaction requires a non-empty model"
    );

    const sendOptions: SendMessageOptions = {
      ...params.baseOptions,
      agentId: "compact",
      skipAiSettingsPersistence: true,
      model: compactionModel,
      thinkingLevel: enforceThinkingPolicy(
        compactionModel,
        params.baseOptions.thinkingLevel ?? "off"
      ),
      maxOutputTokens: undefined,
      toolPolicy: [{ regex_match: ".*", action: "disable" }],
    };

    const messageText = buildCompactionMessageText({ followUpContent: params.followUpContent });

    const metadata: MuxMessageMetadata = {
      type: "compaction-request",
      rawCommand: "/compact",
      commandPrefix: "/compact",
      parsed: {
        model: sendOptions.model,
        followUpContent: params.followUpContent,
      },
      requestedModel: sendOptions.model,
      source: "auto-compaction",
      displayStatus: {
        emoji: "🔄",
        message:
          params.reason === "on-send"
            ? "Auto-compacting before sending..."
            : "Auto-compacting to continue...",
      },
    };

    return {
      messageText,
      metadata,
      sendOptions,
    };
  }

  private async interruptForCompaction(): Promise<void> {
    if (this.midStreamCompactionPending || this.disposed) {
      return;
    }

    const streamContext = this.activeStreamContext;
    if (!streamContext?.modelString || !streamContext.options) {
      return;
    }

    const interruptedUserMessageId = this.activeStreamUserMessageId;

    this.midStreamCompactionPending = true;
    try {
      const stopResult = await this.aiService.stopStream(this.workspaceId, {
        abortReason: "system",
      });
      if (!stopResult.success) {
        log.warn("Failed to stop stream for mid-stream compaction", {
          workspaceId: this.workspaceId,
          error: stopResult.error,
        });
        return;
      }

      await this.waitForIdle();
      if (this.disposed) {
        return;
      }

      const followUpContent = this.buildAutoCompactionFollowUp({
        // Keep mid-stream auto-compaction on the shared default sentinel so
        // buildCompactionMessageText can hide the internal resume marker.
        messageText: "Continue",
        options: streamContext.options,
        modelForStream: streamContext.modelString,
      });
      const autoCompactionRequest = this.buildAutoCompactionRequest({
        followUpContent,
        baseOptions: streamContext.options,
        reason: "mid-stream",
      });

      const sendResult = await this.sendMessage(
        autoCompactionRequest.messageText,
        {
          ...autoCompactionRequest.sendOptions,
          muxMetadata: autoCompactionRequest.metadata,
        },
        { synthetic: true }
      );
      if (!sendResult.success) {
        log.warn("Failed to dispatch mid-stream compaction request", {
          workspaceId: this.workspaceId,
          error: sendResult.error,
        });

        const failureType = sendResult.error.type;
        const handledByNestedSend = this.activeStreamFailureHandled;

        if (!handledByNestedSend) {
          await this.handleStreamFailureForAutoRetry({
            type: failureType,
            message: this.extractRetryFailureMessage(sendResult.error),
          });
          await this.updateStartupAutoRetryAbandonFromFailure(
            failureType,
            interruptedUserMessageId
          );
        }

        if (
          !handledByNestedSend ||
          failureType === "runtime_not_ready" ||
          failureType === "runtime_start_failed"
        ) {
          // Mid-stream compaction already interrupted the original turn. Surface the
          // nested dispatch failure so the user gets an explicit retry/error affordance.
          const streamError = buildStreamErrorEventData(sendResult.error);
          this.emitChatEvent(createStreamErrorMessage(streamError));
        }
      }
    } finally {
      this.midStreamCompactionPending = false;
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

    // Explicit user interruption should immediately stop any pending auto-retry loop.
    this.retryManager.cancel();

    // For hard interrupts, delete partial BEFORE stopping to prevent abort handler
    // from committing it. For soft interrupts, defer to stream-abort handler since
    // the stream continues running and would recreate the partial.
    if (options?.abandonPartial && !options?.soft) {
      const deleteResult = await this.historyService.deletePartial(this.workspaceId);
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
    this.compactionMonitor.resetForNewStream();
    this.clearLiveUsageState();
    this.ackPendingPostCompactionStateOnStreamEnd = false;
    this.activeStreamHadAnyDelta = false;
    this.activeStreamErrorEventReceived = false;
    this.activeStreamFailureHandled = false;
    this.activeStreamHadPostCompactionInjection = false;
    this.lastAutoRetryOptions = options;
    const providersConfigForCompaction = this.getProvidersConfigForCompaction();
    this.activeStreamContext = {
      modelString,
      options,
      openaiTruncationModeOverride,
      providersConfig: providersConfigForCompaction,
    };
    this.activeStreamUserMessageId = undefined;

    const commitResult = await this.historyService.commitPartial(this.workspaceId);
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

    const acpPromptId =
      normalizeAcpPromptId(options?.acpPromptId) ?? extractAcpPromptId(options?.muxMetadata);
    const delegatedToolNames =
      normalizeDelegatedToolNames(options?.delegatedToolNames) ??
      extractAcpDelegatedTools(options?.muxMetadata);

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
      acpPromptId,
      delegatedToolNames,
      recordFileState,
      changedFileAttachments:
        changedFileAttachments.length > 0 ? changedFileAttachments : undefined,
      postCompactionAttachments,
      experiments: options?.experiments,
      system1Model: options?.system1Model,
      system1ThinkingLevel: options?.system1ThinkingLevel,
      disableWorkspaceAgents: options?.disableWorkspaceAgents,
      hasQueuedMessage: () =>
        !this.messageQueue.isEmpty() && this.messageQueue.getQueueDispatchMode() === "tool-end",
      openaiTruncationModeOverride,
    });

    if (!streamResult.success) {
      // Deduplicate failures when AIService already emitted an `error` event for
      // this stream attempt. attachAiListeners schedules retry via handleStreamError
      // on that channel; re-handling here would bump attempt/backoff twice.
      if (this.activeStreamErrorEventReceived) {
        this.activeStreamFailureHandled = true;
        return streamResult;
      }

      const failureType = streamResult.error.type;

      // Runtime startup failures can happen before any stream events are emitted.
      // Handle them directly when the `error` channel did not fire.
      if (failureType === "runtime_not_ready" || failureType === "runtime_start_failed") {
        this.activeStreamFailureHandled = true;
        const failedUserMessageId = this.activeStreamUserMessageId;
        this.activeCompactionRequest = undefined;
        this.resetActiveStreamState();
        await this.handleStreamFailureForAutoRetry({
          type: failureType,
          message: this.extractRetryFailureMessage(streamResult.error),
        });
        await this.updateStartupAutoRetryAbandonFromFailure(failureType, failedUserMessageId);
      } else {
        this.activeStreamFailureHandled = true;
        const streamError = buildStreamErrorEventData(streamResult.error, {
          acpPromptId,
        });
        await this.handleStreamError(streamError);
      }
    }

    return streamResult;
  }

  private resolveCompactionRequest(
    history: MuxMessage[],
    modelString: string,
    options?: SendMessageOptions
  ):
    | {
        id: string;
        modelString: string;
        options?: SendMessageOptions;
        source?: "idle-compaction" | "auto-compaction";
      }
    | undefined {
    for (let index = history.length - 1; index >= 0; index -= 1) {
      const message = history[index];
      if (message.role !== "user") {
        continue;
      }
      const muxMetadata = message.metadata?.muxMetadata;
      if (!isCompactionRequestMetadata(muxMetadata)) {
        return undefined;
      }
      return {
        id: message.id,
        modelString,
        options,
        source: muxMetadata.source,
      };
    }
    return undefined;
  }

  private async clearFailedAssistantMessage(messageId: string, reason: string): Promise<void> {
    const [partialResult, deleteMessageResult] = await Promise.all([
      this.historyService.deletePartial(this.workspaceId),
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
      (lower.startsWith("claude-sonnet-4-5") ||
        lower.startsWith("claude-sonnet-4-6") ||
        lower.startsWith("claude-opus-4-6"))
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
    this.setTurnPhase(TurnPhase.PREPARING);
    let retryResult: Result<void, SendMessageError>;
    try {
      retryResult = await this.streamWithHistory(
        context.modelString,
        retryOptions,
        isGptClass ? "auto" : undefined
      );
    } finally {
      if (this.turnPhase === TurnPhase.PREPARING) {
        this.setTurnPhase(TurnPhase.IDLE);
      }
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
    this.emitChatEvent({
      type: "stream-abort",
      workspaceId: this.workspaceId,
      messageId: data.messageId,
    });
    await this.clearFailedAssistantMessage(data.messageId, "post-compaction-retry");

    // Retry the same request, but without post-compaction injection.
    this.setTurnPhase(TurnPhase.PREPARING);
    let retryResult: Result<void, SendMessageError>;
    try {
      retryResult = await this.streamWithHistory(
        context.modelString,
        context.options,
        context.openaiTruncationModeOverride,
        true
      );
    } finally {
      if (this.turnPhase === TurnPhase.PREPARING) {
        this.setTurnPhase(TurnPhase.IDLE);
      }
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
        error: getErrorMessage(error),
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

    const partialDeleteResult = await this.historyService.deletePartial(this.workspaceId);
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

    this.setTurnPhase(TurnPhase.PREPARING);
    let retryResult: Result<void, SendMessageError>;
    try {
      retryResult = await this.streamWithHistory(
        context.modelString,
        retryOptions,
        context.openaiTruncationModeOverride
      );
    } finally {
      if (this.turnPhase === TurnPhase.PREPARING) {
        this.setTurnPhase(TurnPhase.IDLE);
      }
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
    this.setTurnPhase(TurnPhase.COMPLETING);

    this.clearLiveUsageState();
    const hadCompactionRequest = this.activeCompactionRequest !== undefined;
    if (
      await this.maybeRetryCompactionOnContextExceeded({
        messageId: data.messageId,
        errorType: data.errorType,
      })
    ) {
      return; // retry set PREPARING
    }

    if (
      await this.maybeRetryWithoutPostCompactionOnContextExceeded({
        messageId: data.messageId,
        errorType: data.errorType,
      })
    ) {
      return; // retry set PREPARING
    }

    if (
      await this.maybeHardRestartExecSubagentOnContextExceeded({
        messageId: data.messageId,
        errorType: data.errorType,
      })
    ) {
      return; // retry set PREPARING
    }

    // Terminal error — no retry succeeded
    const failedUserMessageId = this.activeStreamUserMessageId;
    const failureType = data.errorType ?? "unknown";
    this.activeCompactionRequest = undefined;
    this.resetActiveStreamState();

    if (hadCompactionRequest && !this.disposed) {
      this.clearQueue();
    }

    await this.handleStreamFailureForAutoRetry({
      type: failureType,
      message: data.error,
    });
    await this.updateStartupAutoRetryAbandonFromFailure(failureType, failedUserMessageId);

    this.emitChatEvent(createStreamErrorMessage(data));
    this.setTurnPhase(TurnPhase.IDLE);
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

    forward("stream-start", (payload) => {
      this.setTurnPhase(TurnPhase.STREAMING);
      this.emitChatEvent(payload);
    });
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
    forward("usage-delta", async (payload) => {
      this.emitChatEvent(payload);

      if (payload.type !== "usage-delta") {
        return;
      }

      const modelForUsage = this.activeStreamContext?.modelString;
      if (!modelForUsage) {
        return;
      }

      this.updateUsageStateFromModelUsage({
        model: modelForUsage,
        usage: payload.usage,
        providerMetadata: payload.providerMetadata,
        live: true,
      });

      // Never recurse compaction while we're already running a compaction request.
      if (this.activeCompactionRequest || this.midStreamCompactionPending) {
        return;
      }

      const streamContext = this.activeStreamContext;
      const streamOptions = streamContext?.options;
      const shouldInterruptForCompaction = this.compactionMonitor.checkMidStream({
        model: modelForUsage,
        usage: payload.usage,
        use1MContext: this.is1MContextEnabledForModel(modelForUsage, streamOptions),
        providersConfig: streamContext?.providersConfig ?? null,
      });

      if (shouldInterruptForCompaction) {
        await this.interruptForCompaction();
      }
    });
    forward("stream-abort", async (payload) => {
      if (payload.type !== "stream-abort") {
        this.emitChatEvent(payload);
        return;
      }

      // stopStream() emits synthetic aborts even when no real stream is active
      // (e.g., during PREPARING or after COMPLETING). We must still forward the
      // event to the renderer so it clears "starting…" / "interrupting…" UI, but
      // we must NOT clobber the turn phase or reset stream state — the originating
      // code path handles its own transition back to IDLE:
      //   PREPARING → sendMessage error handler / sendQueuedMessages .then() handler
      //   COMPLETING → stream-end finally block
      if (this.turnPhase !== TurnPhase.STREAMING) {
        log.debug("Forwarding stream-abort without phase transition (not in STREAMING)", {
          workspaceId: this.workspaceId,
          turnPhase: this.turnPhase,
        });

        const preStreamAbortReason = "abortReason" in payload ? payload.abortReason : undefined;
        await this.updateStartupAutoRetryAbandonFromAbort(
          preStreamAbortReason,
          this.activeStreamUserMessageId
        );

        this.emitChatEvent(payload);
        return;
      }

      this.setTurnPhase(TurnPhase.COMPLETING);
      const activeModelForAbort = this.activeStreamContext?.modelString;
      if (activeModelForAbort) {
        this.updateUsageStateFromModelUsage({
          model: activeModelForAbort,
          usage: payload.metadata?.contextUsage,
          providerMetadata:
            payload.metadata?.contextProviderMetadata ?? payload.metadata?.providerMetadata,
          live: false,
        });
      }
      this.clearLiveUsageState();

      const failedUserMessageId = this.activeStreamUserMessageId;
      const hadCompactionRequest = this.activeCompactionRequest !== undefined;
      this.activeCompactionRequest = undefined;
      this.resetActiveStreamState();
      if (hadCompactionRequest && !this.disposed) {
        this.clearQueue();
      }
      const abortReason = "abortReason" in payload ? payload.abortReason : undefined;
      await this.handleStreamFailureForAutoRetry({
        type: "aborted",
        message: abortReason,
      });
      await this.updateStartupAutoRetryAbandonFromAbort(abortReason, failedUserMessageId);
      this.emitChatEvent(payload);
      this.setTurnPhase(TurnPhase.IDLE);
    });
    forward("runtime-status", (payload) => this.emitChatEvent(payload));

    forward("stream-end", async (payload) => {
      if (payload.type !== "stream-end") {
        this.emitChatEvent(payload);
        return;
      }

      this.setTurnPhase(TurnPhase.COMPLETING);
      this.retryManager.handleStreamSuccess();
      await this.clearStartupAutoRetryAbandon();

      const streamEndPayload = payload;
      const activeStreamOptions = this.activeStreamContext?.options;

      let emittedStreamEnd = false;
      let handoffFailureMessage: string | undefined;
      try {
        const completedCompactionRequest = this.activeCompactionRequest;
        this.activeCompactionRequest = undefined;
        this.updateUsageStateFromModelUsage({
          model: streamEndPayload.metadata.model,
          usage: streamEndPayload.metadata.contextUsage,
          providerMetadata:
            streamEndPayload.metadata.contextProviderMetadata ??
            streamEndPayload.metadata.providerMetadata,
          live: false,
        });
        this.clearLiveUsageState();

        const handled = await this.compactionHandler.handleCompletion(streamEndPayload);

        if (!handled) {
          this.emitChatEvent(payload);
          emittedStreamEnd = true;

          if (this.ackPendingPostCompactionStateOnStreamEnd) {
            this.ackPendingPostCompactionStateOnStreamEnd = false;
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
          // CompactionHandler emits its own sanitized stream-end; mark as handled
          // so the catch block doesn't re-emit the unsanitized original payload.
          emittedStreamEnd = true;

          // Compaction collapses history to a boundary summary, so prior context-usage snapshots
          // are stale. Clear them to prevent immediate re-trigger loops on the follow-up turn.
          this.lastUsageState = undefined;

          if (completedCompactionRequest?.source === "auto-compaction") {
            this.emitChatEvent({
              type: "auto-compaction-completed",
              newUsagePercent: 0,
            });
          }

          this.onCompactionComplete?.();
        }

        // IMPORTANT: reset BEFORE anything that can start a new stream,
        // so the next turn doesn't get its state clobbered by our cleanup.
        this.resetActiveStreamState();

        if (handled) {
          // Dispatch follow-up AFTER reset so it can set its own stream state.
          await this.dispatchPendingFollowUp();
        }

        const switchResult = this.extractSwitchAgentResult(streamEndPayload);
        if (switchResult) {
          try {
            const dispatchedSwitchFollowUp = await this.dispatchAgentSwitch(
              switchResult,
              activeStreamOptions,
              streamEndPayload.metadata.model
            );
            if (dispatchedSwitchFollowUp) {
              return;
            }
          } catch (error) {
            handoffFailureMessage = getErrorMessage(error);
            throw error;
          }
        }

        // Stream end: auto-send queued messages (for user messages typed during streaming)
        // P2: if an edit is waiting, skip the queue flush so the edit truncates first.
        if (this.deferQueuedFlushUntilAfterEdit) {
          // Clear the queued message flag so the next turn's tools don't early-return.
          this.backgroundProcessManager.setMessageQueued(this.workspaceId, false);
        } else {
          this.sendQueuedMessages();
        }
      } catch (error) {
        const streamEndCleanupError = getErrorMessage(error);
        log.error("stream-end cleanup failed", {
          workspaceId: this.workspaceId,
          error: streamEndCleanupError,
        });

        if (handoffFailureMessage != null) {
          this.emitChatEvent(
            createStreamErrorMessage({
              messageId: createAssistantMessageId(),
              error: `An unexpected error occurred during agent handoff: ${handoffFailureMessage}`,
              errorType: "unknown",
            })
          );
        }

        // Defense-in-depth: unblock renderer if compaction handler threw before we emitted.
        if (!emittedStreamEnd) {
          try {
            this.emitChatEvent(payload);
          } catch {
            // Best-effort; don't mask the original error.
          }
        }
      } finally {
        // Only clean up if we're still in COMPLETING — a new turn started by
        // dispatchPendingFollowUp(), dispatchAgentSwitch(), or sendQueuedMessages()
        // owns the stream state now.
        if (this.turnPhase === TurnPhase.COMPLETING) {
          this.resetActiveStreamState();
          this.setTurnPhase(TurnPhase.IDLE);
        }
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
      const data = raw as StreamErrorPayload & { workspaceId: string };
      this.activeStreamErrorEventReceived = true;
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

  private setTurnPhase(next: TurnPhase): void {
    this.turnPhase = next;

    if (next === TurnPhase.IDLE) {
      const waiters = this.idleWaiters;
      this.idleWaiters = [];
      for (const resolve of waiters) {
        resolve();
      }
    }
  }

  isBusy(): boolean {
    return this.turnPhase !== TurnPhase.IDLE;
  }

  isPreparingTurn(): boolean {
    return this.turnPhase === TurnPhase.PREPARING;
  }

  // Back-compat alias; prefer isPreparingTurn() + isBusy().
  isStreamStarting(): boolean {
    return this.isPreparingTurn();
  }

  async waitForIdle(): Promise<void> {
    if (this.turnPhase === TurnPhase.IDLE) {
      return;
    }

    await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }

  queueMessage(
    message: string,
    options?: SendMessageOptions & { fileParts?: FilePart[] },
    internal?: { synthetic?: boolean }
  ): "tool-end" | "turn-end" | null {
    this.assertNotDisposed("queueMessage");
    const didEnqueue = this.messageQueue.add(message, options, internal);
    if (!didEnqueue) {
      return null;
    }
    this.emitQueuedMessageChanged();
    // Signal to bash_output that it should return early to process queued messages
    // only for tool-end dispatches.
    const effectiveDispatchMode = this.messageQueue.getQueueDispatchMode();
    this.backgroundProcessManager.setMessageQueued(
      this.workspaceId,
      effectiveDispatchMode === "tool-end"
    );
    return effectiveDispatchMode;
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
      this.clearQueue();

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
      const { message, options, internal } = this.messageQueue.produceMessage();
      this.messageQueue.clear();
      this.emitQueuedMessageChanged();

      // Set PREPARING synchronously before the async sendMessage to prevent
      // incoming messages from bypassing the queue during the await gap.
      this.setTurnPhase(TurnPhase.PREPARING);

      void this.sendMessage(message, options, internal)
        .then((result) => {
          // If sendMessage fails before it can start streaming, ensure we don't
          // leave the session stuck in PREPARING.
          if (!result.success && this.turnPhase === TurnPhase.PREPARING) {
            this.setTurnPhase(TurnPhase.IDLE);
          }
        })
        .catch(() => {
          if (this.turnPhase === TurnPhase.PREPARING) {
            this.setTurnPhase(TurnPhase.IDLE);
          }
        });
    }
  }

  /** Extract a successful switch_agent tool result from stream-end parts (latest wins). */
  private extractSwitchAgentResult(payload: StreamEndEvent): SwitchAgentResult | undefined {
    for (let index = payload.parts.length - 1; index >= 0; index -= 1) {
      const part = payload.parts[index];
      if (part.type !== "dynamic-tool") {
        continue;
      }
      if (part.state !== "output-available" || part.toolName !== "switch_agent") {
        continue;
      }

      // Verify the tool succeeded.
      if (!this.isOkSwitchAgentOutput(part.output)) {
        continue;
      }

      // Primary path: read switch details from tool input args.
      const parsedInput = this.parseSwitchAgentInput(part.input);
      if (parsedInput) {
        return parsedInput;
      }

      // Defensive fallback: degraded streams can lose input metadata (input=null)
      // when tool-call correlation fails. Recover from output if possible.
      const parsedOutput = this.parseSwitchAgentOutput(part.output);
      if (parsedOutput) {
        return parsedOutput;
      }
    }

    return undefined;
  }

  private isOkSwitchAgentOutput(output: unknown): boolean {
    if (typeof output !== "object" || output === null) {
      return false;
    }

    const candidate = output as Record<string, unknown>;
    return candidate.ok === true;
  }

  private parseSwitchAgentInput(input: unknown): SwitchAgentResult | undefined {
    return this.parseSwitchAgentCandidate(input);
  }

  private parseSwitchAgentOutput(output: unknown): SwitchAgentResult | undefined {
    return this.parseSwitchAgentCandidate(output);
  }

  private parseSwitchAgentCandidate(value: unknown): SwitchAgentResult | undefined {
    if (typeof value !== "object" || value === null) {
      return undefined;
    }

    const candidate = value as Record<string, unknown>;
    if (typeof candidate.agentId !== "string") {
      return undefined;
    }

    const agentId = candidate.agentId.trim();
    if (agentId.length === 0) {
      return undefined;
    }

    return {
      agentId,
      reason: typeof candidate.reason === "string" ? candidate.reason : undefined,
      followUp: typeof candidate.followUp === "string" ? candidate.followUp : undefined,
    };
  }

  private async isAgentSwitchTargetValid(
    agentId: string,
    disableWorkspaceAgents?: boolean
  ): Promise<boolean> {
    assert(
      typeof agentId === "string" && agentId.trim().length > 0,
      "isAgentSwitchTargetValid requires a non-empty agentId"
    );

    const normalizedAgentId = agentId.trim();
    const parsedAgentId = AgentIdSchema.safeParse(normalizedAgentId);
    if (!parsedAgentId.success) {
      log.warn("switch_agent target has invalid agentId format; skipping synthetic follow-up", {
        workspaceId: this.workspaceId,
        targetAgentId: normalizedAgentId,
      });
      return false;
    }

    if (typeof this.aiService.getWorkspaceMetadata !== "function") {
      log.warn("Cannot validate switch_agent target: workspace metadata API unavailable", {
        workspaceId: this.workspaceId,
        targetAgentId: parsedAgentId.data,
      });
      return false;
    }

    const metadataResult = await this.aiService.getWorkspaceMetadata(this.workspaceId);
    if (!metadataResult.success) {
      log.warn("Cannot validate switch_agent target: workspace metadata unavailable", {
        workspaceId: this.workspaceId,
        targetAgentId: parsedAgentId.data,
        error: metadataResult.error,
      });
      return false;
    }

    const metadata = metadataResult.data;
    const runtime = createRuntimeForWorkspace(metadata);

    // In-place workspaces (CLI/benchmarks) have projectPath === name.
    // Use the path directly instead of reconstructing via getWorkspacePath.
    const isInPlace = metadata.projectPath === metadata.name;
    const workspacePath = isInPlace
      ? metadata.projectPath
      : runtime.getWorkspacePath(metadata.projectPath, metadata.name);

    // When disableWorkspaceAgents is active, use project path for discovery
    // (only built-in/global agents). Mirrors resolveAgentForStream behavior.
    const discoveryPath = disableWorkspaceAgents ? metadata.projectPath : workspacePath;

    try {
      const resolvedFrontmatter = await resolveAgentFrontmatter(
        runtime,
        discoveryPath,
        parsedAgentId.data
      );
      const cfg = this.config.loadConfigOrDefault();
      const effectivelyDisabled = isAgentEffectivelyDisabled({
        cfg,
        agentId: parsedAgentId.data,
        resolvedFrontmatter,
      });

      if (effectivelyDisabled) {
        log.warn("switch_agent target is disabled; skipping synthetic follow-up", {
          workspaceId: this.workspaceId,
          targetAgentId: parsedAgentId.data,
        });
        return false;
      }

      // NOTE: hidden is opt-out. selectable is legacy opt-in.
      // Mirrors the same logic in agents.list (src/node/orpc/router.ts).
      const uiSelectableBase =
        typeof resolvedFrontmatter.ui?.hidden === "boolean"
          ? !resolvedFrontmatter.ui.hidden
          : typeof resolvedFrontmatter.ui?.selectable === "boolean"
            ? resolvedFrontmatter.ui.selectable
            : true;

      if (!uiSelectableBase) {
        log.warn("switch_agent target is not UI-selectable; skipping synthetic follow-up", {
          workspaceId: this.workspaceId,
          targetAgentId: parsedAgentId.data,
        });
        return false;
      }

      // Check ui.requires gating (e.g., orchestrator requires a plan file).
      // This matches the router's `requiresPlan && !planReady` check.
      const requiresPlan = resolvedFrontmatter.ui?.requires?.includes("plan") ?? false;
      if (requiresPlan) {
        // Fail closed: if plan state cannot be determined, treat as not ready.
        let planReady = false;
        try {
          planReady = await hasNonEmptyPlanFile(
            runtime,
            metadata.name,
            metadata.projectName,
            this.workspaceId
          );
        } catch {
          planReady = false;
        }
        if (!planReady) {
          log.warn(
            "switch_agent target requires a plan but no plan file exists; skipping synthetic follow-up",
            {
              workspaceId: this.workspaceId,
              targetAgentId: parsedAgentId.data,
            }
          );
          return false;
        }
      }

      return true;
    } catch (error) {
      log.warn("switch_agent target could not be resolved; skipping synthetic follow-up", {
        workspaceId: this.workspaceId,
        targetAgentId: parsedAgentId.data,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  private async resolveAgentSwitchFallbackTarget(
    currentOptions: SendMessageOptions | undefined
  ): Promise<string | undefined> {
    const preferredAgentId = currentOptions?.agentId?.trim();
    const disableWorkspaceAgents = currentOptions?.disableWorkspaceAgents;

    const candidates: string[] = [];
    // Prefer returning to the caller's previous non-auto agent when possible.
    if (preferredAgentId != null && preferredAgentId.length > 0 && preferredAgentId !== "auto") {
      candidates.push(preferredAgentId);
    }

    for (const candidate of SAFE_AGENT_SWITCH_FALLBACK_CANDIDATES) {
      candidates.push(candidate);
    }

    const seen = new Set<string>();
    for (const candidate of candidates) {
      assert(candidate.trim().length > 0, "Fallback candidate agent IDs must be non-empty");
      if (seen.has(candidate)) {
        continue;
      }
      seen.add(candidate);

      if (await this.isAgentSwitchTargetValid(candidate, disableWorkspaceAgents)) {
        return candidate;
      }
    }

    return undefined;
  }

  private buildAgentSwitchFallbackFollowUp(switchResult: SwitchAgentResult): string {
    const normalizedReason = switchResult.reason?.trim();
    const lines = [
      `Agent handoff failed: target "${switchResult.agentId}" is unavailable in this workspace.`,
      "Continue assisting the user's latest request using this mode.",
    ];

    if (normalizedReason != null && normalizedReason.length > 0) {
      lines.splice(1, 0, `Router rationale: ${normalizedReason}`);
    }

    return lines.join("\n");
  }

  /** Dispatch follow-up message after switch_agent and guard against ping-pong loops. */
  private async dispatchAgentSwitch(
    switchResult: SwitchAgentResult,
    currentOptions: SendMessageOptions | undefined,
    fallbackModel: string
  ): Promise<boolean> {
    assert(
      typeof switchResult.agentId === "string" && switchResult.agentId.trim().length > 0,
      "dispatchAgentSwitch requires a non-empty switchResult.agentId"
    );
    assert(
      typeof fallbackModel === "string" && fallbackModel.trim().length > 0,
      "dispatchAgentSwitch requires a non-empty fallbackModel"
    );

    this.consecutiveAgentSwitches += 1;
    if (this.consecutiveAgentSwitches > MAX_CONSECUTIVE_AGENT_SWITCHES) {
      log.warn("switch_agent loop guard triggered; skipping synthetic follow-up", {
        workspaceId: this.workspaceId,
        count: this.consecutiveAgentSwitches,
        limit: MAX_CONSECUTIVE_AGENT_SWITCHES,
        targetAgentId: switchResult.agentId,
      });
      this.emitChatEvent(
        createStreamErrorMessage({
          messageId: createAssistantMessageId(),
          error: `Agent switch loop detected (${this.consecutiveAgentSwitches} consecutive switches). The agent was stopped to prevent an infinite loop.`,
          errorType: "unknown",
        })
      );
      return false;
    }

    let targetAgentId = switchResult.agentId;

    const targetValid = await this.isAgentSwitchTargetValid(
      targetAgentId,
      currentOptions?.disableWorkspaceAgents
    );
    if (!targetValid) {
      const fallbackAgentId = await this.resolveAgentSwitchFallbackTarget(currentOptions);
      if (fallbackAgentId == null) {
        log.warn("switch_agent target invalid and no safe fallback agent is available", {
          workspaceId: this.workspaceId,
          requestedTargetAgentId: switchResult.agentId,
        });
        this.emitChatEvent(
          createStreamErrorMessage({
            messageId: createAssistantMessageId(),
            error: `${SWITCH_AGENT_TARGET_UNAVAILABLE_ERROR} Requested target: "${switchResult.agentId}".`,
            errorType: "unknown",
          })
        );
        return false;
      }

      log.warn("switch_agent target invalid; routing synthetic follow-up to fallback agent", {
        workspaceId: this.workspaceId,
        requestedTargetAgentId: switchResult.agentId,
        fallbackAgentId,
      });
      targetAgentId = fallbackAgentId;
    }

    // Fall back to "Continue." for nullish, empty, or whitespace-only followUp strings.
    const trimmedFollowUp = switchResult.followUp?.trim();
    const followUpText =
      targetAgentId === switchResult.agentId
        ? trimmedFollowUp != null && trimmedFollowUp.length > 0
          ? trimmedFollowUp
          : "Continue."
        : this.buildAgentSwitchFallbackFollowUp(switchResult);
    // switch_agent hands off execution to a different agent, so prefer that
    // agent's persisted model/thinking settings. If no per-agent override
    // exists, inherit from the outgoing stream options.
    const metadataResult = await this.aiService.getWorkspaceMetadata(this.workspaceId);
    // If we had to reroute to a safe fallback target (hidden/disabled/missing
    // requested target), keep recovery in the current stream settings instead of
    // applying persisted per-agent overrides for the fallback agent.
    const usedFallbackTarget = targetAgentId !== switchResult.agentId;
    const targetAgentSettings =
      metadataResult.success === true && !usedFallbackTarget
        ? metadataResult.data.aiSettingsByAgent?.[targetAgentId]
        : undefined;
    const workspaceAiSettings =
      metadataResult.success === true ? metadataResult.data.aiSettings : undefined;

    const effectiveModel =
      coerceNonEmptyString(targetAgentSettings?.model) ??
      coerceNonEmptyString(currentOptions?.model) ??
      coerceNonEmptyString(workspaceAiSettings?.model) ??
      fallbackModel.trim();

    const effectiveThinkingLevel =
      targetAgentSettings?.thinkingLevel ??
      currentOptions?.thinkingLevel ??
      workspaceAiSettings?.thinkingLevel;

    // Build follow-up options from an explicit allowlist.
    // Exclude edit-only fields (editMessageId) to prevent the synthetic
    // follow-up from entering edit/truncation logic.
    const followUpOptions: SendMessageOptions = {
      model: effectiveModel,
      agentId: targetAgentId,
      // Preserve relevant settings from the original request
      ...(effectiveThinkingLevel != null && { thinkingLevel: effectiveThinkingLevel }),
      ...(currentOptions?.system1ThinkingLevel != null && {
        system1ThinkingLevel: currentOptions.system1ThinkingLevel,
      }),
      ...(currentOptions?.system1Model != null && { system1Model: currentOptions.system1Model }),
      ...(currentOptions?.providerOptions != null && {
        providerOptions: currentOptions.providerOptions,
      }),
      ...(currentOptions?.experiments != null && { experiments: currentOptions.experiments }),
      ...(currentOptions?.maxOutputTokens != null && {
        maxOutputTokens: currentOptions.maxOutputTokens,
      }),
      ...(currentOptions?.disableWorkspaceAgents != null && {
        disableWorkspaceAgents: currentOptions.disableWorkspaceAgents,
      }),
      ...(currentOptions?.toolPolicy != null && { toolPolicy: currentOptions.toolPolicy }),
      ...(currentOptions?.additionalSystemInstructions != null && {
        additionalSystemInstructions: currentOptions.additionalSystemInstructions,
      }),
      skipAiSettingsPersistence: true,
    };

    const sendResult = await this.sendMessage(followUpText, followUpOptions, {
      synthetic: true,
    });

    if (!sendResult.success) {
      log.warn("Failed to dispatch switch_agent follow-up", {
        workspaceId: this.workspaceId,
        requestedTargetAgentId: switchResult.agentId,
        dispatchedTargetAgentId: targetAgentId,
        error: sendResult.error,
      });
      const dispatchStreamError = buildStreamErrorEventData(sendResult.error);
      const nestedSendAlreadyReportedError =
        this.activeStreamFailureHandled &&
        (this.activeStreamErrorEventReceived ||
          (sendResult.error.type !== "runtime_not_ready" &&
            sendResult.error.type !== "runtime_start_failed"));

      if (!nestedSendAlreadyReportedError) {
        this.emitChatEvent(
          createStreamErrorMessage({
            messageId: dispatchStreamError.messageId,
            error: `Failed to switch to agent "${targetAgentId}": ${dispatchStreamError.error}`,
            errorType: dispatchStreamError.errorType,
          })
        );
      }
      return false;
    }

    return true;
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

    // Read the last message from history — only need 1 message, avoid full-file read.
    // Startup recovery must retry on transient read failures, so bubble errors.
    const historyResult = await this.historyService.getLastMessages(this.workspaceId, 1);
    if (!historyResult.success) {
      const historyError =
        typeof historyResult.error === "string"
          ? historyResult.error
          : getErrorMessage(historyResult.error);
      throw new Error(`Failed to read history for startup follow-up recovery: ${historyError}`);
    }

    if (historyResult.data.length === 0) {
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
      muxMetadata?: MuxMessageMetadata;
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
    // Mark as synthetic so recovery/background dispatches do not implicitly
    // re-enable auto-retry after a user explicitly opted out.
    const sendResult = await this.sendMessage(finalText, options, { synthetic: true });
    if (!sendResult.success) {
      const message = this.extractRetryFailureMessage(sendResult.error) ?? sendResult.error.type;
      throw new Error(`Failed to dispatch pending follow-up: ${message}`);
    }
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
    muxMetadata: MuxMessageMetadata | undefined,
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
