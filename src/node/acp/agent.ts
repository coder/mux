import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type {
  Agent,
  AgentSideConnection,
  AuthenticateRequest,
  AuthenticateResponse,
  CancelNotification,
  ContentBlock,
  ForkSessionRequest,
  ForkSessionResponse,
  InitializeRequest,
  InitializeResponse,
  ListSessionsRequest,
  ListSessionsResponse,
  LoadSessionRequest,
  LoadSessionResponse,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  ResumeSessionRequest,
  ResumeSessionResponse,
  SetSessionConfigOptionRequest,
  SetSessionConfigOptionResponse,
  Usage,
} from "@agentclientprotocol/sdk";
import {
  DEFAULT_COMPACTION_WORD_TARGET,
  WORDS_TO_TOKENS_RATIO,
  buildCompactionPrompt,
} from "@/common/constants/ui";
import { RuntimeConfigSchema } from "@/common/orpc/schemas";
import type { OnChatMode, SendMessageOptions, WorkspaceChatMessage } from "@/common/orpc/types";
import type { AgentSkillDescriptor } from "@/common/types/agentSkill";
import type { CompactionRequestData } from "@/common/types/message";
import { buildAgentSkillMetadata } from "@/common/types/message";
import { isWorktreeRuntime, type RuntimeConfig, type RuntimeMode } from "@/common/types/runtime";
import { negotiateCapabilities, type NegotiatedCapabilities } from "./capabilities";
import { AGENT_MODE_CONFIG_ID, buildConfigOptions, handleSetConfigOption } from "./configOptions";
import { forkSessionFromWorkspace } from "./experimental/sessionFork";
import { loadSessionFromWorkspace } from "./experimental/sessionResume";
import { convertToAcpUsage } from "./experimental/sessionUsage";
import { resolveAgentAiSettings, type ResolvedAiSettings } from "./resolveAgentAiSettings";
import type { ServerConnection } from "./serverConnection";
import { SessionManager } from "./sessionManager";
import {
  buildAcpAvailableCommands,
  mapSkillsByName,
  parseAcpSlashCommand,
  type ParsedAcpSlashCommand,
} from "./slashCommands";
import { StreamTranslator } from "./streamTranslator";
import { ToolRouter } from "./toolRouter";

const DEFAULT_AGENT_ID = "exec";
const DEFAULT_BRANCH_PREFIX = "acp";
const DEFAULT_TRUNK_BRANCH = "main";
const DEFAULT_COMMAND_STOP_REASON: PromptResponse["stopReason"] = "end_turn";
const ON_CHAT_MODE_FULL: OnChatMode = { type: "full" };
const ON_CHAT_MODE_LIVE: OnChatMode = { type: "live" };
const SESSION_LIST_PAGE_SIZE = 100;

const ACP_PROMPT_CORRELATION_MUX_METADATA_KEY = "acpPromptId";
const ACP_DELEGATED_TOOLS_MUX_METADATA_KEY = "acpDelegatedTools";
const ACP_DELEGATION_CANDIDATE_TOOLS = [
  "file_read",
  "file_write",
  "file_edit_replace_string",
  "file_edit_insert",
  "bash",
] as const;
const DEFAULT_DISCONNECT_CLEANUP_MAX_WAIT_MS = 10_000;

interface MuxAgentOptions {
  disconnectCleanupMaxWaitMs?: number;
}

interface SessionState {
  workspaceId: string;
  runtimeMode: RuntimeMode;
  agentId: string;
  aiSettings: ResolvedAiSettings;
}

interface NewSessionWorkspaceLifecycle {
  hasPromptActivity: boolean;
}

interface TurnResult {
  stopReason: PromptResponse["stopReason"];
  usage?: Usage;
}

interface TurnCompletion {
  resolve: (result: TurnResult) => void;
  reject: (error: Error) => void;
  /** Stable per-prompt correlation id injected into send options and stream events. */
  promptCorrelationId: string;
  /** Set after stream-start; only this message id may resolve/reject the turn. */
  messageId?: string;
}

interface ParsedMuxMeta {
  projectPath?: string;
  branchName?: string;
  trunkBranch?: string;
  title?: string;
  runtimeConfig?: RuntimeConfig;
  agentId?: string;
  forkName?: string;
}

type MetaRecord = Record<string, unknown>;

type WorkspaceInfo = NonNullable<
  Awaited<ReturnType<ServerConnection["client"]["workspace"]["getInfo"]>>
>;
type WorkspaceActivityById = Awaited<
  ReturnType<ServerConnection["client"]["workspace"]["activity"]["list"]>
>;

export class MuxAgent implements Agent {
  private readonly sessionManager = new SessionManager();
  private readonly streamTranslator: StreamTranslator;
  private readonly toolRouter: ToolRouter;

  private negotiatedCapabilities: NegotiatedCapabilities | null = null;
  private initialized = false;

  private readonly sessionStateById = new Map<string, SessionState>();
  /**
   * Tracks workspaces created by ACP session/new so disconnect cleanup can remove
   * untouched placeholders (no prompts/messages sent).
   */
  private readonly newSessionWorkspaceLifecycleById = new Map<
    string,
    NewSessionWorkspaceLifecycle
  >();
  private readonly sessionSkillsById = new Map<string, Map<string, AgentSkillDescriptor>>();
  /**
   * Persist each session's desired onChat mode so prompt() can recover dropped
   * subscriptions without changing replay semantics (full vs live).
   */
  private readonly onChatModeBySessionId = new Map<string, OnChatMode>();
  private readonly chatSubscriptions = new Map<string, Promise<void>>();
  /** Resolves once `onChat` is connected for a session (shared across callers). */
  private readonly chatSubscriptionReady = new Map<string, Promise<void>>();
  private readonly turnCompletions = new Map<string, TurnCompletion>();
  private readonly latestUsageBySessionId = new Map<string, Usage>();
  private inFlightNewSessionCount = 0;
  private disconnectCleanupPromise: Promise<void> | null = null;
  private readonly disconnectCleanupMaxWaitMs: number;

  constructor(
    private readonly connection: AgentSideConnection,
    private readonly server: ServerConnection,
    options?: MuxAgentOptions
  ) {
    assert(connection != null, "MuxAgent: connection is required");
    assert(server != null, "MuxAgent: server connection is required");

    const configuredDisconnectCleanupMaxWaitMs = options?.disconnectCleanupMaxWaitMs;
    assert(
      configuredDisconnectCleanupMaxWaitMs == null ||
        (Number.isFinite(configuredDisconnectCleanupMaxWaitMs) &&
          configuredDisconnectCleanupMaxWaitMs >= 0),
      "MuxAgent: disconnectCleanupMaxWaitMs must be a finite non-negative number"
    );
    this.disconnectCleanupMaxWaitMs =
      configuredDisconnectCleanupMaxWaitMs ?? DEFAULT_DISCONNECT_CLEANUP_MAX_WAIT_MS;

    this.streamTranslator = new StreamTranslator(connection);
    this.toolRouter = new ToolRouter(connection);
  }

  initialize(params: InitializeRequest): Promise<InitializeResponse> {
    // The ACP SDK invokes the agent factory during AgentSideConnection
    // construction, before connection.signal is available. Defer installing
    // the abort listener until initialize() runs after construction completes.
    this.connection.signal.addEventListener(
      "abort",
      () => {
        const disconnectError = new Error("Mux ACP connection closed");
        const activeTurnSessionIds = [...this.turnCompletions.keys()];
        for (const sessionId of activeTurnSessionIds) {
          this.rejectTurn(sessionId, disconnectError);
        }

        const interruptPromise = this.interruptActiveTurnStreamsOnDisconnect(activeTurnSessionIds);
        const cleanupPromise = this.cleanupNewSessionWorkspacesOnDisconnect();

        this.disconnectCleanupPromise = Promise.all([interruptPromise, cleanupPromise])
          .then(() => undefined)
          .catch((cleanupError) => {
            console.error("[acp] Failed during disconnect workspace cleanup", cleanupError);
          });
      },
      { once: true }
    );

    assert(params != null, "initialize: params are required");

    const negotiated = negotiateCapabilities(params.clientCapabilities);
    this.negotiatedCapabilities = negotiated;
    this.toolRouter.setEditorCapabilities(negotiated);
    this.initialized = true;

    return Promise.resolve({
      protocolVersion: params.protocolVersion,
      agentInfo: {
        name: "mux",
        version: process.env.MUX_VERSION ?? "dev",
      },
      agentCapabilities: {
        loadSession: true,
        sessionCapabilities: {
          fork: {},
          list: {},
          resume: {},
        },
      },
    });
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    this.assertInitialized("newSession");

    this.inFlightNewSessionCount += 1;
    try {
      const meta = parseMuxMeta(params._meta);
      const projectPath = meta.projectPath ?? params.cwd.trim();
      assert(projectPath.length > 0, "newSession: projectPath/cwd must be non-empty");

      // When the ACP client doesn't supply a trunk branch (typical — editors only
      // send `cwd`, not mux-specific `_meta`), derive it from the project's git
      // repo.  Worktree/SSH runtimes require a trunk branch for workspace creation.
      let trunkBranch = meta.trunkBranch;
      if (trunkBranch == null || trunkBranch.trim().length === 0) {
        const branchInfo = await this.server.client.projects.listBranches({ projectPath });
        trunkBranch = branchInfo.recommendedTrunk ?? DEFAULT_TRUNK_BRANCH;
      }

      const createResult = await this.server.client.workspace.create({
        projectPath,
        branchName: meta.branchName ?? generateDefaultBranchName(),
        trunkBranch,
        title: meta.title,
        runtimeConfig: meta.runtimeConfig,
      });

      if (!createResult.success) {
        throw new Error(`newSession: workspace.create failed: ${createResult.error}`);
      }

      const workspace = createResult.metadata;
      const sessionId = workspace.id;
      const workspaceId = workspace.id;
      this.newSessionWorkspaceLifecycleById.set(workspaceId, {
        hasPromptActivity: false,
      });

      const runtimeMode = runtimeModeFromConfig(workspace.runtimeConfig);

      this.sessionManager.registerSession(
        sessionId,
        workspaceId,
        runtimeMode,
        this.negotiatedCapabilities ?? undefined
      );

      this.toolRouter.registerSession(sessionId, runtimeMode);

      const agentId = meta.agentId ?? workspace.agentId ?? DEFAULT_AGENT_ID;
      const aiSettings = await resolveAgentAiSettings(this.server.client, agentId, workspaceId);
      await this.persistAiSettings(workspaceId, agentId, aiSettings);

      this.sessionStateById.set(sessionId, {
        workspaceId,
        runtimeMode,
        agentId,
        aiSettings,
      });

      await this.ensureChatSubscription(sessionId, workspaceId, ON_CHAT_MODE_FULL);

      const response = {
        sessionId,
        configOptions: await buildConfigOptions(this.server.client, workspaceId, {
          activeAgentId: agentId,
        }),
      };

      this.scheduleSessionCommandsRefresh(sessionId, workspaceId);

      return response;
    } finally {
      this.inFlightNewSessionCount -= 1;
      assert(
        this.inFlightNewSessionCount >= 0,
        "newSession: inFlightNewSessionCount should never be negative"
      );
    }
  }

  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    this.assertInitialized("loadSession");

    // Pass any prior in-memory agent selection so mode switches survive
    // reconnect/reload (agent mode set via set_config_option is only stored
    // in ACP session state, not persisted as the workspace's active agent).
    const existingState = this.sessionStateById.get(params.sessionId);
    const resumed = await loadSessionFromWorkspace(params, {
      server: this.server,
      sessionManager: this.sessionManager,
      negotiatedCapabilities: this.negotiatedCapabilities,
      defaultAgentId: DEFAULT_AGENT_ID,
      existingSessionAgentId: existingState?.agentId,
    });

    this.sessionStateById.set(resumed.sessionId, {
      workspaceId: resumed.workspaceId,
      runtimeMode: resumed.runtimeMode,
      agentId: resumed.agentId,
      aiSettings: resumed.aiSettings,
    });

    this.toolRouter.registerSession(resumed.sessionId, resumed.runtimeMode);

    await this.ensureChatSubscription(resumed.sessionId, resumed.workspaceId, ON_CHAT_MODE_FULL);

    this.scheduleSessionCommandsRefresh(resumed.sessionId, resumed.workspaceId);

    return resumed.response;
  }

  async unstable_listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse> {
    this.assertInitialized("unstable_listSessions");
    assert(params != null, "unstable_listSessions: params are required");

    const normalizedCwd = normalizeOptionalPath(params.cwd);
    const offset = parseSessionListCursor(params.cursor);

    const [activeWorkspaces, archivedWorkspaces, workspaceActivity] = await Promise.all([
      this.server.client.workspace.list({ archived: false }),
      this.server.client.workspace.list({ archived: true }),
      this.server.client.workspace.activity.list(),
    ]);

    const allWorkspaces = dedupeWorkspacesById([...activeWorkspaces, ...archivedWorkspaces]);
    const filteredWorkspaces =
      normalizedCwd != null
        ? allWorkspaces.filter((workspace) => workspaceMatchesCwd(workspace, normalizedCwd))
        : allWorkspaces;

    const sortedWorkspaces = [...filteredWorkspaces].sort((left, right) =>
      compareSessionRecency(left, right, workspaceActivity)
    );

    const page = sortedWorkspaces.slice(offset, offset + SESSION_LIST_PAGE_SIZE);
    const nextOffset = offset + page.length;

    return {
      sessions: page.map((workspace) => ({
        sessionId: workspace.id,
        // Surface projectPath as cwd so session/list filtering matches editor cwd.
        cwd: workspace.projectPath,
        title: workspace.title ?? workspace.name,
        updatedAt: toSessionUpdatedAt(workspace, workspaceActivity),
      })),
      nextCursor: nextOffset < sortedWorkspaces.length ? String(nextOffset) : undefined,
    };
  }

  async unstable_resumeSession(params: ResumeSessionRequest): Promise<ResumeSessionResponse> {
    this.assertInitialized("unstable_resumeSession");

    const sessionId = params.sessionId.trim();
    assert(sessionId.length > 0, "unstable_resumeSession: sessionId must be non-empty");

    const cwd = params.cwd.trim();
    assert(cwd.length > 0, "unstable_resumeSession: cwd must be non-empty");

    const existingState = this.sessionStateById.get(sessionId);
    const resumed = await loadSessionFromWorkspace(
      {
        sessionId,
        cwd,
        mcpServers: params.mcpServers ?? [],
        _meta: params._meta,
      },
      {
        server: this.server,
        sessionManager: this.sessionManager,
        negotiatedCapabilities: this.negotiatedCapabilities,
        defaultAgentId: DEFAULT_AGENT_ID,
        existingSessionAgentId: existingState?.agentId,
      }
    );

    this.sessionStateById.set(resumed.sessionId, {
      workspaceId: resumed.workspaceId,
      runtimeMode: resumed.runtimeMode,
      agentId: resumed.agentId,
      aiSettings: resumed.aiSettings,
    });

    this.toolRouter.registerSession(resumed.sessionId, resumed.runtimeMode);

    // ACP resume semantics require "continue from now" without replaying prior
    // transcript. Use onChat live mode (new backend capability) to follow only
    // active/future stream events.
    await this.ensureChatSubscription(resumed.sessionId, resumed.workspaceId, ON_CHAT_MODE_LIVE);

    this.scheduleSessionCommandsRefresh(resumed.sessionId, resumed.workspaceId);

    return resumed.response;
  }

  async unstable_forkSession(params: ForkSessionRequest): Promise<ForkSessionResponse> {
    this.assertInitialized("unstable_forkSession");

    const meta = parseMuxMeta(params._meta);
    // Pass the source session's active agent so forks inherit mode switches
    const sourceSessionState = this.sessionStateById.get(params.sessionId);
    const forked = await forkSessionFromWorkspace(
      params,
      {
        server: this.server,
        sessionManager: this.sessionManager,
        negotiatedCapabilities: this.negotiatedCapabilities,
        defaultAgentId: DEFAULT_AGENT_ID,
        sourceSessionAgentId: sourceSessionState?.agentId,
      },
      meta.forkName
    );

    await this.persistAiSettings(forked.workspaceId, forked.agentId, forked.aiSettings);

    this.sessionStateById.set(forked.sessionId, {
      workspaceId: forked.workspaceId,
      runtimeMode: forked.runtimeMode,
      agentId: forked.agentId,
      aiSettings: forked.aiSettings,
    });

    this.toolRouter.registerSession(forked.sessionId, forked.runtimeMode);

    await this.ensureChatSubscription(forked.sessionId, forked.workspaceId, ON_CHAT_MODE_FULL);

    this.scheduleSessionCommandsRefresh(forked.sessionId, forked.workspaceId);

    return forked.response;
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    this.assertInitialized("prompt");

    const sessionId = params.sessionId.trim();
    assert(sessionId.length > 0, "prompt: sessionId must be non-empty");

    const workspaceId = this.sessionManager.getWorkspaceId(sessionId);
    const sessionState = await this.refreshSessionState(sessionId);
    const parsedPrompt = parsePromptBlocks(params.prompt);

    const slashCommandResponse = await this.tryHandleSlashCommand(
      sessionId,
      workspaceId,
      sessionState,
      parsedPrompt
    );
    if (slashCommandResponse != null) {
      return slashCommandResponse;
    }

    return this.sendWorkspaceMessageAndAwaitTurn({
      sessionId,
      workspaceId,
      message: parsedPrompt.text,
      options: {
        model: sessionState.aiSettings.model,
        thinkingLevel: sessionState.aiSettings.thinkingLevel,
        agentId: sessionState.agentId,
      },
      fileParts: parsedPrompt.fileParts,
    });
  }

  async cancel(params: CancelNotification): Promise<void> {
    this.assertInitialized("cancel");

    const sessionId = params.sessionId.trim();
    assert(sessionId.length > 0, "cancel: sessionId must be non-empty");

    const workspaceId = this.sessionManager.getWorkspaceId(sessionId);
    const interruptResult = await this.server.client.workspace.interruptStream({ workspaceId });

    if (!interruptResult.success) {
      throw new Error(`cancel: workspace.interruptStream failed: ${interruptResult.error}`);
    }
  }

  async setSessionConfigOption(
    params: SetSessionConfigOptionRequest
  ): Promise<SetSessionConfigOptionResponse> {
    this.assertInitialized("setSessionConfigOption");

    const sessionId = params.sessionId.trim();
    assert(sessionId.length > 0, "setSessionConfigOption: sessionId must be non-empty");

    const workspaceId = this.sessionManager.getWorkspaceId(sessionId);
    const trimmedConfigId = params.configId.trim();
    assert(trimmedConfigId.length > 0, "setSessionConfigOption: configId must be non-empty");

    const activeAgentId = this.sessionStateById.get(sessionId)?.agentId;
    const configOptions = await handleSetConfigOption(
      this.server.client,
      workspaceId,
      params.configId,
      params.value,
      {
        activeAgentId,
        onAgentModeChanged: (agentId, aiSettings) => {
          this.updateSessionAgentState(sessionId, agentId, aiSettings);
        },
      }
    );

    if (trimmedConfigId !== AGENT_MODE_CONFIG_ID) {
      await this.refreshSessionState(sessionId);
    }

    return { configOptions };
  }

  authenticate(_params: AuthenticateRequest): Promise<AuthenticateResponse> {
    this.assertInitialized("authenticate");

    // Local mux server connections do not currently require ACP-level auth.
    return Promise.resolve({});
  }

  private async sendWorkspaceMessageAndAwaitTurn(args: {
    sessionId: string;
    workspaceId: string;
    message: string;
    options: SendMessageOptions;
    fileParts?: Array<{ url: string; mediaType: string }>;
  }): Promise<PromptResponse> {
    assert(
      args.sessionId.trim().length > 0,
      "sendWorkspaceMessageAndAwaitTurn: sessionId required"
    );
    assert(
      args.workspaceId.trim().length > 0,
      "sendWorkspaceMessageAndAwaitTurn: workspaceId required"
    );
    assert(args.message.trim().length > 0, "sendWorkspaceMessageAndAwaitTurn: message required");

    this.markNewSessionWorkspacePromptActivity(args.workspaceId);

    const promptCorrelationId = randomUUID();
    const turnPromise = this.beginTurn(args.sessionId, promptCorrelationId);

    // Attach a sink immediately so early stream failures cannot produce
    // unhandled rejections before this method awaits turnPromise.
    void turnPromise.catch(() => undefined);

    try {
      // Re-establish chat subscription if a prior one dropped (e.g., transient
      // websocket interruption). Register the turn first so subscription
      // failures can reject it instead of leaving prompt() hanging.
      await this.ensureChatSubscription(
        args.sessionId,
        args.workspaceId,
        this.getSessionOnChatMode(args.sessionId)
      );

      const delegatedToolNames = this.getDelegatedToolNames(args.sessionId);
      const optionsWithPromptCorrelation = this.attachPromptCorrelationToSendOptions(
        args.options,
        promptCorrelationId,
        delegatedToolNames
      );

      const sendResult = await this.server.client.workspace.sendMessage({
        workspaceId: args.workspaceId,
        message: args.message,
        options: {
          ...optionsWithPromptCorrelation,
          fileParts:
            args.fileParts != null && args.fileParts.length > 0 ? args.fileParts : undefined,
        },
      });

      if (!sendResult.success) {
        throw new Error(
          `prompt: workspace.sendMessage failed: ${stringifyUnknown(sendResult.error)}`
        );
      }

      const turn = await turnPromise;
      const usage = turn.usage ?? this.latestUsageBySessionId.get(args.sessionId);
      this.latestUsageBySessionId.delete(args.sessionId);

      return {
        stopReason: turn.stopReason,
        usage,
      };
    } catch (error) {
      // workspace.sendMessage / subscription failures can happen before stream
      // events settle the turn promise. Clear turn state before rethrowing.
      this.turnCompletions.delete(args.sessionId);
      throw error;
    }
  }

  private attachPromptCorrelationToSendOptions(
    options: SendMessageOptions,
    promptCorrelationId: string,
    delegatedToolNames: readonly string[]
  ): SendMessageOptions {
    assert(
      promptCorrelationId.trim().length > 0,
      "attachPromptCorrelationToSendOptions: promptCorrelationId must be non-empty"
    );

    const existingMuxMetadata = isRecord(options.muxMetadata) ? options.muxMetadata : {};
    const muxMetadata: Record<string, unknown> = {
      ...existingMuxMetadata,
      [ACP_PROMPT_CORRELATION_MUX_METADATA_KEY]: promptCorrelationId,
    };

    if (delegatedToolNames.length > 0) {
      muxMetadata[ACP_DELEGATED_TOOLS_MUX_METADATA_KEY] = [...delegatedToolNames];
    } else {
      delete muxMetadata[ACP_DELEGATED_TOOLS_MUX_METADATA_KEY];
    }

    return {
      ...options,
      muxMetadata,
    };
  }

  private getDelegatedToolNames(sessionId: string): string[] {
    const delegatedToolNames: string[] = [];

    for (const toolName of ACP_DELEGATION_CANDIDATE_TOOLS) {
      if (this.toolRouter.shouldDelegateToEditor(sessionId, toolName)) {
        delegatedToolNames.push(toolName);
      }
    }

    return delegatedToolNames;
  }
  private async tryHandleSlashCommand(
    sessionId: string,
    workspaceId: string,
    sessionState: SessionState,
    parsedPrompt: ParsedPrompt
  ): Promise<PromptResponse | null> {
    const trimmedPrompt = parsedPrompt.text.trim();
    if (!trimmedPrompt.startsWith("/")) {
      return null;
    }

    let skillsByName: ReadonlyMap<string, AgentSkillDescriptor>;
    try {
      skillsByName = await this.getSessionSkills(sessionId, workspaceId);
    } catch (error) {
      console.error("[acp] Failed to load skills for slash command parsing", error);
      // Built-in ACP slash commands (/clear, /truncate, /compact, etc.) should
      // still work when skill discovery has a transient failure.
      skillsByName = new Map<string, AgentSkillDescriptor>();
    }

    const parsedCommand = parseAcpSlashCommand(parsedPrompt.text, skillsByName);
    if (parsedCommand == null) {
      return null;
    }

    return this.handleSlashCommand(
      sessionId,
      workspaceId,
      sessionState,
      parsedPrompt,
      parsedCommand
    );
  }

  private async handleSlashCommand(
    sessionId: string,
    workspaceId: string,
    sessionState: SessionState,
    parsedPrompt: ParsedPrompt,
    parsedCommand: ParsedAcpSlashCommand
  ): Promise<PromptResponse> {
    switch (parsedCommand.kind) {
      case "invalid":
        return this.respondToCommand(sessionId, parsedCommand.message);

      case "clear": {
        const clearResult = await this.server.client.workspace.truncateHistory({
          workspaceId,
          percentage: 1.0,
        });
        if (!clearResult.success) {
          return this.respondToCommand(
            sessionId,
            `Failed to clear chat history: ${clearResult.error ?? "unknown error"}`
          );
        }

        return this.respondToCommand(sessionId, "Cleared chat history.");
      }

      case "truncate": {
        const truncateResult = await this.server.client.workspace.truncateHistory({
          workspaceId,
          percentage: parsedCommand.percentage,
        });
        if (!truncateResult.success) {
          return this.respondToCommand(
            sessionId,
            `Failed to truncate chat history: ${truncateResult.error ?? "unknown error"}`
          );
        }

        return this.respondToCommand(
          sessionId,
          `Truncated chat history by ${Math.round(parsedCommand.percentage * 100)}%.`
        );
      }

      case "compact": {
        const compactionPayload = this.buildCompactionPayload(
          parsedCommand,
          parsedPrompt,
          sessionState
        );

        return this.sendWorkspaceMessageAndAwaitTurn({
          sessionId,
          workspaceId,
          message: compactionPayload.message,
          options: compactionPayload.options,
        });
      }

      case "skill": {
        const options: SendMessageOptions = {
          model: sessionState.aiSettings.model,
          thinkingLevel: sessionState.aiSettings.thinkingLevel,
          agentId: sessionState.agentId,
          muxMetadata: buildAgentSkillMetadata({
            rawCommand: parsedCommand.rawCommand,
            commandPrefix: parsedCommand.commandPrefix,
            skillName: parsedCommand.descriptor.name,
            scope: parsedCommand.descriptor.scope,
          }),
        };

        return this.sendWorkspaceMessageAndAwaitTurn({
          sessionId,
          workspaceId,
          message: parsedCommand.formattedMessage,
          options,
          fileParts: parsedPrompt.fileParts,
        });
      }

      case "fork": {
        const forkResult = await this.server.client.workspace.fork({
          sourceWorkspaceId: workspaceId,
        });
        if (!forkResult.success) {
          return this.respondToCommand(
            sessionId,
            `Failed to fork workspace: ${forkResult.error ?? "unknown error"}`
          );
        }

        const newWorkspaceId = forkResult.metadata.id;
        let response = `Created forked workspace \`${newWorkspaceId}\`.`;

        if (parsedCommand.startMessage != null && parsedCommand.startMessage.trim().length > 0) {
          const startMessageResult = await this.server.client.workspace.sendMessage({
            workspaceId: newWorkspaceId,
            message: parsedCommand.startMessage,
            options: {
              model: sessionState.aiSettings.model,
              thinkingLevel: sessionState.aiSettings.thinkingLevel,
              agentId: sessionState.agentId,
            },
          });

          response += startMessageResult.success
            ? " Queued the optional start message in the forked workspace."
            : ` Could not queue the optional start message: ${stringifyUnknown(startMessageResult.error)}`;
        }

        return this.respondToCommand(sessionId, response);
      }

      case "new": {
        const workspaceInfo = await this.server.client.workspace.getInfo({ workspaceId });
        if (workspaceInfo == null) {
          return this.respondToCommand(
            sessionId,
            "Failed to create workspace: current workspace metadata is unavailable."
          );
        }

        let trunkBranch = parsedCommand.trunkBranch;
        if (trunkBranch == null || trunkBranch.trim().length === 0) {
          const branchInfo = await this.server.client.projects.listBranches({
            projectPath: workspaceInfo.projectPath,
          });
          trunkBranch = branchInfo.recommendedTrunk ?? DEFAULT_TRUNK_BRANCH;
        }

        const createResult = await this.server.client.workspace.create({
          projectPath: workspaceInfo.projectPath,
          branchName: parsedCommand.workspaceName,
          trunkBranch,
          runtimeConfig: parsedCommand.runtimeConfig,
        });

        if (!createResult.success) {
          return this.respondToCommand(
            sessionId,
            `Failed to create workspace: ${createResult.error ?? "unknown error"}`
          );
        }

        const newWorkspaceId = createResult.metadata.id;
        let response = `Created workspace \`${parsedCommand.workspaceName}\` (id: \`${newWorkspaceId}\`).`;

        if (parsedCommand.startMessage != null && parsedCommand.startMessage.trim().length > 0) {
          const startMessageResult = await this.server.client.workspace.sendMessage({
            workspaceId: newWorkspaceId,
            message: parsedCommand.startMessage,
            options: {
              model: sessionState.aiSettings.model,
              thinkingLevel: sessionState.aiSettings.thinkingLevel,
              agentId: sessionState.agentId,
            },
          });

          response += startMessageResult.success
            ? " Queued the optional start message in the new workspace."
            : ` Could not queue the optional start message: ${stringifyUnknown(startMessageResult.error)}`;
        }

        return this.respondToCommand(sessionId, response);
      }

      default:
        return this.respondToCommand(sessionId, "This slash command is not supported in ACP yet.");
    }
  }

  private buildCompactionPayload(
    command: Extract<ParsedAcpSlashCommand, { kind: "compact" }>,
    parsedPrompt: ParsedPrompt,
    sessionState: SessionState
  ): { message: string; options: SendMessageOptions } {
    const targetWords =
      command.maxOutputTokens != null
        ? Math.round(command.maxOutputTokens / WORDS_TO_TOKENS_RATIO)
        : DEFAULT_COMPACTION_WORD_TARGET;

    let message = buildCompactionPrompt(targetWords);

    const continueMessage = command.continueMessage?.trim() ?? "";
    if (continueMessage.length > 0) {
      message += `\n\nThe user wants to continue with: ${continueMessage}`;
    }

    const hasFollowUp = continueMessage.length > 0 || parsedPrompt.fileParts.length > 0;

    const followUpContent = hasFollowUp
      ? {
          text: continueMessage,
          fileParts: parsedPrompt.fileParts.length > 0 ? parsedPrompt.fileParts : undefined,
          model: sessionState.aiSettings.model,
          agentId: sessionState.agentId,
          thinkingLevel: sessionState.aiSettings.thinkingLevel,
        }
      : undefined;

    const compactionModel = command.model ?? sessionState.aiSettings.model;

    const compactData: CompactionRequestData = {
      model: compactionModel,
      maxOutputTokens: command.maxOutputTokens,
      followUpContent,
    };

    const toolPolicy: NonNullable<SendMessageOptions["toolPolicy"]> = [
      {
        regex_match: ".*",
        action: "disable",
      },
    ];

    const options: SendMessageOptions = {
      model: compactionModel,
      thinkingLevel: sessionState.aiSettings.thinkingLevel,
      agentId: "compact",
      maxOutputTokens: command.maxOutputTokens,
      skipAiSettingsPersistence: true,
      toolPolicy,
      muxMetadata: {
        type: "compaction-request",
        rawCommand: command.rawCommand,
        commandPrefix: "/compact",
        parsed: compactData,
        requestedModel: compactionModel,
      },
    };

    return {
      message,
      options,
    };
  }

  private async respondToCommand(sessionId: string, text: string): Promise<PromptResponse> {
    assert(sessionId.trim().length > 0, "respondToCommand: sessionId must be non-empty");
    assert(text.trim().length > 0, "respondToCommand: text must be non-empty");

    await this.connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text,
        },
      },
    });

    return {
      stopReason: DEFAULT_COMMAND_STOP_REASON,
    };
  }

  private markNewSessionWorkspacePromptActivity(workspaceId: string): void {
    const lifecycle = this.newSessionWorkspaceLifecycleById.get(workspaceId);
    if (lifecycle == null) {
      return;
    }

    lifecycle.hasPromptActivity = true;
  }

  private async interruptActiveTurnStreamsOnDisconnect(
    sessionIds: readonly string[]
  ): Promise<void> {
    for (const sessionId of sessionIds) {
      let workspaceId: string;
      try {
        workspaceId = this.sessionManager.getWorkspaceId(sessionId);
      } catch {
        continue;
      }

      try {
        await this.server.client.workspace.interruptStream({
          workspaceId,
          options: {
            abandonPartial: true,
          },
        });
      } catch (error) {
        console.error(
          `[acp] Failed to interrupt active stream for session ${sessionId} during disconnect`,
          error
        );
      }
    }
  }

  private async cleanupNewSessionWorkspacesOnDisconnect(): Promise<void> {
    const startedAt = Date.now();

    while (true) {
      const nextEntry = this.newSessionWorkspaceLifecycleById.entries().next();
      if (nextEntry.done) {
        // Disconnect can race in-flight session/new requests that haven't yet
        // registered their workspace lifecycle entry. Keep draining until all
        // in-flight creations settle so late registrations are still cleaned up.
        if (this.inFlightNewSessionCount === 0) {
          return;
        }

        const elapsedMs = Date.now() - startedAt;
        if (elapsedMs >= this.disconnectCleanupMaxWaitMs) {
          console.warn(
            `[acp] Timed out waiting for ${this.inFlightNewSessionCount} in-flight session/new request(s) during disconnect cleanup`
          );
          return;
        }

        await new Promise((resolve) => setTimeout(resolve, 0));
        continue;
      }

      const [workspaceId, lifecycle] = nextEntry.value;
      this.newSessionWorkspaceLifecycleById.delete(workspaceId);

      // If this ACP connection attempted any prompt in the workspace, keep it.
      // Users can intentionally prepare a workspace and disconnect mid-turn.
      if (lifecycle.hasPromptActivity) {
        continue;
      }

      try {
        const replay = await this.server.client.workspace.getFullReplay({ workspaceId });
        if (!isWorkspaceConversationEmpty(replay)) {
          continue;
        }

        const removeResult = await this.server.client.workspace.remove({
          workspaceId,
          options: { force: false },
        });
        if (!removeResult.success) {
          console.error(
            `[acp] Failed to remove untouched ACP workspace ${workspaceId} on disconnect: ${stringifyUnknown(removeResult.error)}`
          );
        }
      } catch (error) {
        console.error(
          `[acp] Failed to cleanup untouched ACP workspace ${workspaceId} on disconnect`,
          error
        );
      }
    }
  }

  private scheduleSessionCommandsRefresh(sessionId: string, workspaceId: string): void {
    // Some ACP clients (including Zed) can drop session/update notifications that
    // arrive before the corresponding session/new response is processed client-side.
    // Defer command advertisement to the next macrotask so the session is
    // established first, then publish available slash commands.
    setTimeout(() => {
      if (this.connection.signal.aborted) {
        return;
      }

      void this.refreshSessionCommands(sessionId, workspaceId);
    }, 0);
  }

  private async refreshSessionCommands(sessionId: string, workspaceId: string): Promise<void> {
    let advertisedSkills: AgentSkillDescriptor[];

    try {
      const skills = await this.server.client.agentSkills.list({ workspaceId });
      const skillsByName = mapSkillsByName(skills);
      this.sessionSkillsById.set(sessionId, skillsByName);
      advertisedSkills = skills;
    } catch (error) {
      // Command advertisement should not block session creation/loading.
      console.error("[acp] Failed to load skills while publishing slash commands", error);
      // Always publish built-in commands even if skills are temporarily unavailable.
      const cachedSkillsByName = this.sessionSkillsById.get(sessionId);
      advertisedSkills = cachedSkillsByName ? Array.from(cachedSkillsByName.values()) : [];
    }

    try {
      await this.connection.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: "available_commands_update",
          availableCommands: buildAcpAvailableCommands(advertisedSkills),
        },
      });
    } catch (error) {
      // Command advertisement should not block session creation/loading.
      console.error("[acp] Failed to publish available slash commands", error);
    }
  }

  private async getSessionSkills(
    sessionId: string,
    workspaceId: string
  ): Promise<ReadonlyMap<string, AgentSkillDescriptor>> {
    const cached = this.sessionSkillsById.get(sessionId);
    if (cached != null) {
      return cached;
    }

    const skills = await this.server.client.agentSkills.list({ workspaceId });
    const skillsByName = mapSkillsByName(skills);
    this.sessionSkillsById.set(sessionId, skillsByName);
    return skillsByName;
  }

  private getSessionOnChatMode(sessionId: string): OnChatMode {
    return this.onChatModeBySessionId.get(sessionId) ?? ON_CHAT_MODE_FULL;
  }

  /**
   * Ensure a chat subscription exists for the given session.  Returns a promise
   * that resolves once the underlying `onChat` stream is connected (so callers
   * like `prompt()` can safely send messages without racing the subscription).
   */
  private async ensureChatSubscription(
    sessionId: string,
    workspaceId: string,
    onChatMode: OnChatMode
  ): Promise<void> {
    // Always persist the latest desired replay mode, even when an existing
    // subscription is already connected. Future reconnects should honor the
    // most recent caller intent (e.g., loadSession full vs resumeSession live).
    this.onChatModeBySessionId.set(sessionId, onChatMode);

    // If a subscription is already being established, wait for it to become
    // connected rather than returning immediately.  This prevents callers
    // (e.g., prompt after session load) from racing ahead of the onChat attach.
    const existingReady = this.chatSubscriptionReady.get(sessionId);
    if (existingReady != null) {
      await existingReady;
      return;
    }

    // `connectedPromise` resolves once `onChat` returns the async iterable,
    // signalling the subscription is live.  If `onChat` fails before the
    // stream is established, the promise is rejected so callers get a proper
    // error instead of hanging indefinitely.
    let onConnected!: () => void;
    let onConnectFailed!: (reason: unknown) => void;
    const connectedPromise = new Promise<void>((resolve, reject) => {
      onConnected = resolve;
      onConnectFailed = reject;
    });

    // Store the readiness promise *before* spawning the subscription so that
    // concurrent callers will find and await it.
    this.chatSubscriptionReady.set(sessionId, connectedPromise);

    const subscription = this.runChatSubscription(sessionId, workspaceId, onConnected, onChatMode)
      .catch((error) => {
        // Reject the connected promise in case it hasn't been settled yet
        // (e.g., `onChat` itself threw before calling `onConnected`).
        onConnectFailed(error);

        if (this.connection.signal.aborted) {
          return;
        }

        this.rejectTurn(sessionId, asError(error, "onChat subscription failed"));
      })
      .finally(() => {
        this.chatSubscriptions.delete(sessionId);
        this.chatSubscriptionReady.delete(sessionId);
      });

    this.chatSubscriptions.set(sessionId, subscription);
    await connectedPromise;
  }

  private async runChatSubscription(
    sessionId: string,
    workspaceId: string,
    onConnected: () => void,
    onChatMode: OnChatMode
  ): Promise<void> {
    const chatStream = await this.server.client.workspace.onChat({
      workspaceId,
      mode: onChatMode,
    });
    onConnected();
    const observedStream = this.observeChatStream(sessionId, chatStream);
    await this.streamTranslator.consumeAndForward(sessionId, observedStream);

    // If the stream ends without a terminal event (e.g., transient transport
    // closure), reject any pending turn so `prompt()` doesn't hang forever.
    this.rejectTurn(
      sessionId,
      new Error("Chat stream ended unexpectedly without a terminal event")
    );
  }

  private async *observeChatStream(
    sessionId: string,
    chatStream: AsyncIterable<WorkspaceChatMessage>
  ): AsyncIterable<WorkspaceChatMessage> {
    for await (const event of chatStream) {
      this.handleStreamEvent(sessionId, event);
      yield event;
    }
  }

  private handleStreamEvent(sessionId: string, event: WorkspaceChatMessage): void {
    const isReplayEvent = (event as { replay?: boolean }).replay === true;

    if (event.type === "usage-delta") {
      if (!this.isActiveTurnMessage(sessionId, event.messageId)) {
        return;
      }

      this.latestUsageBySessionId.set(sessionId, convertToAcpUsage(event.cumulativeUsage));
      return;
    }

    // Correlate the turn with the correct message.  `stream-start` is emitted
    // exactly once per new assistant message and carries the definitive
    // messageId.  We latch on `stream-start` (rather than the first arbitrary
    // event) to avoid binding to a stale in-flight message when the workspace
    // has queued the new prompt behind a still-running stream.
    if (event.type === "stream-start") {
      const completion = this.turnCompletions.get(sessionId);
      // Reconnect replay can emit a prior message's stream-start while a new
      // prompt is pending. Only bind starts that carry this turn's correlation id.
      if (
        !isReplayEvent &&
        completion != null &&
        completion.messageId == null &&
        event.acpPromptId === completion.promptCorrelationId
      ) {
        completion.messageId = event.messageId;
      }
      return;
    }

    if (event.type === "tool-call-start") {
      if (isReplayEvent || !this.isActiveTurnMessage(sessionId, event.messageId)) {
        return;
      }

      void this.maybeDelegateToolCallToEditor(sessionId, event).catch((error) => {
        console.error("[acp] Failed to delegate tool call to editor", error);
      });
      return;
    }

    if (event.type === "stream-end") {
      if (isReplayEvent) {
        return;
      }
      // stream-end is a normal completion.  Only honour it for the identified
      // message — otherwise a prior in-flight message's completion could
      // prematurely resolve a freshly queued prompt.
      if (!this.isActiveTurnMessage(sessionId, event.messageId)) {
        return;
      }
      const usage =
        event.metadata.usage != null
          ? convertToAcpUsage(event.metadata.usage)
          : this.latestUsageBySessionId.get(sessionId);
      this.resolveTurn(sessionId, { stopReason: "end_turn", usage });
      return;
    }

    if (event.type === "stream-abort") {
      if (isReplayEvent) {
        return;
      }
      // stream-abort can arrive before stream-start when the user cancels
      // immediately.  Always honour abort for any pending turn so prompt()
      // doesn't hang forever.
      if (!this.isActiveTurnMessageOrPending(sessionId, event.messageId, event.acpPromptId)) {
        return;
      }
      const usage =
        event.metadata?.usage != null
          ? convertToAcpUsage(event.metadata.usage)
          : this.latestUsageBySessionId.get(sessionId);
      this.resolveTurn(sessionId, { stopReason: "cancelled", usage });
      return;
    }

    if (event.type === "stream-error" || event.type === "error") {
      if (isReplayEvent) {
        return;
      }
      // Like abort, errors must be propagated even before stream-start to
      // prevent hanging turns.
      if (!this.isActiveTurnMessageOrPending(sessionId, event.messageId, event.acpPromptId)) {
        return;
      }
      this.rejectTurn(sessionId, new Error(`prompt stream failed: ${event.error}`));
    }
  }

  private async maybeDelegateToolCallToEditor(
    sessionId: string,
    event: Extract<WorkspaceChatMessage, { type: "tool-call-start" }>
  ): Promise<void> {
    if (!this.toolRouter.shouldDelegateToEditor(sessionId, event.toolName)) {
      return;
    }

    const workspaceId = this.sessionManager.getWorkspaceId(sessionId);

    let delegatedResult: unknown;
    try {
      if (!isRecord(event.args)) {
        throw new Error("tool-call-start args must be an object to delegate");
      }

      delegatedResult = await this.toolRouter.delegateToEditor(
        sessionId,
        event.toolName,
        event.args
      );
    } catch (error) {
      delegatedResult = {
        success: false,
        error: `Editor delegation failed for ${event.toolName}: ${stringifyUnknown(error)}`,
      };
    }

    const answerResult = await this.server.client.workspace.answerDelegatedToolCall({
      workspaceId,
      toolCallId: event.toolCallId,
      result: delegatedResult,
    });

    if (!answerResult.success) {
      // No-op when the server wasn't waiting for this call (e.g., non-delegated replay).
      console.error(
        `[acp] Failed to deliver delegated tool result for ${event.toolCallId}: ${stringifyUnknown(answerResult.error)}`
      );
    }
  }

  private beginTurn(sessionId: string, promptCorrelationId: string): Promise<TurnResult> {
    assert(
      !this.turnCompletions.has(sessionId),
      `prompt: session '${sessionId}' already has a running turn`
    );
    assert(
      promptCorrelationId.trim().length > 0,
      "beginTurn: promptCorrelationId must be non-empty"
    );

    // Replay events from loadSession can include historical usage deltas; clear stale usage before
    // starting a fresh turn so prompt responses only reflect the in-flight request.
    this.latestUsageBySessionId.delete(sessionId);

    return new Promise<TurnResult>((resolve, reject) => {
      this.turnCompletions.set(sessionId, { resolve, reject, promptCorrelationId });
    });
  }
  /**
   * Check if a stream event's messageId matches the active turn.  Before
   * `stream-start` sets the turn's messageId, terminal events (stream-end,
   * stream-abort, stream-error) are ignored to prevent an older in-flight
   * message from prematurely resolving a freshly queued prompt.
   */
  private isActiveTurnMessage(sessionId: string, eventMessageId: string): boolean {
    const completion = this.turnCompletions.get(sessionId);
    if (completion == null) {
      return false;
    }
    // Until stream-start identifies the turn's message, reject all terminal
    // events so stale stream-end/abort from a prior message can't resolve
    // the new turn.
    if (completion.messageId == null) {
      return false;
    }
    return completion.messageId === eventMessageId;
  }
  /**
   * Like `isActiveTurnMessage` but also supports pre-stream terminal events.
   *
   * Pending turns (messageId not yet known) only accept terminal events that
   * carry a matching ACP prompt correlation id. This prevents unrelated streams
   * in shared workspaces from cancelling/rejecting the current prompt.
   */
  private isActiveTurnMessageOrPending(
    sessionId: string,
    eventMessageId: string,
    eventPromptCorrelationId?: string
  ): boolean {
    const completion = this.turnCompletions.get(sessionId);
    if (completion == null) {
      return false;
    }
    // Turn already identified — exact match only.
    if (completion.messageId != null) {
      return completion.messageId === eventMessageId;
    }

    // Pending turn: require explicit correlation id match.
    return (
      eventPromptCorrelationId != null &&
      eventPromptCorrelationId === completion.promptCorrelationId
    );
  }

  private resolveTurn(sessionId: string, result: TurnResult): void {
    const completion = this.turnCompletions.get(sessionId);
    if (!completion) {
      return;
    }

    this.turnCompletions.delete(sessionId);
    completion.resolve(result);
  }

  private rejectTurn(sessionId: string, error: Error): void {
    const completion = this.turnCompletions.get(sessionId);
    if (!completion) {
      return;
    }

    this.turnCompletions.delete(sessionId);
    completion.reject(error);
  }

  private updateSessionAgentState(
    sessionId: string,
    agentId: string,
    aiSettings: ResolvedAiSettings
  ): void {
    const normalizedAgentId = agentId.trim();
    assert(normalizedAgentId.length > 0, "updateSessionAgentState: agentId must be non-empty");

    const existingState = this.sessionStateById.get(sessionId);
    assert(
      existingState != null,
      `updateSessionAgentState: missing state for session '${sessionId}'`
    );

    this.sessionStateById.set(sessionId, {
      ...existingState,
      agentId: normalizedAgentId,
      aiSettings,
    });
  }

  private async refreshSessionState(sessionId: string): Promise<SessionState> {
    const workspaceId = this.sessionManager.getWorkspaceId(sessionId);
    const workspace = await this.server.client.workspace.getInfo({ workspaceId });

    if (!workspace) {
      throw new Error(`refreshSessionState: workspace '${workspaceId}' was not found`);
    }

    const runtimeMode = runtimeModeFromConfig(workspace.runtimeConfig);
    const existing = this.sessionStateById.get(sessionId);
    // Prefer the ACP session's agent selection over workspace metadata.
    // The user may have switched mode via session/set_config_option; that
    // selection lives in sessionStateById and must not be reverted by a
    // workspace.agentId value from the backend.
    const agentId = existing?.agentId ?? workspace.agentId ?? DEFAULT_AGENT_ID;
    const aiSettings =
      workspace.aiSettingsByAgent?.[agentId] ??
      workspace.aiSettings ??
      (await resolveAgentAiSettings(this.server.client, agentId, workspaceId));

    const nextState: SessionState = {
      workspaceId,
      runtimeMode,
      agentId,
      aiSettings,
    };

    this.sessionStateById.set(sessionId, nextState);
    return nextState;
  }

  private async persistAiSettings(
    workspaceId: string,
    agentId: string,
    aiSettings: ResolvedAiSettings
  ): Promise<void> {
    if (agentId === "plan" || agentId === "exec") {
      const updateModeResult = await this.server.client.workspace.updateModeAISettings({
        workspaceId,
        mode: agentId,
        aiSettings,
      });

      if (!updateModeResult.success) {
        throw new Error(`workspace.updateModeAISettings failed: ${updateModeResult.error}`);
      }

      return;
    }

    const updateAgentResult = await this.server.client.workspace.updateAgentAISettings({
      workspaceId,
      agentId,
      aiSettings,
    });

    if (!updateAgentResult.success) {
      throw new Error(`workspace.updateAgentAISettings failed: ${updateAgentResult.error}`);
    }
  }

  async waitForDisconnectCleanup(): Promise<void> {
    await this.disconnectCleanupPromise;
  }

  private assertInitialized(methodName: string): void {
    assert(this.initialized, `${methodName}: initialize must be called first`);
  }
}

function normalizeOptionalPath(value: string | null | undefined): string | undefined {
  if (value == null) {
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  return normalizePathForWorkspaceMatch(trimmed);
}

function normalizePathForWorkspaceMatch(value: string): string {
  const resolved = path.normalize(path.resolve(value));
  const stripped = stripTrailingPathSeparators(resolved);
  return process.platform === "win32" ? stripped.toLowerCase() : stripped;
}

function stripTrailingPathSeparators(value: string): string {
  const root = path.parse(value).root;
  let normalized = value;

  while (
    normalized.length > root.length &&
    (normalized.endsWith(path.posix.sep) || normalized.endsWith(path.win32.sep))
  ) {
    normalized = normalized.slice(0, -1);
  }

  return normalized;
}

function parseSessionListCursor(cursor: string | null | undefined): number {
  if (cursor == null) {
    return 0;
  }

  const trimmed = cursor.trim();
  if (trimmed.length === 0) {
    return 0;
  }

  assert(/^\d+$/.test(trimmed), `unstable_listSessions: invalid cursor '${cursor}'`);

  const parsed = Number(trimmed);
  assert(Number.isSafeInteger(parsed), `unstable_listSessions: invalid cursor '${cursor}'`);
  return parsed;
}

function isWorkspaceConversationEmpty(events: WorkspaceChatMessage[]): boolean {
  return !events.some(
    (event) => event.type === "message" && (event.role === "assistant" || event.role === "user")
  );
}

function dedupeWorkspacesById(workspaces: WorkspaceInfo[]): WorkspaceInfo[] {
  const deduped = new Map<string, WorkspaceInfo>();
  for (const workspace of workspaces) {
    if (!deduped.has(workspace.id)) {
      deduped.set(workspace.id, workspace);
    }
  }
  return Array.from(deduped.values());
}

function workspaceMatchesCwd(workspace: WorkspaceInfo, cwd: string): boolean {
  // Match both projectPath and concrete workspace path so clients can filter by
  // either the original project root or the runtime-specific working directory.
  const normalizedProjectPath = normalizePathForWorkspaceMatch(workspace.projectPath);
  const normalizedWorkspacePath = normalizePathForWorkspaceMatch(workspace.namedWorkspacePath);
  return normalizedProjectPath === cwd || normalizedWorkspacePath === cwd;
}

function compareSessionRecency(
  left: WorkspaceInfo,
  right: WorkspaceInfo,
  activityByWorkspaceId: WorkspaceActivityById
): number {
  const leftRecency = toSessionRecencyTimestamp(left, activityByWorkspaceId);
  const rightRecency = toSessionRecencyTimestamp(right, activityByWorkspaceId);

  if (leftRecency !== rightRecency) {
    return rightRecency - leftRecency;
  }

  return left.id.localeCompare(right.id);
}

function toSessionUpdatedAt(
  workspace: WorkspaceInfo,
  activityByWorkspaceId: WorkspaceActivityById
): string | null {
  const recency = toSessionRecencyTimestamp(workspace, activityByWorkspaceId);
  if (recency > 0) {
    return new Date(recency).toISOString();
  }

  return workspace.createdAt ?? null;
}

function toSessionRecencyTimestamp(
  workspace: WorkspaceInfo,
  activityByWorkspaceId: WorkspaceActivityById
): number {
  const workspaceActivity = activityByWorkspaceId[workspace.id];
  if (workspaceActivity?.recency != null) {
    return workspaceActivity.recency;
  }

  if (workspace.createdAt == null) {
    return 0;
  }

  const createdAtMs = Date.parse(workspace.createdAt);
  return Number.isFinite(createdAtMs) ? createdAtMs : 0;
}

function parseMuxMeta(rawMeta: MetaRecord | null | undefined): ParsedMuxMeta {
  const source = getMuxMetaSource(rawMeta);

  return {
    projectPath: readOptionalString(source, "projectPath"),
    branchName: readOptionalString(source, "branchName"),
    trunkBranch: readOptionalString(source, "trunkBranch"),
    title: readOptionalString(source, "title"),
    runtimeConfig: parseOptionalRuntimeConfig(source.runtimeConfig),
    agentId: readOptionalString(source, "agentId"),
    forkName:
      readOptionalString(source, "forkName") ??
      readOptionalString(source, "newName") ??
      readOptionalString(source, "title"),
  };
}

function getMuxMetaSource(rawMeta: MetaRecord | null | undefined): MetaRecord {
  if (!isRecord(rawMeta)) {
    return {};
  }

  const nestedMuxMeta = rawMeta.mux;
  if (isRecord(nestedMuxMeta)) {
    return nestedMuxMeta;
  }

  return rawMeta;
}

function parseOptionalRuntimeConfig(value: unknown): RuntimeConfig | undefined {
  if (value == null) {
    return undefined;
  }

  const parsed = RuntimeConfigSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `invalid runtimeConfig in ACP _meta: ${parsed.error.issues[0]?.message ?? "unknown"}`
    );
  }

  return parsed.data;
}

function readOptionalString(record: MetaRecord, key: string): string | undefined {
  const value = record[key];
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function runtimeModeFromConfig(runtimeConfig: RuntimeConfig | undefined): RuntimeMode {
  if (!runtimeConfig) {
    return "worktree";
  }

  if (isWorktreeRuntime(runtimeConfig)) {
    return "worktree";
  }

  return runtimeConfig.type;
}

function generateDefaultBranchName(): string {
  const timestamp = Date.now().toString(36);
  const randomSuffix = Math.random().toString(36).slice(2, 8);
  return `${DEFAULT_BRANCH_PREFIX}-${timestamp}-${randomSuffix}`;
}

interface ParsedPrompt {
  text: string;
  fileParts: Array<{ url: string; mediaType: string }>;
}

/**
 * Convert ACP ContentBlock[] to MUX sendMessage arguments.
 * - text/resource blocks → concatenated text
 * - image blocks → fileParts (data URIs) for multimodal support
 * - Unsupported types (audio, resource_link) → error rather than silent drop
 */
function parsePromptBlocks(blocks: ContentBlock[]): ParsedPrompt {
  assert(Array.isArray(blocks), "prompt: prompt blocks must be an array");

  const textParts: string[] = [];
  const fileParts: Array<{ url: string; mediaType: string }> = [];

  for (const block of blocks) {
    if (block.type === "text") {
      if (block.text.trim().length > 0) {
        textParts.push(block.text);
      }
      continue;
    }

    if (block.type === "resource") {
      const resource = block.resource;
      if ("text" in resource && resource.text.trim().length > 0) {
        textParts.push(resource.text);
      } else if ("blob" in resource && typeof resource.blob === "string") {
        // Binary resource embedded as base64 — treat as an image/file part.
        const mimeType =
          "mimeType" in resource && typeof resource.mimeType === "string"
            ? resource.mimeType
            : "application/octet-stream";
        fileParts.push({ url: `data:${mimeType};base64,${resource.blob}`, mediaType: mimeType });
      } else {
        // Opaque resource reference without inline content — pass URI as text
        // so the model has *some* context rather than silently dropping.
        textParts.push(`[resource: ${resource.uri}]`);
      }
      continue;
    }

    if (block.type === "image") {
      // Convert ACP image (base64 data + mimeType) to a MUX file part.
      const dataUri = `data:${block.mimeType};base64,${block.data}`;
      fileParts.push({ url: dataUri, mediaType: block.mimeType });
      continue;
    }

    // Unsupported content types — surface an error to the editor rather than
    // silently dropping content which leads to confusing model behavior.
    throw new Error(`prompt: unsupported content block type "${block.type}" is not yet supported`);
  }

  const text = textParts.join("\n\n").trim();
  return {
    text: text.length > 0 ? text : "[No textual prompt content provided]",
    fileParts,
  };
}

function isRecord(value: unknown): value is MetaRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asError(error: unknown, fallbackMessage: string): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(fallbackMessage, { cause: error });
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
