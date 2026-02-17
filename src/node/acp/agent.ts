import assert from "node:assert/strict";
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
  LoadSessionRequest,
  LoadSessionResponse,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  SetSessionConfigOptionRequest,
  SetSessionConfigOptionResponse,
  Usage,
} from "@agentclientprotocol/sdk";
import { RuntimeConfigSchema } from "@/common/orpc/schemas";
import type { WorkspaceChatMessage } from "@/common/orpc/types";
import { isWorktreeRuntime, type RuntimeConfig, type RuntimeMode } from "@/common/types/runtime";
import { negotiateCapabilities, type NegotiatedCapabilities } from "./capabilities";
import { AGENT_MODE_CONFIG_ID, buildConfigOptions, handleSetConfigOption } from "./configOptions";
import { forkSessionFromWorkspace } from "./experimental/sessionFork";
import { loadSessionFromWorkspace } from "./experimental/sessionResume";
import { convertToAcpUsage } from "./experimental/sessionUsage";
import { resolveAgentAiSettings, type ResolvedAiSettings } from "./resolveAgentAiSettings";
import type { ServerConnection } from "./serverConnection";
import { SessionManager } from "./sessionManager";
import { StreamTranslator } from "./streamTranslator";
import { ToolRouter } from "./toolRouter";

const DEFAULT_AGENT_ID = "exec";
const DEFAULT_BRANCH_PREFIX = "acp";

interface SessionState {
  workspaceId: string;
  runtimeMode: RuntimeMode;
  agentId: string;
  aiSettings: ResolvedAiSettings;
}

interface TurnResult {
  stopReason: PromptResponse["stopReason"];
  usage?: Usage;
}

interface TurnCompletion {
  resolve: (result: TurnResult) => void;
  reject: (error: Error) => void;
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

export class MuxAgent implements Agent {
  private readonly sessionManager = new SessionManager();
  private readonly toolRouter: ToolRouter;
  private readonly streamTranslator: StreamTranslator;

  private negotiatedCapabilities: NegotiatedCapabilities | null = null;
  private initialized = false;

  private readonly sessionStateById = new Map<string, SessionState>();
  private readonly chatSubscriptions = new Map<string, Promise<void>>();
  /** Resolves once `onChat` is connected for a session (shared across callers). */
  private readonly chatSubscriptionReady = new Map<string, Promise<void>>();
  private readonly turnCompletions = new Map<string, TurnCompletion>();
  private readonly latestUsageBySessionId = new Map<string, Usage>();

  constructor(
    private readonly connection: AgentSideConnection,
    private readonly server: ServerConnection
  ) {
    assert(connection != null, "MuxAgent: connection is required");
    assert(server != null, "MuxAgent: server connection is required");

    this.toolRouter = new ToolRouter(connection);
    this.streamTranslator = new StreamTranslator(connection);

    this.connection.signal.addEventListener(
      "abort",
      () => {
        const disconnectError = new Error("Mux ACP connection closed");
        for (const [sessionId] of this.turnCompletions) {
          this.rejectTurn(sessionId, disconnectError);
        }
      },
      { once: true }
    );
  }

  initialize(params: InitializeRequest): Promise<InitializeResponse> {
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
        },
      },
    });
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    this.assertInitialized("newSession");

    const meta = parseMuxMeta(params._meta);
    const projectPath = meta.projectPath ?? params.cwd.trim();
    assert(projectPath.length > 0, "newSession: projectPath/cwd must be non-empty");

    const createResult = await this.server.client.workspace.create({
      projectPath,
      branchName: meta.branchName ?? generateDefaultBranchName(),
      trunkBranch: meta.trunkBranch,
      title: meta.title,
      runtimeConfig: meta.runtimeConfig,
    });

    if (!createResult.success) {
      throw new Error(`newSession: workspace.create failed: ${createResult.error}`);
    }

    const workspace = createResult.metadata;
    const sessionId = workspace.id;
    const workspaceId = workspace.id;
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

    await this.ensureChatSubscription(sessionId, workspaceId);

    return {
      sessionId,
      configOptions: await buildConfigOptions(this.server.client, workspaceId, {
        activeAgentId: agentId,
      }),
    };
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
      toolRouter: this.toolRouter,
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

    await this.ensureChatSubscription(resumed.sessionId, resumed.workspaceId);

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
        toolRouter: this.toolRouter,
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

    await this.ensureChatSubscription(forked.sessionId, forked.workspaceId);

    return forked.response;
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    this.assertInitialized("prompt");

    const sessionId = params.sessionId.trim();
    assert(sessionId.length > 0, "prompt: sessionId must be non-empty");

    const workspaceId = this.sessionManager.getWorkspaceId(sessionId);
    const sessionState = await this.refreshSessionState(sessionId);
    const parsedPrompt = parsePromptBlocks(params.prompt);

    // Re-establish chat subscription if a prior one dropped (e.g., transient
    // websocket interruption). Without a live subscription, stream-end events
    // never arrive and the turn promise hangs indefinitely.
    await this.ensureChatSubscription(sessionId, workspaceId);

    const turnPromise = this.beginTurn(sessionId);

    try {
      const sendResult = await this.server.client.workspace.sendMessage({
        workspaceId,
        message: parsedPrompt.text,
        options: {
          model: sessionState.aiSettings.model,
          thinkingLevel: sessionState.aiSettings.thinkingLevel,
          agentId: sessionState.agentId,
          fileParts: parsedPrompt.fileParts.length > 0 ? parsedPrompt.fileParts : undefined,
        },
      });

      if (!sendResult.success) {
        throw new Error(
          `prompt: workspace.sendMessage failed: ${stringifyUnknown(sendResult.error)}`
        );
      }

      const turn = await turnPromise;
      const usage = turn.usage ?? this.latestUsageBySessionId.get(sessionId);
      this.latestUsageBySessionId.delete(sessionId);

      return {
        stopReason: turn.stopReason,
        usage,
      };
    } catch (error) {
      // workspace.sendMessage failures happen before stream events can settle the turn promise.
      // Clear turn state without rejecting to avoid detached/unhandled promise rejections.
      this.turnCompletions.delete(sessionId);
      throw error;
    }
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

  /**
   * Ensure a chat subscription exists for the given session.  Returns a promise
   * that resolves once the underlying `onChat` stream is connected (so callers
   * like `prompt()` can safely send messages without racing the subscription).
   */
  private async ensureChatSubscription(sessionId: string, workspaceId: string): Promise<void> {
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
    const {
      promise: connectedPromise,
      resolve: onConnected,
      reject: onConnectFailed,
    } = Promise.withResolvers<void>();

    // Store the readiness promise *before* spawning the subscription so that
    // concurrent callers will find and await it.
    this.chatSubscriptionReady.set(sessionId, connectedPromise);

    const subscription = this.runChatSubscription(sessionId, workspaceId, onConnected)
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
    onConnected: () => void
  ): Promise<void> {
    const chatStream = await this.server.client.workspace.onChat({ workspaceId });
    onConnected();
    const observedStream = this.observeChatStream(sessionId, chatStream);
    await this.streamTranslator.consumeAndForward(sessionId, observedStream);
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
    if (event.type === "usage-delta") {
      this.latestUsageBySessionId.set(sessionId, convertToAcpUsage(event.cumulativeUsage));
      return;
    }

    if (event.type === "stream-end") {
      const usage =
        event.metadata.usage != null
          ? convertToAcpUsage(event.metadata.usage)
          : this.latestUsageBySessionId.get(sessionId);
      this.resolveTurn(sessionId, { stopReason: "end_turn", usage });
      return;
    }

    if (event.type === "stream-abort") {
      const usage =
        event.metadata?.usage != null
          ? convertToAcpUsage(event.metadata.usage)
          : this.latestUsageBySessionId.get(sessionId);
      this.resolveTurn(sessionId, { stopReason: "cancelled", usage });
      return;
    }

    if (event.type === "stream-error") {
      this.rejectTurn(sessionId, new Error(`prompt stream failed: ${event.error}`));
    }
  }

  private beginTurn(sessionId: string): Promise<TurnResult> {
    assert(
      !this.turnCompletions.has(sessionId),
      `prompt: session '${sessionId}' already has a running turn`
    );

    // Replay events from loadSession can include historical usage deltas; clear stale usage before
    // starting a fresh turn so prompt responses only reflect the in-flight request.
    this.latestUsageBySessionId.delete(sessionId);

    return new Promise<TurnResult>((resolve, reject) => {
      this.turnCompletions.set(sessionId, { resolve, reject });
    });
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

  private assertInitialized(methodName: string): void {
    assert(this.initialized, `${methodName}: initialize must be called first`);
  }
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
