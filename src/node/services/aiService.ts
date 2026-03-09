import * as fs from "fs/promises";
import { EventEmitter } from "events";

import assert from "@/common/utils/assert";
import { type LanguageModel, type Tool } from "ai";

import { linkAbortSignal } from "@/node/utils/abort";
import { ensurePrivateDir } from "@/node/utils/fs";
import type { Result } from "@/common/types/result";
import { Ok, Err } from "@/common/types/result";
import type { WorkspaceMetadata } from "@/common/types/workspace";
import type { SendMessageOptions, ProvidersConfigMap } from "@/common/orpc/types";

import type { DebugLlmRequestSnapshot } from "@/common/types/debugLlmRequest";

import type { MuxMessage } from "@/common/types/message";
import { createMuxMessage } from "@/common/types/message";
import type { Config } from "@/node/config";
import { StreamManager } from "./streamManager";
import type { InitStateManager } from "./initStateManager";
import type { SendMessageError } from "@/common/types/errors";
import { getToolsForModel } from "@/common/utils/tools/tools";
import { cloneToolPreservingDescriptors } from "@/common/utils/tools/cloneToolPreservingDescriptors";
import { createRuntime } from "@/node/runtime/runtimeFactory";
import { MultiProjectRuntime } from "@/node/runtime/multiProjectRuntime";
import { getMuxEnv, getRuntimeType } from "@/node/runtime/initHook";
import { MUX_HELP_CHAT_AGENT_ID, MUX_HELP_CHAT_WORKSPACE_ID } from "@/common/constants/muxChat";
import { getSrcBaseDir } from "@/common/types/runtime";
import { ContainerManager } from "@/node/multiProject/containerManager";
import { secretsToRecord, type ExternalSecretResolver } from "@/common/types/secrets";
import { mergeMultiProjectSecrets } from "@/node/services/utils/multiProjectSecrets";
import type { MuxProviderOptions } from "@/common/types/providerOptions";
import type { MuxToolScope } from "@/common/types/toolScope";
import type { PolicyService } from "@/node/services/policyService";
import type { ProviderService } from "@/node/services/providerService";
import type { CodexOauthService } from "@/node/services/codexOauthService";
import type { BackgroundProcessManager } from "@/node/services/backgroundProcessManager";
import type { FileState, EditedFileAttachment } from "@/node/services/agentSession";
import { log } from "./log";
import {
  addInterruptedSentinel,
  filterEmptyAssistantMessages,
} from "@/browser/utils/messages/modelMessageTransform";
import type { PostCompactionAttachment } from "@/common/types/attachment";

import type { HistoryService } from "./historyService";
import { delegatedToolCallManager } from "./delegatedToolCallManager";
import { createErrorEvent } from "./utils/sendMessageError";
import { createAssistantMessageId } from "./utils/messageIds";
import type { SessionUsageService } from "./sessionUsageService";
import { sumUsageHistory, getTotalCost } from "@/common/utils/tokens/usageAggregator";
import { readToolInstructions } from "./systemMessage";
import type { TelemetryService } from "@/node/services/telemetryService";
import type { DevToolsService } from "@/node/services/devToolsService";

import type { WorkspaceMCPOverrides } from "@/common/types/mcp";
import type { MCPServerManager, MCPWorkspaceStats } from "@/node/services/mcpServerManager";
import { WorkspaceMcpOverridesService } from "./workspaceMcpOverridesService";
import type { TaskService } from "@/node/services/taskService";
import { buildProviderOptions, buildRequestHeaders } from "@/common/utils/ai/providerOptions";
import { resolveModelParameterOverrides } from "@/common/utils/ai/modelParameterOverrides";
import { isPlainObject } from "@/common/utils/isPlainObject";
import { sliceMessagesFromLatestCompactionBoundary } from "@/common/utils/messages/compactionBoundary";
import { getProjects, isMultiProject } from "@/common/utils/multiProject";
import { isWorkspaceTrustedForSharedExecution } from "@/node/services/utils/workspaceTrust";

import { THINKING_LEVEL_OFF, type ThinkingLevel } from "@/common/types/thinking";

import type {
  ErrorEvent,
  StreamAbortEvent,
  StreamAbortReason,
  StreamEndEvent,
} from "@/common/types/stream";
import type { ToolPolicy } from "@/common/utils/tools/toolPolicy";
import type { PTCEventWithParent } from "@/node/services/tools/code_execution";
import { MockAiStreamPlayer } from "./mock/mockAiStreamPlayer";
import { DEVTOOLS_RUN_METADATA_ID_HEADER } from "./devToolsHeaderCapture";
import { ProviderModelFactory, modelCostsIncluded } from "./providerModelFactory";
import { wrapToolsWithSystem1 } from "./system1ToolWrapper";
import { prepareMessagesForProvider } from "./messagePipeline";
import { resolveAgentForStream } from "./agentResolution";
import { buildPlanInstructions, buildStreamSystemContext } from "./streamContextBuilder";
import { getTokenizerForModel } from "@/node/utils/main/tokenizer";
import { resolveModelForMetadata } from "@/common/utils/providers/modelEntries";
import {
  simulateContextLimitError,
  simulateToolPolicyNoop,
  type SimulationContext,
} from "./streamSimulation";
import { applyToolPolicyAndExperiments, captureMcpToolTelemetry } from "./toolAssembly";
import { getErrorMessage } from "@/common/utils/errors";

// ---------------------------------------------------------------------------
// streamMessage options
// ---------------------------------------------------------------------------

/** Options bag for {@link AIService.streamMessage}. */
export interface StreamMessageOptions {
  messages: MuxMessage[];
  workspaceId: string;
  modelString: string;
  thinkingLevel?: ThinkingLevel;
  toolPolicy?: ToolPolicy;
  abortSignal?: AbortSignal;
  additionalSystemInstructions?: string;
  maxOutputTokens?: number;
  muxProviderOptions?: MuxProviderOptions;
  /** Internal-only flag for Copilot billing attribution; never sourced from IPC schemas. */
  agentInitiated?: boolean;
  agentId?: string;
  /** ACP prompt correlation id used to match stream events to a specific request. */
  acpPromptId?: string;
  /** Tool names that should be delegated back to ACP clients for this request. */
  delegatedToolNames?: string[];
  recordFileState?: (filePath: string, state: FileState) => Promise<void>;
  changedFileAttachments?: EditedFileAttachment[];
  postCompactionAttachments?: PostCompactionAttachment[] | null;
  experiments?: SendMessageOptions["experiments"];
  system1Model?: string;
  system1ThinkingLevel?: ThinkingLevel;
  disableWorkspaceAgents?: boolean;
  hasQueuedMessage?: () => boolean;
  openaiTruncationModeOverride?: "auto" | "disabled";
}

// ---------------------------------------------------------------------------
// Utility: deep-clone with structuredClone fallback
// ---------------------------------------------------------------------------

/** Deep-clone a value using structuredClone (with JSON fallback). */
function safeClone<T>(value: T): T {
  return typeof structuredClone === "function"
    ? structuredClone(value)
    : (JSON.parse(JSON.stringify(value)) as T);
}

/**
 * Recursively merge user-provided provider extras under Mux-built provider options.
 * Mux values win on leaf conflicts; both sides' non-conflicting nested fields are preserved.
 */
function mergeProviderExtrasUnderMux(
  providerExtras: Record<string, unknown>,
  muxProviderNamespace: Record<string, unknown>
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...providerExtras };

  for (const [key, muxValue] of Object.entries(muxProviderNamespace)) {
    const extraValue = merged[key];
    merged[key] =
      isPlainObject(extraValue) && isPlainObject(muxValue)
        ? mergeProviderExtrasUnderMux(extraValue, muxValue)
        : muxValue;
  }

  return merged;
}

interface ToolExecutionContext {
  toolCallId?: string;
  abortSignal?: AbortSignal;
}

function isToolExecutionContext(value: unknown): value is ToolExecutionContext {
  if (typeof value !== "object" || value == null || Array.isArray(value)) {
    return false;
  }

  const record = value as Record<string, unknown>;
  const toolCallId = record.toolCallId;
  const abortSignal = record.abortSignal;

  const validToolCallId = toolCallId == null || typeof toolCallId === "string";
  const validAbortSignal = abortSignal == null || abortSignal instanceof AbortSignal;

  return validToolCallId && validAbortSignal;
}

/**
 * Derive the host-local project root for mux managed-file tools (fs/promises).
 * Remote runtimes (ssh, docker) have a workspacePath that is a remote/container
 * path — unusable by host fs. Fall back to metadata.projectPath which is always
 * host-local.
 */
export function resolveMuxProjectRootForHostFs(
  metadata: WorkspaceMetadata,
  workspacePath: string
): string {
  const runtimeType = metadata.runtimeConfig.type;
  return runtimeType === "ssh" || runtimeType === "docker" ? metadata.projectPath : workspacePath;
}

export class AIService extends EventEmitter {
  private readonly streamManager: StreamManager;
  private readonly historyService: HistoryService;
  private readonly config: Config;
  private readonly workspaceMcpOverridesService: WorkspaceMcpOverridesService;
  private mcpServerManager?: MCPServerManager;
  private readonly policyService?: PolicyService;
  private readonly telemetryService?: TelemetryService;
  private readonly opResolver?: ExternalSecretResolver;
  private readonly initStateManager: InitStateManager;
  private mockModeEnabled: boolean;
  private mockAiStreamPlayer?: MockAiStreamPlayer;
  private readonly backgroundProcessManager?: BackgroundProcessManager;
  private readonly sessionUsageService?: SessionUsageService;
  private readonly providerService: ProviderService;
  private readonly providerModelFactory: ProviderModelFactory;
  private readonly devToolsService?: DevToolsService;

  // Tracks in-flight stream startup (before StreamManager emits stream-start).
  // This enables user interrupts (Esc/Ctrl+C) during the UI "starting..." phase.
  private readonly pendingStreamStarts = new Map<
    string,
    {
      abortController: AbortController;
      startTime: number;
      syntheticMessageId: string;
      acpPromptId?: string;
    }
  >();

  /**
   * Tracks queued DevTools run metadata by assistant message id so stream-end/abort
   * can clear orphaned entries when a stream starts but never reaches middleware run creation.
   */
  private readonly pendingDevToolsRunMetadataByMessageId = new Map<
    string,
    { workspaceId: string; metadataId: string }
  >();

  // Debug: captured LLM request payloads for last send per workspace
  private lastLlmRequestByWorkspace = new Map<string, DebugLlmRequestSnapshot>();
  private taskService?: TaskService;
  private extraTools?: Record<string, Tool>;
  private analyticsService?: { executeRawQuery(sql: string): Promise<unknown> };

  constructor(
    config: Config,
    historyService: HistoryService,
    initStateManager: InitStateManager,
    providerService: ProviderService,
    backgroundProcessManager?: BackgroundProcessManager,
    sessionUsageService?: SessionUsageService,
    workspaceMcpOverridesService?: WorkspaceMcpOverridesService,
    policyService?: PolicyService,
    telemetryService?: TelemetryService,
    devToolsService?: DevToolsService,
    opResolver?: ExternalSecretResolver
  ) {
    super();
    // Increase max listeners to accommodate multiple concurrent workspace listeners
    // Each workspace subscribes to stream events, and we expect >10 concurrent workspaces
    this.setMaxListeners(50);
    this.workspaceMcpOverridesService =
      workspaceMcpOverridesService ?? new WorkspaceMcpOverridesService(config);
    this.config = config;
    this.historyService = historyService;
    this.initStateManager = initStateManager;
    this.backgroundProcessManager = backgroundProcessManager;
    this.sessionUsageService = sessionUsageService;
    this.policyService = policyService;
    this.telemetryService = telemetryService;
    this.opResolver = opResolver;
    this.providerService = providerService;
    this.streamManager = new StreamManager(historyService, sessionUsageService, () =>
      this.providerService.getConfig()
    );
    this.devToolsService = devToolsService;
    this.providerModelFactory = new ProviderModelFactory(
      config,
      providerService,
      policyService,
      undefined,
      devToolsService,
      opResolver
    );
    void this.ensureSessionsDir();
    this.setupStreamEventForwarding();
    this.mockModeEnabled = false;

    if (process.env.MUX_MOCK_AI === "1") {
      log.info("AIService running in MUX_MOCK_AI mode");
      this.enableMockMode();
    }
  }

  setCodexOauthService(service: CodexOauthService): void {
    this.providerModelFactory.codexOauthService = service;
  }
  setMCPServerManager(manager: MCPServerManager): void {
    this.mcpServerManager = manager;
    this.streamManager.setMCPServerManager(manager);
  }

  setTaskService(taskService: TaskService): void {
    this.taskService = taskService;
  }

  setAnalyticsService(service: { executeRawQuery(sql: string): Promise<unknown> }): void {
    this.analyticsService = service;
  }

  getProvidersConfig(): ProvidersConfigMap | null {
    return this.providerService.getConfig();
  }

  /**
   * Set extra tools to include in every tool call.
   * Used by CLI to inject tools like set_exit_code without modifying core tool definitions.
   */
  setExtraTools(tools: Record<string, Tool>): void {
    this.extraTools = tools;
  }

  /**
   * Forward all stream events from StreamManager to AIService consumers
   */
  private setupStreamEventForwarding(): void {
    // Simple one-to-one event forwarding from StreamManager → AIService consumers
    for (const event of [
      "stream-start",
      "stream-delta",
      "tool-call-start",
      "tool-call-delta",
      "tool-call-end",
      "reasoning-delta",
      "reasoning-end",
      "usage-delta",
    ] as const) {
      this.streamManager.on(event, (data) => this.emit(event, data));
    }

    // Stream errors can bypass stream-end/stream-abort. Clear any queued metadata
    // so failed requests don't leak pending-run tracking entries.
    this.streamManager.on("error", (data: ErrorEvent) => {
      this.clearTrackedPendingDevToolsRunMetadata(data.messageId);
      this.emit("error", data);
    });

    // stream-end needs extra logic: capture provider response for debug modal
    this.streamManager.on("stream-end", (data: StreamEndEvent) => {
      // Streams can end before DevTools middleware creates a run (for example when
      // interrupted early). Clear any still-queued run metadata for this message.
      this.clearTrackedPendingDevToolsRunMetadata(data.messageId);

      // Best-effort capture of the provider response for the "Last LLM request" debug modal.
      // Must never break live streaming.
      try {
        const snapshot = this.lastLlmRequestByWorkspace.get(data.workspaceId);
        if (snapshot) {
          // If messageId is missing (legacy fixtures), attach anyway.
          const shouldAttach = snapshot.messageId === data.messageId || snapshot.messageId == null;
          if (shouldAttach) {
            const updated: DebugLlmRequestSnapshot = {
              ...snapshot,
              response: {
                capturedAt: Date.now(),
                metadata: data.metadata,
                parts: data.parts,
              },
            };

            this.lastLlmRequestByWorkspace.set(data.workspaceId, safeClone(updated));
          }
        }
      } catch (error) {
        const errMsg = getErrorMessage(error);
        log.warn("Failed to capture debug LLM response snapshot", { error: errMsg });
      }

      this.emit("stream-end", data);
    });

    // Handle stream-abort: dispose of partial based on abandonPartial flag
    this.streamManager.on("stream-abort", (data: StreamAbortEvent) => {
      // Aborts can happen before the first provider call reaches DevTools middleware.
      // Clear any queued run metadata for this message to avoid memory growth.
      this.clearTrackedPendingDevToolsRunMetadata(data.messageId);

      void (async () => {
        try {
          if (data.abandonPartial) {
            // Caller requested discarding partial - delete without committing
            await this.historyService.deletePartial(data.workspaceId);
          } else {
            // Commit interrupted message to history with partial:true metadata
            // This ensures /clear and /truncate can clean up interrupted messages
            const partial = await this.historyService.readPartial(data.workspaceId);
            if (partial) {
              await this.historyService.commitPartial(data.workspaceId);
              await this.historyService.deletePartial(data.workspaceId);
            }
          }
        } catch (error) {
          log.error("Failed partial cleanup during stream-abort", {
            workspaceId: data.workspaceId,
            error: getErrorMessage(error),
          });
        } finally {
          // Always forward abort event to consumers (workspaceService, agentSession)
          // even if partial cleanup failed — stream lifecycle consistency is higher priority.
          this.emit("stream-abort", data);
        }
      })();
    });
  }

  private trackPendingDevToolsRunMetadata(
    messageId: string,
    workspaceId: string,
    metadataId: string
  ): void {
    assert(messageId.trim().length > 0, "trackPendingDevToolsRunMetadata requires a messageId");
    assert(workspaceId.trim().length > 0, "trackPendingDevToolsRunMetadata requires a workspaceId");
    assert(metadataId.trim().length > 0, "trackPendingDevToolsRunMetadata requires a metadataId");

    this.pendingDevToolsRunMetadataByMessageId.set(messageId, {
      workspaceId,
      metadataId,
    });
  }

  private clearTrackedPendingDevToolsRunMetadata(messageId: string): void {
    // StreamManager can emit stream-abort with an empty messageId during startup races.
    // Treat that as "nothing to clear" instead of throwing so interruptStream remains reliable.
    if (messageId.trim().length === 0) {
      return;
    }

    const pending = this.pendingDevToolsRunMetadataByMessageId.get(messageId);
    if (!pending) {
      return;
    }

    this.pendingDevToolsRunMetadataByMessageId.delete(messageId);
    this.devToolsService?.clearPendingRunMetadata(pending.workspaceId, pending.metadataId);
  }

  private clearTrackedPendingDevToolsRunMetadataById(
    workspaceId: string,
    metadataId: string
  ): void {
    assert(
      workspaceId.trim().length > 0,
      "clearTrackedPendingDevToolsRunMetadataById requires a workspaceId"
    );
    assert(
      metadataId.trim().length > 0,
      "clearTrackedPendingDevToolsRunMetadataById requires a metadataId"
    );

    for (const [messageId, pending] of this.pendingDevToolsRunMetadataByMessageId.entries()) {
      if (pending.workspaceId === workspaceId && pending.metadataId === metadataId) {
        this.pendingDevToolsRunMetadataByMessageId.delete(messageId);
        break;
      }
    }

    this.devToolsService?.clearPendingRunMetadata(workspaceId, metadataId);
  }

  private async ensureSessionsDir(): Promise<void> {
    try {
      await ensurePrivateDir(this.config.sessionsDir);
    } catch (error) {
      log.error("Failed to create sessions directory:", error);
    }
  }

  isMockModeEnabled(): boolean {
    return this.mockModeEnabled;
  }

  releaseMockStreamStartGate(workspaceId: string): void {
    this.mockAiStreamPlayer?.releaseStreamStartGate(workspaceId);
  }

  enableMockMode(): void {
    this.mockModeEnabled = true;

    this.mockAiStreamPlayer ??= new MockAiStreamPlayer({
      aiService: this,
      historyService: this.historyService,
    });
  }

  async getWorkspaceMetadata(workspaceId: string): Promise<Result<WorkspaceMetadata>> {
    try {
      // Read from config.json (single source of truth)
      // getAllWorkspaceMetadata() handles migration from legacy metadata.json files
      const allMetadata = await this.config.getAllWorkspaceMetadata();
      const metadata = allMetadata.find((m) => m.id === workspaceId);

      if (!metadata) {
        return Err(
          `Workspace metadata not found for ${workspaceId}. Workspace may not be properly initialized.`
        );
      }

      return Ok(metadata);
    } catch (error) {
      const message = getErrorMessage(error);
      return Err(`Failed to read workspace metadata: ${message}`);
    }
  }

  /**
   * Create an AI SDK model from a model string (e.g., "anthropic:claude-opus-4-1").
   * Delegates to ProviderModelFactory.
   */
  async createModel(
    modelString: string,
    muxProviderOptions?: MuxProviderOptions,
    opts?: { agentInitiated?: boolean; workspaceId?: string }
  ): Promise<Result<LanguageModel, SendMessageError>> {
    return this.providerModelFactory.createModel(modelString, muxProviderOptions, opts);
  }

  private wrapToolsForDelegation(
    workspaceId: string,
    tools: Record<string, Tool>,
    delegatedToolNames?: string[]
  ): Record<string, Tool> {
    const normalizedDelegatedTools =
      delegatedToolNames
        ?.map((toolName) => toolName.trim())
        .filter((toolName) => toolName.length > 0) ?? [];

    if (normalizedDelegatedTools.length === 0) {
      return tools;
    }

    const delegatedToolSet = new Set(normalizedDelegatedTools);
    const wrappedTools = { ...tools };

    for (const [toolName, tool] of Object.entries(tools)) {
      if (!delegatedToolSet.has(toolName)) {
        continue;
      }

      const toolRecord = tool as Record<string, unknown>;
      const execute = toolRecord.execute;
      if (typeof execute !== "function") {
        continue;
      }

      const wrappedTool = cloneToolPreservingDescriptors(tool);
      const wrappedToolRecord = wrappedTool as Record<string, unknown>;

      wrappedToolRecord.execute = async (_args: unknown, options: unknown) => {
        const executionContext = isToolExecutionContext(options) ? options : undefined;
        const toolCallId = executionContext?.toolCallId?.trim();

        if (executionContext == null || toolCallId == null || toolCallId.length === 0) {
          throw new Error(
            `Delegated tool '${toolName}' requires a non-empty toolCallId in execute context`
          );
        }

        const pendingResult = delegatedToolCallManager.registerPending(
          workspaceId,
          toolCallId,
          toolName
        );

        const abortSignal = executionContext.abortSignal;
        if (abortSignal == null) {
          return pendingResult;
        }

        if (abortSignal.aborted) {
          try {
            delegatedToolCallManager.cancel(workspaceId, toolCallId, "Interrupted");
          } catch {
            // no-op: pending may already have resolved
          }
          throw new Error("Interrupted");
        }

        let abortListener: (() => void) | undefined;
        const abortPromise = new Promise<never>((_, reject) => {
          abortListener = () => {
            try {
              delegatedToolCallManager.cancel(workspaceId, toolCallId, "Interrupted");
            } catch {
              // no-op: pending may already have resolved
            }
            reject(new Error("Interrupted"));
          };

          abortSignal.addEventListener("abort", abortListener, { once: true });
        });

        try {
          return await Promise.race([pendingResult, abortPromise]);
        } finally {
          if (abortListener != null) {
            abortSignal.removeEventListener("abort", abortListener);
          }
        }
      };

      wrappedTools[toolName] = wrappedTool;
    }

    return wrappedTools;
  }

  /** Stream a message conversation to the AI model. */
  async streamMessage(opts: StreamMessageOptions): Promise<Result<void, SendMessageError>> {
    const {
      messages,
      workspaceId,
      modelString,
      thinkingLevel,
      toolPolicy,
      abortSignal,
      additionalSystemInstructions,
      maxOutputTokens,
      muxProviderOptions,
      agentInitiated,
      agentId,
      acpPromptId,
      delegatedToolNames,
      recordFileState,
      changedFileAttachments,
      postCompactionAttachments,
      experiments,
      system1Model,
      system1ThinkingLevel,
      disableWorkspaceAgents,
      hasQueuedMessage,
      openaiTruncationModeOverride,
    } = opts;
    // Support interrupts during startup (before StreamManager emits stream-start).
    // We register an AbortController up-front and let stopStream() abort it.
    const pendingAbortController = new AbortController();
    const startTime = Date.now();
    const syntheticMessageId = `starting-${startTime}-${Math.random().toString(36).substring(2, 11)}`;

    // Link external abort signal (if provided).
    const unlinkAbortSignal = linkAbortSignal(abortSignal, pendingAbortController);

    this.pendingStreamStarts.set(workspaceId, {
      abortController: pendingAbortController,
      startTime,
      syntheticMessageId,
      acpPromptId,
    });

    const combinedAbortSignal = pendingAbortController.signal;

    let pendingRunMetadataId: string | null = null;

    try {
      if (this.mockModeEnabled && this.mockAiStreamPlayer) {
        await this.initStateManager.waitForInit(workspaceId, combinedAbortSignal);
        if (combinedAbortSignal.aborted) {
          return Ok(undefined);
        }
        return await this.mockAiStreamPlayer.play(messages, workspaceId, {
          model: modelString,
          abortSignal: combinedAbortSignal,
        });
      }

      // DEBUG: Log streamMessage call
      const lastMessage = messages[messages.length - 1];
      log.debug(
        `[STREAM MESSAGE] workspaceId=${workspaceId} messageCount=${messages.length} lastRole=${lastMessage?.role}`
      );

      // Before starting a new stream, commit any existing partial to history
      // This is idempotent - won't double-commit if already in chat.jsonl
      await this.historyService.commitPartial(workspaceId);

      // Helper: clean up an assistant placeholder that was appended to history but never
      // streamed (due to abort during setup). Used in two abort-check sites below.
      const deleteAbortedPlaceholder = async (messageId: string): Promise<void> => {
        const deleteResult = await this.historyService.deleteMessage(workspaceId, messageId);
        if (!deleteResult.success) {
          log.error(
            `Failed to delete aborted assistant placeholder (${messageId}): ${deleteResult.error}`
          );
        }
      };

      // Mode (plan|exec|compact) is derived from the selected agent definition.
      const effectiveMuxProviderOptions: MuxProviderOptions = muxProviderOptions ?? {};
      const effectiveThinkingLevel: ThinkingLevel = thinkingLevel ?? THINKING_LEVEL_OFF;

      // Resolve model string (xAI variant mapping + gateway routing) and create the model.
      const modelResult = await this.providerModelFactory.resolveAndCreateModel(
        modelString,
        effectiveThinkingLevel,
        effectiveMuxProviderOptions,
        { agentInitiated, workspaceId }
      );
      if (!modelResult.success) {
        return Err(modelResult.error);
      }
      const {
        effectiveModelString,
        canonicalModelString,
        canonicalProviderName,
        routedThroughGateway,
      } = modelResult.data;

      // Dump original messages for debugging
      log.debug_obj(`${workspaceId}/1_original_messages.json`, messages);

      // Filter out assistant messages with only reasoning (no text/tools)
      // EXCEPTION: When extended thinking is enabled, preserve reasoning-only messages
      // to comply with Extended Thinking API requirements
      const preserveReasoningOnly =
        canonicalProviderName === "anthropic" && effectiveThinkingLevel !== "off";
      const filteredMessages = filterEmptyAssistantMessages(messages, preserveReasoningOnly);
      log.debug(`Filtered ${messages.length - filteredMessages.length} empty assistant messages`);
      log.debug_obj(`${workspaceId}/1a_filtered_messages.json`, filteredMessages);

      // WS2 request slicing: only send the latest compaction epoch to providers.
      // This is request-only; persisted history remains append-only for replay/debugging.
      const providerRequestMessages = sliceMessagesFromLatestCompactionBoundary(filteredMessages);
      if (providerRequestMessages !== filteredMessages) {
        log.debug("Sliced provider history from latest compaction boundary", {
          workspaceId,
          originalCount: filteredMessages.length,
          slicedCount: providerRequestMessages.length,
        });
      }
      log.debug_obj(`${workspaceId}/1b_provider_request_messages.json`, providerRequestMessages);

      // OpenAI-specific: Keep reasoning parts in history so each request can
      // carry forward reasoning context without relying on previous_response_id.
      if (canonicalProviderName === "openai") {
        log.debug("Keeping reasoning parts for OpenAI (managed via explicit history)");
      }
      // Add [CONTINUE] sentinel to partial messages (for model context)
      const messagesWithSentinel = addInterruptedSentinel(providerRequestMessages);

      // Get workspace metadata to retrieve workspace path
      const metadataResult = await this.getWorkspaceMetadata(workspaceId);
      if (!metadataResult.success) {
        return Err({ type: "unknown", raw: metadataResult.error });
      }

      const metadata = metadataResult.data;

      if (this.policyService?.isEnforced()) {
        if (!this.policyService.isRuntimeAllowed(metadata.runtimeConfig)) {
          return Err({
            type: "policy_denied",
            message: "Workspace runtime is not allowed by policy",
          });
        }
      }
      const workspaceLog = log.withFields({ workspaceId, workspaceName: metadata.name });

      if (!this.config.findWorkspace(workspaceId)) {
        return Err({ type: "unknown", raw: `Workspace ${workspaceId} not found in config` });
      }

      const runtime = isMultiProject(metadata)
        ? new MultiProjectRuntime(
            new ContainerManager(getSrcBaseDir(metadata.runtimeConfig) ?? this.config.srcDir),
            getProjects(metadata).map((project) => ({
              projectPath: project.projectPath,
              projectName: project.projectName,
              runtime: createRuntime(metadata.runtimeConfig, {
                projectPath: project.projectPath,
                workspaceName: metadata.name,
              }),
            })),
            metadata.name
          )
        : createRuntime(metadata.runtimeConfig, {
            projectPath: metadata.projectPath,
            workspaceName: metadata.name,
          });

      // In-place workspaces (CLI/benchmarks) have projectPath === name
      // Use path directly instead of reconstructing via getWorkspacePath
      const isInPlace = metadata.projectPath === metadata.name;
      const workspacePath = isInPlace
        ? metadata.projectPath
        : runtime.getWorkspacePath(metadata.projectPath, metadata.name);

      // Wait for init to complete before any runtime I/O operations
      // (SSH/devcontainer may not be ready until init finishes pulling the container)
      await this.initStateManager.waitForInit(workspaceId, combinedAbortSignal);
      if (combinedAbortSignal.aborted) {
        return Ok(undefined);
      }

      // Verify runtime is actually reachable after init completes.
      // For Docker workspaces, this checks the container exists and starts it if stopped.
      // For Coder workspaces, this may start a stopped workspace and wait for it.
      // If init failed during container creation, ensureReady() will return an error.
      const readyResult = await runtime.ensureReady({
        signal: combinedAbortSignal,
        statusSink: (status) => {
          // Emit runtime-status events for frontend UX (StreamingBarrier)
          this.emit("runtime-status", {
            type: "runtime-status",
            workspaceId,
            phase: status.phase,
            runtimeType: status.runtimeType,
            detail: status.detail,
          });
        },
      });
      if (!readyResult.ready) {
        // Generate message ID for the error event (frontend needs this for synthetic message)
        const errorMessageId = createAssistantMessageId();
        const runtimeType = metadata.runtimeConfig?.type ?? "local";
        const runtimeLabel = runtimeType === "docker" ? "Container" : "Runtime";
        const errorMessage = readyResult.error || `${runtimeLabel} unavailable.`;

        // Use the errorType from ensureReady result (runtime_not_ready vs runtime_start_failed)
        const errorType = readyResult.errorType;

        // Emit error event so frontend receives it via stream subscription.
        // This mirrors the context_exceeded pattern - the fire-and-forget sendMessage
        // call in useCreationWorkspace.ts won't see the returned Err, but will receive
        // this event through the workspace chat subscription.
        this.emit(
          "error",
          createErrorEvent(workspaceId, {
            messageId: errorMessageId,
            error: errorMessage,
            errorType,
            acpPromptId,
          })
        );

        return Err({
          type: errorType,
          message: errorMessage,
        });
      }

      // Resolve agent definition, compute effective mode & tool policy.
      const cfg = this.config.loadConfigOrDefault();
      const agentResult = await resolveAgentForStream({
        workspaceId,
        metadata,
        runtime,
        workspacePath,
        requestedAgentId: agentId,
        disableWorkspaceAgents: disableWorkspaceAgents ?? false,
        callerToolPolicy: toolPolicy,
        cfg,
        emitError: (event) => this.emit("error", event),
      });
      if (!agentResult.success) {
        return agentResult;
      }
      const {
        effectiveAgentId,
        agentDefinition,
        agentDiscoveryPath,
        isSubagentWorkspace,
        agentIsPlanLike,
        effectiveMode,
        taskSettings,
        taskDepth,
        shouldDisableTaskToolsForDepth,
        effectiveToolPolicy,
      } = agentResult.data;
      // Only the built-in mux help agent suppresses project secrets and MCP. User-defined
      // agents can override the same ID and must keep normal workspace capabilities.
      const isBuiltInMuxHelpAgent =
        effectiveAgentId === MUX_HELP_CHAT_AGENT_ID && agentDefinition.scope === "built-in";

      // Fetch workspace MCP overrides (for filtering servers and tools)
      // NOTE: Stored in <workspace>/.mux/mcp.local.jsonc (not ~/.mux/config.json).
      let mcpOverrides: WorkspaceMCPOverrides | undefined;
      try {
        mcpOverrides =
          await this.workspaceMcpOverridesService.getOverridesForWorkspace(workspaceId);
      } catch (error) {
        log.warn("[MCP] Failed to load workspace MCP overrides; continuing without overrides", {
          workspaceId,
          error,
        });
        mcpOverrides = undefined;
      }

      // Fetch MCP server config for system prompt (before building message)
      // Pass overrides to filter out disabled servers
      const mcpServers =
        this.mcpServerManager && !isBuiltInMuxHelpAgent
          ? await this.mcpServerManager.listServers(metadata.projectPath, mcpOverrides)
          : undefined;

      // Build plan-aware instructions and determine plan→exec transition content.
      // IMPORTANT: Derive this from the same boundary-sliced message payload that is sent to
      // the model so plan hints/handoffs cannot be suppressed by pre-boundary history.
      const { effectiveAdditionalInstructions, planFilePath, planContentForTransition } =
        await buildPlanInstructions({
          runtime,
          metadata,
          workspaceId,
          workspacePath,
          effectiveMode,
          effectiveAgentId,
          agentIsPlanLike,
          agentDiscoveryPath,
          additionalSystemInstructions,
          shouldDisableTaskToolsForDepth,
          taskDepth,
          taskSettings,
          requestPayloadMessages: providerRequestMessages,
        });

      const runtimeType = metadata.runtimeConfig.type;
      const muxScope: MuxToolScope =
        workspaceId === MUX_HELP_CHAT_WORKSPACE_ID
          ? { type: "global", muxHome: this.config.rootDir }
          : {
              type: "project",
              muxHome: this.config.rootDir,
              projectRoot: resolveMuxProjectRootForHostFs(metadata, workspacePath),
              projectStorageAuthority:
                runtimeType === "ssh" || runtimeType === "docker" ? "runtime" : "host-local",
            };

      // Build agent system prompt, system message, and discover agents/skills.
      const streamSystemContext = await buildStreamSystemContext({
        runtime,
        metadata,
        workspacePath,
        workspaceId,
        agentDefinition,
        agentDiscoveryPath,
        isSubagentWorkspace,
        effectiveAdditionalInstructions,
        modelString,
        cfg,
        providersConfig: this.providerService.getConfig(),
        mcpServers,
        muxScope,
      });
      const { agentSystemPrompt, agentDefinitions, availableSkills } = streamSystemContext;
      let systemMessageTokens = streamSystemContext.systemMessageTokens;
      let systemMessage = streamSystemContext.systemMessage;

      // Load project secrets (system workspace never gets secrets injected)
      const projectSecrets = isBuiltInMuxHelpAgent
        ? []
        : isMultiProject(metadata)
          ? mergeMultiProjectSecrets(metadata, this.config)
          : this.config.getEffectiveSecrets(metadata.projectPath);

      // Generate stream token and create temp directory for tools
      const streamToken = this.streamManager.generateStreamToken();

      let mcpTools: Record<string, Tool> | undefined;
      let mcpStats: MCPWorkspaceStats | undefined;
      let mcpSetupDurationMs = 0;

      if (this.mcpServerManager && !isBuiltInMuxHelpAgent) {
        const start = Date.now();
        try {
          const result = await this.mcpServerManager.getToolsForWorkspace({
            workspaceId,
            projectPath: metadata.projectPath,
            runtime,
            workspacePath,
            overrides: mcpOverrides,
            projectSecrets: await secretsToRecord(projectSecrets, this.opResolver),
          });

          mcpTools = result.tools;
          mcpStats = result.stats;
        } catch (error) {
          workspaceLog.error("Failed to start MCP servers", { error });
        } finally {
          mcpSetupDurationMs = Date.now() - start;
        }
      }

      if (mcpStats && mcpStats.failedServerCount > 0) {
        const failedNames = mcpStats.failedServerNames.join(", ");
        workspaceLog.warn("MCP servers failed to start", { failedNames });
        // Prepend warning so the model can inform the user about unavailable tools.
        systemMessage = `[Warning: ${mcpStats.failedServerCount} MCP server(s) failed to start: ${failedNames}. Tools from these servers are unavailable. Check MCP server configuration in Settings.]\n\n${systemMessage}`;
        // Keep context-size estimation accurate after mutating the system prompt.
        const metadataModel = resolveModelForMetadata(
          modelString,
          this.providerService.getConfig()
        );
        const tokenizer = await getTokenizerForModel(modelString, metadataModel);
        systemMessageTokens = await tokenizer.countTokens(systemMessage);
      }

      const runtimeTempDir = await this.streamManager.createTempDirForStream(streamToken, runtime);

      // Extract tool-specific instructions from AGENTS.md files and agent definition
      const toolInstructions = await readToolInstructions(
        metadata,
        runtime,
        workspacePath,
        modelString,
        agentSystemPrompt
      );

      // Calculate cumulative session costs for MUX_COSTS_USD env var
      let sessionCostsUsd: number | undefined;
      if (this.sessionUsageService) {
        const sessionUsage = await this.sessionUsageService.getSessionUsage(workspaceId);
        if (sessionUsage) {
          const allUsage = sumUsageHistory(Object.values(sessionUsage.byModel));
          sessionCostsUsd = getTotalCost(allUsage);
        }
      }

      // Get model-specific tools with workspace path (correct for local or remote)
      const allTools = await getToolsForModel(
        modelString,
        {
          cwd: workspacePath,
          runtime,
          projects: getProjects(metadata),
          secrets: await secretsToRecord(projectSecrets, this.opResolver),
          muxEnv: getMuxEnv(
            metadata.projectPath,
            getRuntimeType(metadata.runtimeConfig),
            metadata.name,
            {
              modelString,
              thinkingLevel: thinkingLevel ?? "off",
              costsUsd: sessionCostsUsd,
            }
          ),
          runtimeTempDir,
          openaiWireFormat: effectiveMuxProviderOptions?.openai?.wireFormat,
          backgroundProcessManager: this.backgroundProcessManager,
          // Plan agent configuration for plan file access.
          // - read: plan file is readable in all agents (useful context)
          // - write: enforced by file_edit_* tools (plan file is read-only outside plan agent)
          planFileOnly: agentIsPlanLike,
          emitChatEvent: (event) => {
            // Defensive: tools should only emit events for the workspace they belong to.
            if ("workspaceId" in event && event.workspaceId !== workspaceId) {
              return;
            }
            this.emit(event.type, event as never);
          },
          workspaceSessionDir: this.config.getSessionDir(workspaceId),
          planFilePath,
          workspaceId,
          muxScope,
          // Only child workspaces (tasks) can report to a parent.
          enableAgentReport: Boolean(metadata.parentWorkspaceId),
          // External edit detection callback
          recordFileState,
          onConfigChanged: () => this.providerService.notifyConfigChanged(),
          taskService: this.taskService,
          analyticsService: this.analyticsService,
          // PTC experiments for inheritance to subagents
          experiments,
          // Dynamic context for tool descriptions (moved from system prompt for better model attention)
          availableSubagents: agentDefinitions,
          availableSkills,
          // Trust gating: only run hooks/scripts when the full shared workspace runtime is trusted.
          trusted: isWorkspaceTrustedForSharedExecution(
            metadata,
            this.config.loadConfigOrDefault().projects
          ),
        },
        workspaceId,
        this.initStateManager,
        toolInstructions,
        mcpTools
      );
      const toolsWithDelegation = this.wrapToolsForDelegation(
        workspaceId,
        allTools,
        delegatedToolNames
      );

      // Create assistant message ID early so the PTC callback closure captures it.
      // The placeholder is appended to history below (after abort check).
      const assistantMessageId = createAssistantMessageId();

      // Apply tool policy and PTC experiments (lazy-loads PTC dependencies only when needed).
      const tools = await applyToolPolicyAndExperiments({
        allTools: toolsWithDelegation,
        extraTools: this.extraTools,
        effectiveToolPolicy,
        experiments,
        // Forward nested PTC tool events to the stream (tool-call-start/end only,
        // not console events which appear in final result only).
        emitNestedToolEvent: (event: PTCEventWithParent) => {
          if (event.type === "tool-call-start" || event.type === "tool-call-end") {
            this.streamManager.emitNestedToolEvent(workspaceId, assistantMessageId, event);
          }
        },
      });

      const toolNamesForSentinel = Object.keys(tools).sort();

      // Run the full message preparation pipeline (inject context, transform, validate).
      // This is a purely functional pipeline with no service dependencies.
      const finalMessages = await prepareMessagesForProvider({
        messagesWithSentinel,
        effectiveAgentId,
        toolNamesForSentinel,
        planContentForTransition,
        planFilePath,
        changedFileAttachments,
        postCompactionAttachments,
        runtime,
        workspacePath,
        abortSignal: combinedAbortSignal,
        providerForMessages: canonicalProviderName,
        effectiveThinkingLevel,
        modelString,
        anthropicCacheTtl: effectiveMuxProviderOptions.anthropic?.cacheTtl,
        workspaceId,
      });

      captureMcpToolTelemetry({
        telemetryService: this.telemetryService,
        mcpStats,
        mcpTools,
        tools,
        mcpSetupDurationMs,
        workspaceId,
        modelString,
        effectiveAgentId,
        metadata,
        effectiveToolPolicy,
      });

      if (combinedAbortSignal.aborted) {
        return Ok(undefined);
      }

      const assistantMessage = createMuxMessage(assistantMessageId, "assistant", "", {
        timestamp: Date.now(),
        model: canonicalModelString,
        routedThroughGateway,
        systemMessageTokens,
        agentId: effectiveAgentId,
      });

      // Append to history to get historySequence assigned
      const appendResult = await this.historyService.appendToHistory(workspaceId, assistantMessage);
      if (!appendResult.success) {
        return Err({ type: "unknown", raw: appendResult.error });
      }

      // Get the assigned historySequence
      const historySequence = assistantMessage.metadata?.historySequence ?? 0;

      // Handle simulated stream scenarios (OpenAI SDK testing features).
      // These emit synthetic stream events without calling an AI provider.
      const forceContextLimitError =
        modelString.startsWith("openai:") &&
        effectiveMuxProviderOptions.openai?.forceContextLimitError === true;
      const simulateToolPolicyNoopFlag =
        modelString.startsWith("openai:") &&
        effectiveMuxProviderOptions.openai?.simulateToolPolicyNoop === true;

      if (forceContextLimitError || simulateToolPolicyNoopFlag) {
        const simulationCtx: SimulationContext = {
          workspaceId,
          assistantMessageId,
          canonicalModelString,
          routedThroughGateway,
          historySequence,
          systemMessageTokens,
          effectiveAgentId,
          effectiveMode,
          effectiveThinkingLevel,
          emit: (event, data) => this.emit(event, data),
        };

        if (forceContextLimitError) {
          await simulateContextLimitError(simulationCtx, this.historyService);
        } else {
          await simulateToolPolicyNoop(simulationCtx, effectiveToolPolicy, this.historyService);
        }
        return Ok(undefined);
      }

      // Build provider options based on thinking level and request-sliced message history.
      const truncationMode = openaiTruncationModeOverride;
      // Use the same boundary-sliced payload history that we send to the provider.
      // This keeps OpenAI request state aligned with the explicit history Mux sends.
      // Pass workspaceId to derive stable promptCacheKey for OpenAI caching.
      const providerOptions = buildProviderOptions(
        modelString,
        effectiveThinkingLevel,
        providerRequestMessages,
        (id) => this.streamManager.isResponseIdLost(id),
        effectiveMuxProviderOptions,
        workspaceId,
        truncationMode,
        this.providerService.getConfig()
      );

      // Build per-request HTTP headers (e.g., workspace correlation and
      // anthropic-beta for 1M context). This is the single injection site for
      // provider-specific headers, handling both direct and gateway-routed models
      // identically.
      let requestHeaders = buildRequestHeaders(
        modelString,
        effectiveMuxProviderOptions,
        workspaceId,
        this.providerService.getConfig()
      );

      // --- Model parameter overrides from providers.jsonc ---
      const providersConfig = this.config.loadProvidersConfig();
      const resolvedOverrides = resolveModelParameterOverrides(
        providersConfig,
        canonicalProviderName,
        canonicalModelString,
        effectiveModelString
      );

      // Merge provider extras (user knobs) UNDER Mux-built options (safety-critical).
      // Recursive merge within the provider namespace preserves non-conflicting nested
      // subfields (e.g., user reasoning.max_tokens alongside Mux reasoning.enabled).
      // Mux-built values win on leaf conflicts for safety of thinking/reasoning/cache.
      const muxProviderNamespace = (providerOptions as Record<string, unknown>)?.[
        canonicalProviderName
      ];
      const mergedProviderOptions = resolvedOverrides.providerExtras
        ? {
            ...providerOptions,
            [canonicalProviderName]: isPlainObject(muxProviderNamespace)
              ? mergeProviderExtrasUnderMux(resolvedOverrides.providerExtras, muxProviderNamespace)
              : resolvedOverrides.providerExtras,
          }
        : providerOptions;

      if (Object.keys(resolvedOverrides.standard).length > 0 || resolvedOverrides.providerExtras) {
        log.debug(
          `Resolved model parameter overrides for ${canonicalModelString}`,
          resolvedOverrides
        );
      }

      // Debug dump: Log the complete LLM request when MUX_DEBUG_LLM_REQUEST is set
      if (process.env.MUX_DEBUG_LLM_REQUEST === "1") {
        log.info(
          `[MUX_DEBUG_LLM_REQUEST] Full LLM request:\n${JSON.stringify(
            {
              workspaceId,
              model: modelString,
              systemMessage,
              messages: finalMessages,
              tools: Object.fromEntries(
                Object.entries(tools).map(([n, t]) => [
                  n,
                  { description: t.description, inputSchema: t.inputSchema },
                ])
              ),
              providerOptions: mergedProviderOptions,
              thinkingLevel: effectiveThinkingLevel,
              maxOutputTokens,
              mode: effectiveMode,
              agentId: effectiveAgentId,
              toolPolicy: effectiveToolPolicy,
            },
            null,
            2
          )}`
        );

        if (resolvedOverrides.standard && Object.keys(resolvedOverrides.standard).length > 0) {
          log.debug("Model parameter overrides (standard):", resolvedOverrides.standard);
        }
        if (resolvedOverrides.providerExtras) {
          log.debug(
            "Model parameter overrides (provider extras):",
            resolvedOverrides.providerExtras
          );
        }
      }

      if (combinedAbortSignal.aborted) {
        await deleteAbortedPlaceholder(assistantMessageId);
        return Ok(undefined);
      }

      // Capture request payload for the debug modal, then delegate to StreamManager.
      const snapshot: DebugLlmRequestSnapshot = {
        capturedAt: Date.now(),
        workspaceId,
        messageId: assistantMessageId,
        model: modelString,
        providerName: canonicalProviderName,
        thinkingLevel: effectiveThinkingLevel,
        mode: effectiveMode,
        agentId: effectiveAgentId,
        maxOutputTokens,
        systemMessage,
        messages: finalMessages,
      };

      try {
        this.lastLlmRequestByWorkspace.set(workspaceId, safeClone(snapshot));
      } catch (error) {
        const errMsg = getErrorMessage(error);
        workspaceLog.warn("Failed to capture debug LLM request snapshot", { error: errMsg });
      }
      const toolsForStream =
        experiments?.system1 === true
          ? wrapToolsWithSystem1({
              tools,
              system1Model,
              system1ThinkingLevel,
              modelString,
              effectiveModelString,
              primaryModel: modelResult.data.model,
              muxProviderOptions: effectiveMuxProviderOptions,
              workspaceId,
              effectiveMode,
              planFilePath,
              taskSettings,
              runtimeTempDir,
              runtime,
              agentDiscoveryPath,
              createModel: (ms, o, createOptions) =>
                this.createModel(ms, o, { ...(createOptions ?? {}), workspaceId }),
              emitBashOutput: (ev) => this.emit("bash-output", ev),
              sessionUsageService: this.sessionUsageService,
            })
          : tools;
      // Top-level agents need a belt-and-suspenders toolChoice safety net for
      // required routing/completion tools. Sub-agents rely on taskService.ts
      // post-stream recovery when a required tool is skipped.
      const forceToolChoice = !isSubagentWorkspace;

      const canQueueDevToolsRunMetadata =
        this.devToolsService?.enabled === true &&
        typeof modelResult.data.model !== "string" &&
        modelResult.data.model.specificationVersion === "v3";

      if (canQueueDevToolsRunMetadata) {
        // Correlate pending run metadata with the specific request that reaches
        // DevTools middleware to avoid cross-request policy leakage. Queue only
        // when middleware is guaranteed to run (LanguageModelV3).
        pendingRunMetadataId = String(streamToken);
        this.devToolsService.setPendingRunMetadata(workspaceId, pendingRunMetadataId, {
          toolPolicy:
            effectiveToolPolicy != null && effectiveToolPolicy.length > 0
              ? effectiveToolPolicy
              : undefined,
        });
        this.trackPendingDevToolsRunMetadata(assistantMessageId, workspaceId, pendingRunMetadataId);
        requestHeaders = {
          ...requestHeaders,
          [DEVTOOLS_RUN_METADATA_ID_HEADER]: pendingRunMetadataId,
        };
      }

      const streamResult = await this.streamManager.startStream(
        workspaceId,
        finalMessages,
        modelResult.data.model,
        modelString,
        historySequence,
        systemMessage,
        runtime,
        assistantMessageId, // Shared messageId ensures nested tool events match stream events
        combinedAbortSignal,
        toolsForStream,
        {
          systemMessageTokens,
          timestamp: Date.now(),
          agentId: effectiveAgentId,
          mode: effectiveMode,
          routedThroughGateway,
          ...(acpPromptId != null ? { acpPromptId } : {}),
          ...(modelCostsIncluded(modelResult.data.model) ? { costsIncluded: true } : {}),
        },
        mergedProviderOptions,
        maxOutputTokens,
        effectiveToolPolicy,
        streamToken, // Pass the pre-generated stream token
        hasQueuedMessage,
        metadata.name,
        effectiveThinkingLevel,
        requestHeaders,
        effectiveMuxProviderOptions.anthropic?.cacheTtl ?? undefined,
        forceToolChoice,
        resolvedOverrides.standard
      );

      if (!streamResult.success) {
        // StreamManager failed before registering a stream. Clear queued run
        // metadata so it cannot attach to a later unrelated request.
        if (pendingRunMetadataId != null) {
          this.clearTrackedPendingDevToolsRunMetadata(assistantMessageId);
          pendingRunMetadataId = null;
        }

        // StreamManager already returns SendMessageError
        return Err(streamResult.error);
      }

      // If we were interrupted during StreamManager startup before the stream was registered,
      // make sure we don't leave an empty assistant placeholder behind.
      if (combinedAbortSignal.aborted && !this.streamManager.isStreaming(workspaceId)) {
        if (pendingRunMetadataId != null) {
          this.clearTrackedPendingDevToolsRunMetadata(assistantMessageId);
          pendingRunMetadataId = null;
        }
        await deleteAbortedPlaceholder(assistantMessageId);
      }

      // StreamManager now handles history updates directly on stream-end
      // No need for event listener here
      return Ok(undefined);
    } catch (error) {
      if (pendingRunMetadataId != null) {
        this.clearTrackedPendingDevToolsRunMetadataById(workspaceId, pendingRunMetadataId);
        pendingRunMetadataId = null;
      }

      const errorMessage = getErrorMessage(error);
      log.error("Stream message error:", error);
      // Return as unknown error type
      return Err({ type: "unknown", raw: `Failed to stream message: ${errorMessage}` });
    } finally {
      unlinkAbortSignal();
      const pending = this.pendingStreamStarts.get(workspaceId);
      if (pending?.abortController === pendingAbortController) {
        this.pendingStreamStarts.delete(workspaceId);
      }
    }
  }

  async stopStream(
    workspaceId: string,
    options?: { soft?: boolean; abandonPartial?: boolean; abortReason?: StreamAbortReason }
  ): Promise<Result<void>> {
    const pending = this.pendingStreamStarts.get(workspaceId);
    const isActuallyStreaming =
      this.mockModeEnabled && this.mockAiStreamPlayer
        ? this.mockAiStreamPlayer.isStreaming(workspaceId)
        : this.streamManager.isStreaming(workspaceId);

    if (pending) {
      pending.abortController.abort();

      // If we're still in pre-stream startup (no StreamManager stream yet), emit a synthetic
      // stream-abort so the renderer can exit the "starting..." UI immediately.
      const abortReason = options?.abortReason ?? "startup";
      if (!isActuallyStreaming) {
        this.emit("stream-abort", {
          type: "stream-abort",
          workspaceId,
          abortReason,
          messageId: pending.syntheticMessageId,
          metadata: { duration: Date.now() - pending.startTime },
          abandonPartial: options?.abandonPartial,
          acpPromptId: pending.acpPromptId,
        } satisfies StreamAbortEvent);
      }
    }

    if (this.mockModeEnabled && this.mockAiStreamPlayer) {
      this.mockAiStreamPlayer.stop(workspaceId);
      return Ok(undefined);
    }
    return this.streamManager.stopStream(workspaceId, options);
  }

  /**
   * Check if a workspace is currently streaming
   */
  isStreaming(workspaceId: string): boolean {
    if (this.mockModeEnabled && this.mockAiStreamPlayer) {
      return this.mockAiStreamPlayer.isStreaming(workspaceId);
    }
    return this.streamManager.isStreaming(workspaceId);
  }

  /**
   * Get the current stream state for a workspace
   */
  getStreamState(workspaceId: string): string {
    if (this.mockModeEnabled && this.mockAiStreamPlayer) {
      return this.mockAiStreamPlayer.isStreaming(workspaceId) ? "streaming" : "idle";
    }
    return this.streamManager.getStreamState(workspaceId);
  }

  /**
   * Get the current stream info for a workspace if actively streaming
   * Used to re-establish streaming context on frontend reconnection
   */
  getStreamInfo(workspaceId: string): ReturnType<typeof this.streamManager.getStreamInfo> {
    if (this.mockModeEnabled && this.mockAiStreamPlayer) {
      return undefined;
    }
    return this.streamManager.getStreamInfo(workspaceId);
  }

  /**
   * Replay stream events
   * Emits the same events that would be emitted during live streaming
   */
  async replayStream(workspaceId: string, opts?: { afterTimestamp?: number }): Promise<void> {
    if (this.mockModeEnabled && this.mockAiStreamPlayer) {
      await this.mockAiStreamPlayer.replayStream(workspaceId);
      return;
    }
    await this.streamManager.replayStream(workspaceId, opts);
  }

  debugGetLastMockPrompt(workspaceId: string): Result<MuxMessage[] | null> {
    if (typeof workspaceId !== "string" || workspaceId.trim().length === 0) {
      return Err("debugGetLastMockPrompt: workspaceId is required");
    }

    if (!this.mockModeEnabled || !this.mockAiStreamPlayer) {
      return Ok(null);
    }

    return Ok(this.mockAiStreamPlayer.debugGetLastPrompt(workspaceId));
  }
  debugGetLastMockModel(workspaceId: string): Result<string | null> {
    if (typeof workspaceId !== "string" || workspaceId.trim().length === 0) {
      return Err("debugGetLastMockModel: workspaceId is required");
    }

    if (!this.mockModeEnabled || !this.mockAiStreamPlayer) {
      return Ok(null);
    }

    return Ok(this.mockAiStreamPlayer.debugGetLastModel(workspaceId));
  }

  debugGetLastLlmRequest(workspaceId: string): Result<DebugLlmRequestSnapshot | null> {
    if (typeof workspaceId !== "string" || workspaceId.trim().length === 0) {
      return Err("debugGetLastLlmRequest: workspaceId is required");
    }

    return Ok(this.lastLlmRequestByWorkspace.get(workspaceId) ?? null);
  }

  /**
   * DEBUG ONLY: Trigger an artificial stream error for testing.
   * This is used by integration tests to simulate network errors mid-stream.
   * @returns true if an active stream was found and error was triggered
   */
  debugTriggerStreamError(
    workspaceId: string,
    errorMessage = "Test-triggered stream error"
  ): Promise<boolean> {
    return this.streamManager.debugTriggerStreamError(workspaceId, errorMessage);
  }

  /**
   * Wait for workspace initialization to complete (if running).
   * Public wrapper for agent discovery and other callers.
   */
  async waitForInit(workspaceId: string, abortSignal?: AbortSignal): Promise<void> {
    return this.initStateManager.waitForInit(workspaceId, abortSignal);
  }

  async deleteWorkspace(workspaceId: string): Promise<Result<void>> {
    try {
      const workspaceDir = this.config.getSessionDir(workspaceId);
      await fs.rm(workspaceDir, { recursive: true, force: true });
      return Ok(undefined);
    } catch (error) {
      const message = getErrorMessage(error);
      return Err(`Failed to delete workspace: ${message}`);
    }
  }
}
