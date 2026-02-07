import * as fs from "fs/promises";
import { EventEmitter } from "events";

import { type LanguageModel, type Tool } from "ai";

import { linkAbortSignal } from "@/node/utils/abort";
import type { Result } from "@/common/types/result";
import { Ok, Err } from "@/common/types/result";
import type { WorkspaceMetadata } from "@/common/types/workspace";
import type { SendMessageOptions } from "@/common/orpc/types";

import type { DebugLlmRequestSnapshot } from "@/common/types/debugLlmRequest";

import type { MuxMessage, MuxTextPart } from "@/common/types/message";
import { createMuxMessage } from "@/common/types/message";
import type { Config } from "@/node/config";
import { StreamManager } from "./streamManager";
import type { InitStateManager } from "./initStateManager";
import type { SendMessageError } from "@/common/types/errors";
import { getToolsForModel } from "@/common/utils/tools/tools";
import { createRuntime } from "@/node/runtime/runtimeFactory";
import { getMuxEnv, getRuntimeType } from "@/node/runtime/initHook";
import { MUX_HELP_CHAT_WORKSPACE_ID } from "@/common/constants/muxChat";
import { secretsToRecord } from "@/common/types/secrets";
import type { MuxProviderOptions } from "@/common/types/providerOptions";
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
import { normalizeGatewayModel } from "@/common/utils/ai/models";
import type { HistoryService } from "./historyService";
import type { PartialService } from "./partialService";
import { createErrorEvent } from "./utils/sendMessageError";
import { createAssistantMessageId } from "./utils/messageIds";
import type { SessionUsageService } from "./sessionUsageService";
import { sumUsageHistory, getTotalCost } from "@/common/utils/tokens/usageAggregator";
import { readToolInstructions } from "./systemMessage";
import type { TelemetryService } from "@/node/services/telemetryService";
import { getRuntimeTypeForTelemetry, roundToBase2 } from "@/common/telemetry/utils";
import type { WorkspaceMCPOverrides } from "@/common/types/mcp";
import type { MCPServerManager, MCPWorkspaceStats } from "@/node/services/mcpServerManager";
import { WorkspaceMcpOverridesService } from "./workspaceMcpOverridesService";
import type { TaskService } from "@/node/services/taskService";
import { buildProviderOptions } from "@/common/utils/ai/providerOptions";

import { THINKING_LEVEL_OFF, type ThinkingLevel } from "@/common/types/thinking";

import type {
  StreamAbortEvent,
  StreamAbortReason,
  StreamDeltaEvent,
  StreamEndEvent,
  StreamStartEvent,
} from "@/common/types/stream";
import { applyToolPolicy, type ToolPolicy } from "@/common/utils/tools/toolPolicy";
// PTC types only - modules lazy-loaded to avoid loading typescript/prettier at startup
import type {
  PTCEventWithParent,
  createCodeExecutionTool as CreateCodeExecutionToolFn,
} from "@/node/services/tools/code_execution";
import type { QuickJSRuntimeFactory } from "@/node/services/ptc/quickjsRuntime";
import type { ToolBridge } from "@/node/services/ptc/toolBridge";
import { MockAiStreamPlayer } from "./mock/mockAiStreamPlayer";
import { ProviderModelFactory, parseModelString, modelCostsIncluded } from "./providerModelFactory";
import { wrapToolsWithSystem1 } from "./system1ToolWrapper";
import { prepareMessagesForProvider } from "./messagePipeline";
import { resolveAgentForStream } from "./agentResolution";
import { buildPlanInstructions, buildStreamSystemContext } from "./streamContextBuilder";

// Lazy-loaded PTC modules (only loaded when experiment is enabled)
// This avoids loading typescript/prettier at startup which causes issues:
// - Integration tests fail without --experimental-vm-modules (prettier uses dynamic imports)
// - Smoke tests fail if typescript isn't in production bundle
// Dynamic imports are justified: PTC pulls in ~10MB of dependencies that would slow startup.
interface PTCModules {
  createCodeExecutionTool: typeof CreateCodeExecutionToolFn;
  QuickJSRuntimeFactory: typeof QuickJSRuntimeFactory;
  ToolBridge: typeof ToolBridge;
  runtimeFactory: QuickJSRuntimeFactory | null;
}
let ptcModules: PTCModules | null = null;

async function getPTCModules(): Promise<PTCModules> {
  if (ptcModules) return ptcModules;

  /* eslint-disable no-restricted-syntax -- Dynamic imports required here to avoid loading
     ~10MB of typescript/prettier/quickjs at startup (causes CI failures) */
  const [codeExecution, quickjs, toolBridge] = await Promise.all([
    import("@/node/services/tools/code_execution"),
    import("@/node/services/ptc/quickjsRuntime"),
    import("@/node/services/ptc/toolBridge"),
  ]);
  /* eslint-enable no-restricted-syntax */

  ptcModules = {
    createCodeExecutionTool: codeExecution.createCodeExecutionTool,
    QuickJSRuntimeFactory: quickjs.QuickJSRuntimeFactory,
    ToolBridge: toolBridge.ToolBridge,
    runtimeFactory: null,
  };
  return ptcModules;
}

// Re-export for backwards compatibility (tests import from aiService.ts)
export { discoverAvailableSubagentsForToolContext } from "./streamContextBuilder";

export class AIService extends EventEmitter {
  private readonly streamManager: StreamManager;
  private readonly historyService: HistoryService;
  private readonly partialService: PartialService;
  private readonly config: Config;
  private readonly workspaceMcpOverridesService: WorkspaceMcpOverridesService;
  private mcpServerManager?: MCPServerManager;
  private readonly policyService?: PolicyService;
  private readonly telemetryService?: TelemetryService;
  private readonly initStateManager: InitStateManager;
  private mockModeEnabled: boolean;
  private mockAiStreamPlayer?: MockAiStreamPlayer;
  private readonly backgroundProcessManager?: BackgroundProcessManager;
  private readonly sessionUsageService?: SessionUsageService;
  private readonly providerModelFactory: ProviderModelFactory;

  // Tracks in-flight stream startup (before StreamManager emits stream-start).
  // This enables user interrupts (Esc/Ctrl+C) during the UI "starting..." phase.
  private readonly pendingStreamStarts = new Map<
    string,
    { abortController: AbortController; startTime: number; syntheticMessageId: string }
  >();

  // Debug: captured LLM request payloads for last send per workspace
  private lastLlmRequestByWorkspace = new Map<string, DebugLlmRequestSnapshot>();
  private taskService?: TaskService;
  private extraTools?: Record<string, Tool>;

  constructor(
    config: Config,
    historyService: HistoryService,
    partialService: PartialService,
    initStateManager: InitStateManager,
    providerService: ProviderService,
    backgroundProcessManager?: BackgroundProcessManager,
    sessionUsageService?: SessionUsageService,
    workspaceMcpOverridesService?: WorkspaceMcpOverridesService,
    policyService?: PolicyService,
    telemetryService?: TelemetryService
  ) {
    super();
    // Increase max listeners to accommodate multiple concurrent workspace listeners
    // Each workspace subscribes to stream events, and we expect >10 concurrent workspaces
    this.setMaxListeners(50);
    this.workspaceMcpOverridesService =
      workspaceMcpOverridesService ?? new WorkspaceMcpOverridesService(config);
    this.config = config;
    this.historyService = historyService;
    this.partialService = partialService;
    this.initStateManager = initStateManager;
    this.backgroundProcessManager = backgroundProcessManager;
    this.sessionUsageService = sessionUsageService;
    this.policyService = policyService;
    this.telemetryService = telemetryService;
    this.streamManager = new StreamManager(historyService, partialService, sessionUsageService);
    this.providerModelFactory = new ProviderModelFactory(config, providerService, policyService);
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
    this.streamManager.on("stream-start", (data) => this.emit("stream-start", data));
    this.streamManager.on("stream-delta", (data) => this.emit("stream-delta", data));
    this.streamManager.on("stream-end", (data: StreamEndEvent) => {
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

            const cloned =
              typeof structuredClone === "function"
                ? structuredClone(updated)
                : (JSON.parse(JSON.stringify(updated)) as DebugLlmRequestSnapshot);

            this.lastLlmRequestByWorkspace.set(data.workspaceId, cloned);
          }
        }
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        log.warn("Failed to capture debug LLM response snapshot", { error: errMsg });
      }

      this.emit("stream-end", data);
    });

    // Handle stream-abort: dispose of partial based on abandonPartial flag
    this.streamManager.on("stream-abort", (data: StreamAbortEvent) => {
      void (async () => {
        if (data.abandonPartial) {
          // Caller requested discarding partial - delete without committing
          await this.partialService.deletePartial(data.workspaceId);
        } else {
          // Commit interrupted message to history with partial:true metadata
          // This ensures /clear and /truncate can clean up interrupted messages
          const partial = await this.partialService.readPartial(data.workspaceId);
          if (partial) {
            await this.partialService.commitToHistory(data.workspaceId);
            await this.partialService.deletePartial(data.workspaceId);
          }
        }

        // Forward abort event to consumers
        this.emit("stream-abort", data);
      })();
    });

    this.streamManager.on("error", (data) => this.emit("error", data));
    // Forward tool events
    this.streamManager.on("tool-call-start", (data) => this.emit("tool-call-start", data));
    this.streamManager.on("tool-call-delta", (data) => this.emit("tool-call-delta", data));
    this.streamManager.on("tool-call-end", (data) => this.emit("tool-call-end", data));
    // Forward reasoning events
    this.streamManager.on("reasoning-delta", (data) => this.emit("reasoning-delta", data));
    this.streamManager.on("reasoning-end", (data) => this.emit("reasoning-end", data));
    this.streamManager.on("usage-delta", (data) => this.emit("usage-delta", data));
  }

  private async ensureSessionsDir(): Promise<void> {
    try {
      await fs.mkdir(this.config.sessionsDir, { recursive: true });
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
      const message = error instanceof Error ? error.message : String(error);
      return Err(`Failed to read workspace metadata: ${message}`);
    }
  }

  /**
   * Create an AI SDK model from a model string (e.g., "anthropic:claude-opus-4-1").
   * Delegates to ProviderModelFactory.
   */
  async createModel(
    modelString: string,
    muxProviderOptions?: MuxProviderOptions
  ): Promise<Result<LanguageModel, SendMessageError>> {
    return this.providerModelFactory.createModel(modelString, muxProviderOptions);
  }

  /**
   * Stream a message conversation to the AI model
   * @param messages Array of conversation messages
   * @param workspaceId Unique identifier for the workspace
   * @param modelString Model string (e.g., "anthropic:claude-opus-4-1") - required from frontend
   * @param thinkingLevel Optional thinking/reasoning level for AI models
   * @param toolPolicy Optional policy to filter available tools
   * @param abortSignal Optional signal to abort the stream
   * @param additionalSystemInstructions Optional additional system instructions to append
   * @param maxOutputTokens Optional maximum tokens for model output
   * @param muxProviderOptions Optional provider-specific options
   * @param agentId Optional agent id - determines tool policy and plan-file behavior
   * @param recordFileState Optional callback to record file state for external edit detection
   * @param changedFileAttachments Optional attachments for files that were edited externally
   * @param postCompactionAttachments Optional attachments to inject after compaction
   * @param disableWorkspaceAgents When true, read agent definitions from project path instead of workspace worktree
   * @param openaiTruncationModeOverride Optional OpenAI truncation override (e.g., compaction retry)
   * @returns Promise that resolves when streaming completes or fails
   */
  async streamMessage(
    messages: MuxMessage[],
    workspaceId: string,
    modelString: string,
    thinkingLevel?: ThinkingLevel,
    toolPolicy?: ToolPolicy,
    abortSignal?: AbortSignal,
    additionalSystemInstructions?: string,
    maxOutputTokens?: number,
    muxProviderOptions?: MuxProviderOptions,
    agentId?: string,
    recordFileState?: (filePath: string, state: FileState) => void,
    changedFileAttachments?: EditedFileAttachment[],
    postCompactionAttachments?: PostCompactionAttachment[] | null,
    experiments?: SendMessageOptions["experiments"],
    system1Model?: string,
    system1ThinkingLevel?: ThinkingLevel,
    disableWorkspaceAgents?: boolean,
    hasQueuedMessage?: () => boolean,
    openaiTruncationModeOverride?: "auto" | "disabled"
  ): Promise<Result<void, SendMessageError>> {
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
    });

    const combinedAbortSignal = pendingAbortController.signal;

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
      await this.partialService.commitToHistory(workspaceId);

      // Mode (plan|exec|compact) is derived from the selected agent definition.
      const effectiveMuxProviderOptions: MuxProviderOptions = muxProviderOptions ?? {};
      const effectiveThinkingLevel: ThinkingLevel = thinkingLevel ?? THINKING_LEVEL_OFF;

      // For xAI models, swap between reasoning and non-reasoning variants based on thinking level
      // Similar to how OpenAI handles reasoning vs non-reasoning models
      const explicitlyRequestedGateway = modelString.trim().startsWith("mux-gateway:");
      const canonicalModelString = normalizeGatewayModel(modelString);
      let effectiveModelString = canonicalModelString;
      const [canonicalProviderName, canonicalModelId] = parseModelString(canonicalModelString);
      if (canonicalProviderName === "xai" && canonicalModelId === "grok-4-1-fast") {
        // xAI Grok only supports full reasoning (no medium/low)
        // Map to appropriate variant based on thinking level
        const variant =
          effectiveThinkingLevel !== "off"
            ? "grok-4-1-fast-reasoning"
            : "grok-4-1-fast-non-reasoning";
        effectiveModelString = `xai:${variant}`;
        log.debug("Mapping xAI Grok model to variant", {
          original: modelString,
          effective: effectiveModelString,
          thinkingLevel: effectiveThinkingLevel,
        });
      }

      effectiveModelString = this.providerModelFactory.resolveGatewayModelString(
        effectiveModelString,
        canonicalModelString,
        explicitlyRequestedGateway
      );

      const routedThroughGateway = effectiveModelString.startsWith("mux-gateway:");

      // Create model instance with early API key validation
      const modelResult = await this.createModel(effectiveModelString, effectiveMuxProviderOptions);
      if (!modelResult.success) {
        return Err(modelResult.error);
      }

      // Dump original messages for debugging
      log.debug_obj(`${workspaceId}/1_original_messages.json`, messages);

      // Normalize provider for provider-specific handling (Mux Gateway models should behave
      // like their underlying provider for message transforms and compliance checks).
      const providerForMessages = canonicalProviderName;

      // Tool names are needed for the mode transition sentinel injection.
      // Compute them once we know the effective agent + tool policy.
      let toolNamesForSentinel: string[] = [];

      // Filter out assistant messages with only reasoning (no text/tools)
      // EXCEPTION: When extended thinking is enabled, preserve reasoning-only messages
      // to comply with Extended Thinking API requirements
      const preserveReasoningOnly =
        providerForMessages === "anthropic" && effectiveThinkingLevel !== "off";
      const filteredMessages = filterEmptyAssistantMessages(messages, preserveReasoningOnly);
      log.debug(`Filtered ${messages.length - filteredMessages.length} empty assistant messages`);
      log.debug_obj(`${workspaceId}/1a_filtered_messages.json`, filteredMessages);

      // OpenAI-specific: Keep reasoning parts in history
      // OpenAI manages conversation state via previousResponseId
      if (providerForMessages === "openai") {
        log.debug("Keeping reasoning parts for OpenAI (managed via previousResponseId)");
      }

      // Add [CONTINUE] sentinel to partial messages (for model context)
      const messagesWithSentinel = addInterruptedSentinel(filteredMessages);

      // Note: Further message processing (mode transition, file changes, etc.) happens
      // after runtime is created below, as we need runtime to read the plan file

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

      // Get actual workspace path from config (handles both legacy and new format)
      const workspace = this.config.findWorkspace(workspaceId);
      if (!workspace) {
        return Err({ type: "unknown", raw: `Workspace ${workspaceId} not found in config` });
      }

      // Get workspace path - handle both worktree and in-place modes
      const runtime = createRuntime(metadata.runtimeConfig, {
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
        modelString,
        callerToolPolicy: toolPolicy,
        cfg,
        emitError: (event) => this.emit("error", event),
        initStateManager: this.initStateManager,
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
      toolNamesForSentinel = agentResult.data.toolNamesForSentinel;

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
        this.mcpServerManager && workspaceId !== MUX_HELP_CHAT_WORKSPACE_ID
          ? await this.mcpServerManager.listServers(metadata.projectPath, mcpOverrides)
          : undefined;

      // Build plan-aware instructions and determine plan→exec transition content.
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
          filteredMessages,
        });

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
        providerForMessages,
        effectiveThinkingLevel,
        modelString,
        canonicalModelId,
        workspaceId,
      });

      // Build agent system prompt, system message, and discover agents/skills.
      const {
        agentSystemPrompt,
        systemMessage,
        systemMessageTokens,
        agentDefinitions,
        availableSkills,
      } = await buildStreamSystemContext({
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
        mcpServers,
      });

      // Load project secrets (system workspace never gets secrets injected)
      const projectSecrets =
        workspaceId === MUX_HELP_CHAT_WORKSPACE_ID
          ? []
          : this.config.getEffectiveSecrets(metadata.projectPath);

      // Generate stream token and create temp directory for tools
      const streamToken = this.streamManager.generateStreamToken();

      let mcpTools: Record<string, Tool> | undefined;
      let mcpStats: MCPWorkspaceStats | undefined;
      let mcpSetupDurationMs = 0;

      if (this.mcpServerManager && workspaceId !== MUX_HELP_CHAT_WORKSPACE_ID) {
        const start = Date.now();
        try {
          const result = await this.mcpServerManager.getToolsForWorkspace({
            workspaceId,
            projectPath: metadata.projectPath,
            runtime,
            workspacePath,
            overrides: mcpOverrides,
            projectSecrets: secretsToRecord(projectSecrets),
          });

          mcpTools = result.tools;
          mcpStats = result.stats;
        } catch (error) {
          workspaceLog.error("Failed to start MCP servers", { error });
        } finally {
          mcpSetupDurationMs = Date.now() - start;
        }
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
          secrets: secretsToRecord(projectSecrets),
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
          // Only child workspaces (tasks) can report to a parent.
          enableAgentReport: Boolean(metadata.parentWorkspaceId),
          // External edit detection callback
          recordFileState,
          taskService: this.taskService,
          // PTC experiments for inheritance to subagents
          experiments,
          // Dynamic context for tool descriptions (moved from system prompt for better model attention)
          availableSubagents: agentDefinitions,
          availableSkills,
        },
        workspaceId,
        this.initStateManager,
        toolInstructions,
        mcpTools
      );

      // Merge in extra tools (e.g., CLI-specific tools like set_exit_code)
      // These bypass policy filtering since they're injected by the runtime, not user config
      const allToolsWithExtra = this.extraTools ? { ...allTools, ...this.extraTools } : allTools;

      // NOTE: effectiveToolPolicy is derived from the selected agent definition (plus hard-denies).

      // Apply tool policy FIRST - this must happen before PTC to ensure sandbox
      // respects allow/deny filters. The policy-filtered tools are passed to
      // ToolBridge so the mux.* API only exposes policy-allowed tools.
      const policyFilteredTools = applyToolPolicy(allToolsWithExtra, effectiveToolPolicy);

      // Handle PTC experiments - add or replace tools with code_execution
      let toolsForModel = policyFilteredTools;
      if (experiments?.programmaticToolCalling || experiments?.programmaticToolCallingExclusive) {
        try {
          // Lazy-load PTC modules only when experiments are enabled
          const ptc = await getPTCModules();

          // Create emit callback that forwards nested events to stream
          // Only forward tool-call-start/end events, not console events
          const emitNestedEvent = (event: PTCEventWithParent): void => {
            if (event.type === "tool-call-start" || event.type === "tool-call-end") {
              this.streamManager.emitNestedToolEvent(workspaceId, assistantMessageId, event);
            }
            // Console events are not streamed (appear in final result only)
          };

          // ToolBridge uses policy-filtered tools - sandbox only exposes allowed tools
          const toolBridge = new ptc.ToolBridge(policyFilteredTools);

          // Singleton runtime factory (WASM module is expensive to load)
          ptc.runtimeFactory ??= new ptc.QuickJSRuntimeFactory();

          const codeExecutionTool = await ptc.createCodeExecutionTool(
            ptc.runtimeFactory,
            toolBridge,
            emitNestedEvent
          );

          if (experiments?.programmaticToolCallingExclusive) {
            // Exclusive mode: code_execution is mandatory — it's the only way to use bridged
            // tools. The experiment flag is the opt-in; policy cannot disable it here since
            // that would leave no way to access tools. nonBridgeable is already policy-filtered.
            const nonBridgeable = toolBridge.getNonBridgeableTools();
            toolsForModel = { ...nonBridgeable, code_execution: codeExecutionTool };
          } else {
            // Supplement mode: add code_execution, then apply policy to determine final set.
            // This correctly handles all policy combinations (require, enable, disable).
            toolsForModel = applyToolPolicy(
              { ...policyFilteredTools, code_execution: codeExecutionTool },
              effectiveToolPolicy
            );
          }
        } catch (error) {
          // Fall back to policy-filtered tools if PTC creation fails
          log.error("Failed to create code_execution tool, falling back to base tools", { error });
        }
      }

      const tools = toolsForModel;

      const effectiveMcpStats: MCPWorkspaceStats =
        mcpStats ??
        ({
          enabledServerCount: 0,
          startedServerCount: 0,
          failedServerCount: 0,
          autoFallbackCount: 0,
          hasStdio: false,
          hasHttp: false,
          hasSse: false,
          transportMode: "none",
        } satisfies MCPWorkspaceStats);

      const mcpToolNames = new Set(Object.keys(mcpTools ?? {}));
      const toolNames = Object.keys(tools);
      const mcpToolCount = toolNames.filter((name) => mcpToolNames.has(name)).length;
      const totalToolCount = toolNames.length;
      const builtinToolCount = Math.max(0, totalToolCount - mcpToolCount);

      this.telemetryService?.capture({
        event: "mcp_context_injected",
        properties: {
          workspaceId,
          model: modelString,
          agentId: effectiveAgentId,
          runtimeType: getRuntimeTypeForTelemetry(metadata.runtimeConfig),

          mcp_server_enabled_count: effectiveMcpStats.enabledServerCount,
          mcp_server_started_count: effectiveMcpStats.startedServerCount,
          mcp_server_failed_count: effectiveMcpStats.failedServerCount,

          mcp_tool_count: mcpToolCount,
          total_tool_count: totalToolCount,
          builtin_tool_count: builtinToolCount,

          mcp_transport_mode: effectiveMcpStats.transportMode,
          mcp_has_http: effectiveMcpStats.hasHttp,
          mcp_has_sse: effectiveMcpStats.hasSse,
          mcp_has_stdio: effectiveMcpStats.hasStdio,
          mcp_auto_fallback_count: effectiveMcpStats.autoFallbackCount,
          mcp_setup_duration_ms_b2: roundToBase2(mcpSetupDurationMs),
        },
      });

      log.info("AIService.streamMessage: tool configuration", {
        workspaceId,
        model: modelString,
        toolNames: Object.keys(tools),
        hasToolPolicy: Boolean(effectiveToolPolicy),
      });

      // Create assistant message placeholder with historySequence from backend

      if (combinedAbortSignal.aborted) {
        return Ok(undefined);
      }
      const assistantMessageId = createAssistantMessageId();
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

      const forceContextLimitError =
        modelString.startsWith("openai:") &&
        effectiveMuxProviderOptions.openai?.forceContextLimitError === true;
      const simulateToolPolicyNoop =
        modelString.startsWith("openai:") &&
        effectiveMuxProviderOptions.openai?.simulateToolPolicyNoop === true;

      if (forceContextLimitError) {
        const errorMessage =
          "Context length exceeded: the conversation is too long to send to this OpenAI model. Please shorten the history and try again.";

        const errorPartialMessage: MuxMessage = {
          id: assistantMessageId,
          role: "assistant",
          metadata: {
            historySequence,
            timestamp: Date.now(),
            model: canonicalModelString,
            routedThroughGateway,
            systemMessageTokens,
            agentId: effectiveAgentId,
            thinkingLevel: effectiveThinkingLevel,
            partial: true,
            error: errorMessage,
            errorType: "context_exceeded",
          },
          parts: [],
        };

        await this.partialService.writePartial(workspaceId, errorPartialMessage);

        const streamStartEvent: StreamStartEvent = {
          type: "stream-start",
          workspaceId,
          messageId: assistantMessageId,
          model: canonicalModelString,
          routedThroughGateway,
          historySequence,
          startTime: Date.now(),
          agentId: effectiveAgentId,
          mode: effectiveMode,
          thinkingLevel: effectiveThinkingLevel,
        };
        this.emit("stream-start", streamStartEvent);

        this.emit(
          "error",
          createErrorEvent(workspaceId, {
            messageId: assistantMessageId,
            error: errorMessage,
            errorType: "context_exceeded",
          })
        );

        return Ok(undefined);
      }

      if (simulateToolPolicyNoop) {
        const noopMessage = createMuxMessage(assistantMessageId, "assistant", "", {
          timestamp: Date.now(),
          model: canonicalModelString,
          routedThroughGateway,
          systemMessageTokens,
          agentId: effectiveAgentId,
          thinkingLevel: effectiveThinkingLevel,
          toolPolicy: effectiveToolPolicy,
        });

        const parts: StreamEndEvent["parts"] = [
          {
            type: "text",
            text: "Tool execution skipped because the requested tool is disabled by policy.",
          },
        ];

        const streamStartEvent: StreamStartEvent = {
          type: "stream-start",
          workspaceId,
          messageId: assistantMessageId,
          model: canonicalModelString,
          routedThroughGateway,
          historySequence,
          startTime: Date.now(),
          agentId: effectiveAgentId,
          mode: effectiveMode,
          thinkingLevel: effectiveThinkingLevel,
        };
        this.emit("stream-start", streamStartEvent);

        const textParts = parts.filter((part): part is MuxTextPart => part.type === "text");
        if (textParts.length === 0) {
          throw new Error("simulateToolPolicyNoop requires at least one text part");
        }

        for (const textPart of textParts) {
          if (textPart.text.length === 0) {
            continue;
          }

          const streamDeltaEvent: StreamDeltaEvent = {
            type: "stream-delta",
            workspaceId,
            messageId: assistantMessageId,
            delta: textPart.text,
            tokens: 0, // Mock scenario - actual tokenization happens in streamManager
            timestamp: Date.now(),
          };
          this.emit("stream-delta", streamDeltaEvent);
        }

        const streamEndEvent: StreamEndEvent = {
          type: "stream-end",
          workspaceId,
          messageId: assistantMessageId,
          metadata: {
            model: canonicalModelString,
            thinkingLevel: effectiveThinkingLevel,
            routedThroughGateway,
            systemMessageTokens,
          },
          parts,
        };
        this.emit("stream-end", streamEndEvent);

        const finalAssistantMessage: MuxMessage = {
          ...noopMessage,
          metadata: {
            ...noopMessage.metadata,
            historySequence,
          },
          parts,
        };

        await this.partialService.deletePartial(workspaceId);
        await this.historyService.updateHistory(workspaceId, finalAssistantMessage);
        return Ok(undefined);
      }

      // Build provider options based on thinking level and message history
      const truncationMode = openaiTruncationModeOverride;
      // Pass filtered messages so OpenAI can extract previousResponseId for persistence
      // Also pass callback to filter out lost responseIds (OpenAI invalidated them)
      // Pass workspaceId to derive stable promptCacheKey for OpenAI caching
      const providerOptions = buildProviderOptions(
        modelString,
        effectiveThinkingLevel,
        filteredMessages,
        (id) => this.streamManager.isResponseIdLost(id),
        effectiveMuxProviderOptions,
        workspaceId,
        truncationMode
      );

      // Debug dump: Log the complete LLM request when MUX_DEBUG_LLM_REQUEST is set
      // This helps diagnose issues with system prompts, messages, tools, etc.
      if (process.env.MUX_DEBUG_LLM_REQUEST === "1") {
        const llmRequest = {
          workspaceId,
          model: modelString,
          systemMessage,
          messages: finalMessages,
          tools: Object.fromEntries(
            Object.entries(tools).map(([name, tool]) => [
              name,
              {
                description: tool.description,
                inputSchema: tool.inputSchema,
              },
            ])
          ),
          providerOptions,
          thinkingLevel: effectiveThinkingLevel,
          maxOutputTokens,
          mode: effectiveMode,
          agentId: effectiveAgentId,
          toolPolicy: effectiveToolPolicy,
        };
        log.info(
          `[MUX_DEBUG_LLM_REQUEST] Full LLM request:\n${JSON.stringify(llmRequest, null, 2)}`
        );
      }

      if (combinedAbortSignal.aborted) {
        const deleteResult = await this.historyService.deleteMessage(
          workspaceId,
          assistantMessageId
        );
        if (!deleteResult.success) {
          log.error(
            `Failed to delete aborted assistant placeholder (${assistantMessageId}): ${deleteResult.error}`
          );
        }
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
        const cloned =
          typeof structuredClone === "function"
            ? structuredClone(snapshot)
            : (JSON.parse(JSON.stringify(snapshot)) as DebugLlmRequestSnapshot);

        this.lastLlmRequestByWorkspace.set(workspaceId, cloned);
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
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
              primaryModel: modelResult.data,
              muxProviderOptions: effectiveMuxProviderOptions,
              workspaceId,
              effectiveMode,
              planFilePath,
              taskSettings,
              runtimeTempDir,
              runtime,
              agentDiscoveryPath,
              resolveGatewayModelString: (ms, dm, eg) =>
                this.providerModelFactory.resolveGatewayModelString(ms, dm, eg),
              createModel: (ms, o) => this.createModel(ms, o),
              emitBashOutput: (ev) => this.emit("bash-output", ev),
            })
          : tools;

      const streamResult = await this.streamManager.startStream(
        workspaceId,
        finalMessages,
        modelResult.data,
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
          ...(modelCostsIncluded(modelResult.data) ? { costsIncluded: true } : {}),
        },
        providerOptions,
        maxOutputTokens,
        effectiveToolPolicy,
        streamToken, // Pass the pre-generated stream token
        hasQueuedMessage,
        metadata.name,
        effectiveThinkingLevel
      );

      if (!streamResult.success) {
        // StreamManager already returns SendMessageError
        return Err(streamResult.error);
      }

      // If we were interrupted during StreamManager startup before the stream was registered,
      // make sure we don't leave an empty assistant placeholder behind.
      if (combinedAbortSignal.aborted && !this.streamManager.isStreaming(workspaceId)) {
        const deleteResult = await this.historyService.deleteMessage(
          workspaceId,
          assistantMessageId
        );
        if (!deleteResult.success) {
          log.error(
            `Failed to delete aborted assistant placeholder (${assistantMessageId}): ${deleteResult.error}`
          );
        }
      }

      // StreamManager now handles history updates directly on stream-end
      // No need for event listener here
      return Ok(undefined);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
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
  async replayStream(workspaceId: string): Promise<void> {
    if (this.mockModeEnabled && this.mockAiStreamPlayer) {
      await this.mockAiStreamPlayer.replayStream(workspaceId);
      return;
    }
    await this.streamManager.replayStream(workspaceId);
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
      const message = error instanceof Error ? error.message : String(error);
      return Err(`Failed to delete workspace: ${message}`);
    }
  }
}
