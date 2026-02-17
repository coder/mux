import type { Agent as AcpAgent, AgentSideConnection } from "@agentclientprotocol/sdk";
import type * as acpSchema from "@agentclientprotocol/sdk";
import { DEFAULT_MODEL, KNOWN_MODELS } from "@/common/constants/knownModels";
import type { WorkspaceChatMessage } from "@/common/orpc/types";
import { THINKING_LEVELS, isThinkingLevel, type ThinkingLevel } from "@/common/types/thinking";
import type { RuntimeConfig } from "@/common/types/runtime";
import assert from "@/common/utils/assert";
import type { AcpSdk } from "./acpSdk";
import type { createOrpcWsClient } from "./orpcWsClient";
import { SessionManager, type SessionState } from "./sessionManager";
import { translateMuxEvent, translateUsage } from "./streamTranslator";

const DEFAULT_AGENT_ID = "exec";
const DEFAULT_THINKING_LEVEL: ThinkingLevel = "medium";
const CONFIG_ID_AGENT_ID = "agentId";
const CONFIG_ID_MODEL = "model";
const CONFIG_ID_THINKING_LEVEL = "thinkingLevel";
const AGENT_ID_PATTERN = /^[a-z0-9]+(?:[a-z0-9_-]*[a-z0-9])?$/;
const UNSTABLE_SESSION_LIST_PAGE_SIZE = 50;
const METHOD_SESSION_LIST = "session/list";
const METHOD_SESSION_FORK = "session/fork";
const METHOD_SESSION_RESUME = "session/resume";
const METHOD_SESSION_SET_MODEL = "session/set_model";
const METHOD_SESSION_INFO_UPDATE = "session/info_update";
const METHOD_CANCEL_REQUEST = "$/cancel_request";

interface ParsedMuxMeta {
  projectPath?: string;
  branchName?: string;
  trunkBranch?: string;
  title?: string;
  runtimeConfig?: RuntimeConfig;
  sectionId?: string;
  agentId?: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
}

interface ModeOption {
  id: string;
  name: string;
  description?: string;
}

type OrpcClient = ReturnType<typeof createOrpcWsClient>["client"];
type AgentDescriptor = Awaited<ReturnType<OrpcClient["agents"]["list"]>>[number];

export interface MuxAcpAgentDeps {
  conn: AgentSideConnection;
  sdk: AcpSdk;
  orpcClient: OrpcClient;
  unstable: boolean;
  log: (...args: unknown[]) => void;
}

export class MuxAcpAgent implements AcpAgent {
  private static readonly MAX_AGENT_ID_LENGTH = 64;

  private sessionManager = new SessionManager();

  constructor(private readonly deps: MuxAcpAgentDeps) {
    assert(deps != null, "MuxAcpAgent deps are required");

    deps.conn.signal.addEventListener(
      "abort",
      () => {
        this.sessionManager.disposeAll();
      },
      { once: true }
    );

    if (deps.unstable) {
      deps.log("ACP unstable mode requested; unstable_* methods are enabled");
    }
  }

  // --- ACP Agent interface methods ---

  initialize(_params: acpSchema.InitializeRequest): Promise<acpSchema.InitializeResponse> {
    const sessionCapabilities: acpSchema.SessionCapabilities | undefined = this.deps.unstable
      ? {
          list: {},
          fork: {},
          resume: {},
        }
      : undefined;

    return Promise.resolve({
      protocolVersion: this.deps.sdk.PROTOCOL_VERSION,
      agentInfo: {
        name: "mux",
        version: "0.1.0",
      },
      agentCapabilities: {
        loadSession: true,
        ...(sessionCapabilities ? { sessionCapabilities } : {}),
      },
    });
  }

  async authenticate(_params: acpSchema.AuthenticateRequest): Promise<void> {
    // MVP: no-op (auth handled by mux server discovery / auth token env)
  }

  async newSession(params: acpSchema.NewSessionRequest): Promise<acpSchema.NewSessionResponse> {
    assert(params != null, "newSession params are required");

    const muxMeta = this.parseMuxMeta(params._meta);
    const projectPath = muxMeta.projectPath ?? normalizeNonEmptyString(params.cwd);

    if (!projectPath) {
      throw this.deps.sdk.RequestError.invalidParams(
        undefined,
        "session/new requires cwd or _meta.mux.projectPath"
      );
    }

    const branchName = muxMeta.branchName ?? `acp-${Date.now()}`;

    let trunkBranch = muxMeta.trunkBranch;
    if (!trunkBranch) {
      try {
        const branchResult = await this.deps.orpcClient.projects.listBranches({ projectPath });
        trunkBranch = branchResult.recommendedTrunk ?? undefined;
      } catch (error) {
        this.deps.log("projects.listBranches failed; continuing without trunkBranch", error);
      }
    }

    const createResult = await this.deps.orpcClient.workspace.create({
      projectPath,
      branchName,
      trunkBranch,
      title: muxMeta.title,
      runtimeConfig: muxMeta.runtimeConfig,
      sectionId: muxMeta.sectionId,
    });

    if (!createResult.success) {
      throw this.deps.sdk.RequestError.internalError(
        undefined,
        `Failed to create workspace: ${this.describeUnknownError(createResult.error)}`
      );
    }

    const workspaceId = createResult.metadata.id;
    const agentId = this.resolveAgentId(muxMeta.agentId);
    const model = normalizeNonEmptyString(muxMeta.model) ?? this.defaultModel();
    const thinkingLevel = this.resolveThinkingLevel(muxMeta.thinkingLevel);

    await this.persistAiSettings(workspaceId, agentId, model, thinkingLevel);

    this.sessionManager.createSession(workspaceId, {
      workspaceId,
      projectPath,
      agentId,
      model,
      thinkingLevel,
      isNewSession: true,
    });

    this.subscribeToChat(workspaceId);

    const modeOptions = await this.getModeOptions(projectPath, workspaceId);

    return {
      sessionId: workspaceId,
      configOptions: this.buildConfigOptions(modeOptions, { agentId, model, thinkingLevel }),
      modes: this.buildModes(modeOptions, agentId),
    };
  }

  async loadSession(params: acpSchema.LoadSessionRequest): Promise<acpSchema.LoadSessionResponse> {
    assert(params != null, "loadSession params are required");

    const workspaceId = params.sessionId;
    const info = await this.deps.orpcClient.workspace.getInfo({ workspaceId });
    if (!info) {
      throw this.deps.sdk.RequestError.resourceNotFound(workspaceId);
    }

    const agentId = this.resolveAgentId(info.agentId);
    const aiSettings = info.aiSettingsByAgent?.[agentId] ?? info.aiSettings;
    const model = normalizeNonEmptyString(aiSettings?.model) ?? this.defaultModel();
    const thinkingLevel = this.resolveThinkingLevel(aiSettings?.thinkingLevel);

    this.sessionManager.createSession(workspaceId, {
      workspaceId,
      projectPath: info.projectPath,
      agentId,
      model,
      thinkingLevel,
      isNewSession: false,
    });

    this.subscribeToChat(workspaceId);

    const modeOptions = await this.getModeOptions(info.projectPath, workspaceId);

    return {
      configOptions: this.buildConfigOptions(modeOptions, {
        agentId,
        model,
        thinkingLevel,
      }),
      modes: this.buildModes(modeOptions, agentId),
    };
  }

  async prompt(params: acpSchema.PromptRequest): Promise<acpSchema.PromptResponse> {
    assert(params != null, "prompt params are required");

    const session = this.sessionManager.getSession(params.sessionId);
    if (!session) {
      throw this.deps.sdk.RequestError.resourceNotFound(params.sessionId);
    }

    if (session.subscriptionDead) {
      throw new Error("Session subscription lost — cannot accept prompts. Create a new session.");
    }

    if (session.promptResolver) {
      throw this.deps.sdk.RequestError.invalidParams(
        undefined,
        `Session ${params.sessionId} already has an active prompt`
      );
    }

    if (!session.caughtUp) {
      // Wait for initial replay to finish before accepting prompts so that
      // lastSeenHistorySequence reflects all replayed stream-starts and the
      // prompt resolver's minHistorySequence guard is accurate.
      const CAUGHT_UP_TIMEOUT_MS = 30_000;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error("Timed out waiting for session replay to finish"));
        }, CAUGHT_UP_TIMEOUT_MS);
      });
      try {
        await Promise.race([session.caughtUpPromise, timeoutPromise]);
      } finally {
        // Clear the timer so it doesn't keep the event loop alive or
        // accumulate across sessions after the race settles.
        if (timer != null) {
          clearTimeout(timer);
        }
      }
    }

    // Re-read session after await.
    const sessionAfterWait = this.sessionManager.getSession(params.sessionId);
    if (!sessionAfterWait) {
      throw this.deps.sdk.RequestError.resourceNotFound(params.sessionId);
    }
    if (sessionAfterWait.subscriptionDead) {
      throw new Error("Session subscription lost — cannot accept prompts. Create a new session.");
    }
    if (sessionAfterWait.promptResolver) {
      throw this.deps.sdk.RequestError.invalidParams(
        undefined,
        `Session ${params.sessionId} already has an active prompt`
      );
    }

    const rawMessageText = params.prompt
      .flatMap((block) => {
        if (block.type === "text") {
          return [block.text];
        }
        return [];
      })
      .join("\n");

    if (rawMessageText.trim().length === 0) {
      throw this.deps.sdk.RequestError.invalidParams(
        undefined,
        "session/prompt requires at least one text content block"
      );
    }

    // Install the resolver BEFORE awaiting sendMessage.
    //
    // Why before: workspace.sendMessage may await the entire stream lifecycle
    // on the server side, so stream-start/stream-end events can arrive (and be
    //
    // TODO: workspace.sendMessage does not return a correlation ID, so we
    // cannot deterministically match a stream-start to the specific send that
    // triggered it when multiple producers target the same workspace. The
    // historySequence guard + first-write-wins is the best available heuristic.
    // A proper fix requires the server to return a correlation token from
    // sendMessage that can be matched against stream-start.messageId.
    //
    // processed by handleChatEvent) while sendMessage is in-flight. If the
    // resolver isn't installed yet, those events have nothing to resolve.
    //
    // historySequence guard: the resolver records the latest historySequence
    // seen at the time of creation. updatePromptMessageId only binds to
    // stream-starts with a strictly higher sequence, filtering out
    // pre-existing in-flight streams from other producers.
    const minHistorySequence = sessionAfterWait.lastSeenHistorySequence;

    const promptPromise = new Promise<acpSchema.PromptResponse>((resolve, reject) => {
      this.sessionManager.setPromptResolver(params.sessionId, {
        resolve,
        reject,
        messageId: "",
        minHistorySequence,
      });
    });

    let sendResult: Awaited<ReturnType<OrpcClient["workspace"]["sendMessage"]>>;
    try {
      sendResult = await this.deps.orpcClient.workspace.sendMessage({
        workspaceId: sessionAfterWait.workspaceId,
        message: rawMessageText,
        options: {
          model: sessionAfterWait.model,
          agentId: sessionAfterWait.agentId,
          thinkingLevel: sessionAfterWait.thinkingLevel,
        },
      });
    } catch (error) {
      this.sessionManager.clearPromptResolver(params.sessionId);
      throw this.deps.sdk.RequestError.internalError(
        undefined,
        `workspace.sendMessage failed: ${this.describeUnknownError(error)}`
      );
    }

    if (!sendResult.success) {
      this.sessionManager.clearPromptResolver(params.sessionId);
      throw this.deps.sdk.RequestError.internalError(
        undefined,
        `workspace.sendMessage failed: ${this.describeUnknownError(sendResult.error)}`
      );
    }

    // Only auto-generate a title for sessions created via newSession, not
    // loadSession — reconnecting to an existing workspace should not overwrite
    // its existing title.
    if (!sessionAfterWait.firstPromptSent && sessionAfterWait.isNewSession) {
      sessionAfterWait.firstPromptSent = true;
      this.maybeGenerateName(sessionAfterWait, rawMessageText).catch((error) => {
        this.deps.log("name generation failed", error);
      });
    }

    // Safety timeout: if the prompt was queued behind another producer's active
    // stream and that entry is later removed (e.g. by an external interruptStream
    // or clearQueue), no stream-start/stream-end events fire, so the resolver's
    // messageId stays empty and promptPromise hangs indefinitely. A 5-minute
    // safety timeout prevents this by force-rejecting stale prompts.
    const PROMPT_SAFETY_TIMEOUT_MS = 5 * 60 * 1000;
    let safetyTimer: ReturnType<typeof setTimeout> | undefined;
    const safetyTimeoutPromise = new Promise<acpSchema.PromptResponse>((_, reject) => {
      safetyTimer = setTimeout(() => {
        // Only reject if the prompt is still active (messageId empty means
        // stream-start never arrived for this prompt).
        const currentSession = this.sessionManager.getSession(params.sessionId);
        if (currentSession?.promptResolver?.messageId.length === 0) {
          this.sessionManager.clearPromptResolver(params.sessionId);
          reject(new Error("Prompt timed out — no stream activity received"));
        }
      }, PROMPT_SAFETY_TIMEOUT_MS);
    });

    try {
      return await Promise.race([promptPromise, safetyTimeoutPromise]);
    } finally {
      if (safetyTimer != null) {
        clearTimeout(safetyTimer);
      }
    }
  }

  async cancel(params: acpSchema.CancelNotification): Promise<void> {
    assert(params != null, "cancel params are required");

    const session = this.sessionManager.getSession(params.sessionId);
    if (!session) {
      return;
    }

    try {
      const interruptResult = await this.deps.orpcClient.workspace.interruptStream({
        workspaceId: session.workspaceId,
        options: { soft: true },
      });

      if (!interruptResult.success) {
        this.deps.log("workspace.interruptStream returned error", interruptResult.error);
        return;
      }

      // If the prompt was queued (stream-start never arrived to bind a
      // messageId), interruptStream restores the queued message to input but no
      // stream events fire. Force-resolve the unbound prompt so it doesn't hang
      // indefinitely.
      const promptResolver = session.promptResolver;
      if (promptResolver?.messageId.length === 0) {
        this.sessionManager.clearPromptResolver(params.sessionId);
        promptResolver.resolve({ stopReason: "cancelled" });
      }
    } catch (error) {
      this.deps.log("workspace.interruptStream failed", error);
    }
  }

  async setSessionConfigOption(
    params: acpSchema.SetSessionConfigOptionRequest
  ): Promise<acpSchema.SetSessionConfigOptionResponse> {
    assert(params != null, "setSessionConfigOption params are required");

    const session = this.sessionManager.getSession(params.sessionId);
    if (!session) {
      throw this.deps.sdk.RequestError.resourceNotFound(params.sessionId);
    }

    switch (params.configId) {
      case CONFIG_ID_AGENT_ID: {
        const modeOptions = await this.getModeOptions(session.projectPath, session.workspaceId);
        if (!modeOptions.some((option) => option.id === params.value)) {
          throw this.deps.sdk.RequestError.invalidParams(
            undefined,
            `Unknown agent option: ${params.value}`
          );
        }

        this.sessionManager.updateConfig(params.sessionId, { agentId: params.value });

        // Reload agent-scoped AI settings for the new agent so model/thinking
        // match what the workspace has persisted for this agent.
        try {
          const info = await this.deps.orpcClient.workspace.getInfo({
            workspaceId: session.workspaceId,
          });
          if (info) {
            const aiSettings = info.aiSettingsByAgent?.[params.value] ?? info.aiSettings;
            const model = normalizeNonEmptyString(aiSettings?.model) ?? this.defaultModel();
            const thinkingLevel = this.resolveThinkingLevel(aiSettings?.thinkingLevel);
            this.sessionManager.updateConfig(params.sessionId, { model, thinkingLevel });
          }
        } catch (error) {
          // Best-effort: if loading settings fails, keep previous values.
          this.deps.log("Failed to reload AI settings after agent config change", error);
        }

        break;
      }

      case CONFIG_ID_MODEL:
        if (!this.knownModelIds().has(params.value)) {
          throw this.deps.sdk.RequestError.invalidParams(
            undefined,
            `Unknown model option: ${params.value}`
          );
        }

        this.sessionManager.updateConfig(params.sessionId, { model: params.value });
        break;

      case CONFIG_ID_THINKING_LEVEL:
        if (!isThinkingLevel(params.value)) {
          throw this.deps.sdk.RequestError.invalidParams(
            undefined,
            `Unknown thinking level option: ${params.value}`
          );
        }

        this.sessionManager.updateConfig(params.sessionId, { thinkingLevel: params.value });
        break;

      default:
        throw this.deps.sdk.RequestError.invalidParams(
          undefined,
          `Unknown config option: ${params.configId}`
        );
    }

    const updated = this.sessionManager.getSession(params.sessionId);
    assert(updated, `Session ${params.sessionId} disappeared during config update`);

    if (params.configId === CONFIG_ID_MODEL || params.configId === CONFIG_ID_THINKING_LEVEL) {
      await this.persistAiSettings(
        updated.workspaceId,
        updated.agentId,
        updated.model,
        updated.thinkingLevel
      );
    }

    const modeOptions = await this.getModeOptions(updated.projectPath, updated.workspaceId);

    return {
      configOptions: this.buildConfigOptions(modeOptions, {
        agentId: updated.agentId,
        model: updated.model,
        thinkingLevel: updated.thinkingLevel,
      }),
    };
  }

  async setSessionMode(params: acpSchema.SetSessionModeRequest): Promise<void> {
    assert(params != null, "setSessionMode params are required");

    const session = this.sessionManager.getSession(params.sessionId);
    if (!session) {
      throw this.deps.sdk.RequestError.resourceNotFound(params.sessionId);
    }

    const modeOptions = await this.getModeOptions(session.projectPath, session.workspaceId);
    if (!modeOptions.some((option) => option.id === params.modeId)) {
      throw this.deps.sdk.RequestError.invalidParams(undefined, `Unknown mode: ${params.modeId}`);
    }

    this.sessionManager.updateConfig(params.sessionId, { agentId: params.modeId });

    // Reload agent-scoped AI settings for the new mode so model/thinking
    // match what the workspace has persisted for this agent.
    try {
      const info = await this.deps.orpcClient.workspace.getInfo({
        workspaceId: session.workspaceId,
      });
      if (info) {
        const aiSettings = info.aiSettingsByAgent?.[params.modeId] ?? info.aiSettings;
        const model = normalizeNonEmptyString(aiSettings?.model) ?? this.defaultModel();
        const thinkingLevel = this.resolveThinkingLevel(aiSettings?.thinkingLevel);
        this.sessionManager.updateConfig(params.sessionId, { model, thinkingLevel });
      }
    } catch (error) {
      // Best-effort: if loading settings fails, keep previous values.
      this.deps.log("Failed to reload AI settings after mode change", error);
    }

    await this.deps.conn.sessionUpdate({
      sessionId: session.workspaceId,
      update: {
        sessionUpdate: "current_mode_update",
        currentModeId: params.modeId,
      },
    });
  }

  async unstable_listSessions(
    params: acpSchema.ListSessionsRequest
  ): Promise<acpSchema.ListSessionsResponse> {
    assert(params != null, "unstable_listSessions params are required");
    this.assertUnstableEnabled(METHOD_SESSION_LIST);

    const requestedCwd = normalizeNonEmptyString(params.cwd);
    const startIndex = this.parseListCursor(params.cursor);

    const workspaces = await this.deps.orpcClient.workspace.list({});
    const filteredWorkspaces = requestedCwd
      ? workspaces.filter(
          (workspace) =>
            workspace.namedWorkspacePath === requestedCwd || workspace.projectPath === requestedCwd
        )
      : workspaces;

    const sortedWorkspaces = [...filteredWorkspaces].sort((left, right) => {
      const createdAtSort = (right.createdAt ?? "").localeCompare(left.createdAt ?? "");
      return createdAtSort !== 0 ? createdAtSort : left.id.localeCompare(right.id);
    });

    const page = sortedWorkspaces.slice(startIndex, startIndex + UNSTABLE_SESSION_LIST_PAGE_SIZE);
    const sessions: acpSchema.SessionInfo[] = page.map((workspace) => ({
      sessionId: workspace.id,
      cwd: workspace.namedWorkspacePath,
      title: workspace.title ?? workspace.name,
      updatedAt: workspace.createdAt,
      _meta: {
        mux: {
          projectPath: workspace.projectPath,
          projectName: workspace.projectName,
          runtimeType: workspace.runtimeConfig.type,
          createdAt: workspace.createdAt,
        },
      },
    }));

    const nextCursor = startIndex + UNSTABLE_SESSION_LIST_PAGE_SIZE < sortedWorkspaces.length;

    return {
      sessions,
      ...(nextCursor ? { nextCursor: String(startIndex + UNSTABLE_SESSION_LIST_PAGE_SIZE) } : {}),
    };
  }

  async unstable_forkSession(
    params: acpSchema.ForkSessionRequest
  ): Promise<acpSchema.ForkSessionResponse> {
    assert(params != null, "unstable_forkSession params are required");
    this.assertUnstableEnabled(METHOD_SESSION_FORK);

    const sourceWorkspaceId = normalizeNonEmptyString(params.sessionId);
    if (!sourceWorkspaceId) {
      throw this.deps.sdk.RequestError.invalidParams(
        undefined,
        "session/fork requires a non-empty sessionId"
      );
    }

    const sourceInfo = await this.deps.orpcClient.workspace.getInfo({
      workspaceId: sourceWorkspaceId,
    });
    if (!sourceInfo) {
      throw this.deps.sdk.RequestError.resourceNotFound(sourceWorkspaceId);
    }

    const forkResult = await this.deps.orpcClient.workspace.fork({
      sourceWorkspaceId,
    });

    if (!forkResult.success) {
      throw this.deps.sdk.RequestError.internalError(
        undefined,
        `workspace.fork failed: ${forkResult.error}`
      );
    }

    const workspaceId = forkResult.metadata.id;
    assert(workspaceId.length > 0, "workspace.fork must return a non-empty workspace ID");

    const agentId = this.resolveAgentId(forkResult.metadata.agentId ?? sourceInfo.agentId);
    const sourceAiSettings = sourceInfo.aiSettingsByAgent?.[agentId] ?? sourceInfo.aiSettings;
    const forkedAiSettings =
      forkResult.metadata.aiSettingsByAgent?.[agentId] ?? forkResult.metadata.aiSettings;
    const model =
      normalizeNonEmptyString(forkedAiSettings?.model ?? sourceAiSettings?.model) ??
      this.defaultModel();
    const thinkingLevel = this.resolveThinkingLevel(
      forkedAiSettings?.thinkingLevel ?? sourceAiSettings?.thinkingLevel
    );

    await this.persistAiSettings(workspaceId, agentId, model, thinkingLevel);

    this.sessionManager.createSession(workspaceId, {
      workspaceId,
      projectPath: forkResult.metadata.projectPath,
      agentId,
      model,
      thinkingLevel,
      isNewSession: true,
    });

    this.subscribeToChat(workspaceId);

    const modeOptions = await this.getModeOptions(forkResult.metadata.projectPath, workspaceId);

    return {
      sessionId: workspaceId,
      configOptions: this.buildConfigOptions(modeOptions, {
        agentId,
        model,
        thinkingLevel,
      }),
      modes: this.buildModes(modeOptions, agentId),
    };
  }

  async unstable_resumeSession(
    params: acpSchema.ResumeSessionRequest
  ): Promise<acpSchema.ResumeSessionResponse> {
    assert(params != null, "unstable_resumeSession params are required");
    this.assertUnstableEnabled(METHOD_SESSION_RESUME);

    return this.loadSession({
      sessionId: params.sessionId,
      cwd: params.cwd,
      mcpServers: params.mcpServers ?? [],
    });
  }

  async unstable_setSessionModel(params: acpSchema.SetSessionModelRequest): Promise<void> {
    assert(params != null, "unstable_setSessionModel params are required");
    this.assertUnstableEnabled(METHOD_SESSION_SET_MODEL);

    const modelId = normalizeNonEmptyString(params.modelId);
    if (!modelId) {
      throw this.deps.sdk.RequestError.invalidParams(
        undefined,
        "session/set_model requires a non-empty modelId"
      );
    }

    if (!this.knownModelIds().has(modelId)) {
      throw this.deps.sdk.RequestError.invalidParams(undefined, `Unknown model option: ${modelId}`);
    }

    const session = this.sessionManager.getSession(params.sessionId);
    if (!session) {
      throw this.deps.sdk.RequestError.resourceNotFound(params.sessionId);
    }

    this.sessionManager.updateConfig(params.sessionId, { model: modelId });
    await this.persistAiSettings(
      session.workspaceId,
      session.agentId,
      modelId,
      session.thinkingLevel
    );
  }

  async extMethod(
    method: string,
    params: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    if (!this.deps.unstable) {
      throw this.deps.sdk.RequestError.methodNotFound(method);
    }

    if (method !== METHOD_SESSION_INFO_UPDATE) {
      throw this.deps.sdk.RequestError.methodNotFound(method);
    }

    const sessionId = normalizeNonEmptyString(params.sessionId);
    if (!sessionId) {
      throw this.deps.sdk.RequestError.invalidParams(
        undefined,
        "session/info_update requires a non-empty sessionId"
      );
    }

    const title = this.readSessionInfoUpdateTitle(params);
    if (title === undefined) {
      throw this.deps.sdk.RequestError.invalidParams(
        undefined,
        "session/info_update requires a string title"
      );
    }

    const info = await this.deps.orpcClient.workspace.getInfo({ workspaceId: sessionId });
    if (!info) {
      throw this.deps.sdk.RequestError.resourceNotFound(sessionId);
    }

    const result = await this.deps.orpcClient.workspace.updateTitle({
      workspaceId: sessionId,
      title,
    });

    if (!result.success) {
      throw this.deps.sdk.RequestError.internalError(
        undefined,
        `workspace.updateTitle failed: ${result.error}`
      );
    }

    return {};
  }

  async extNotification(method: string, params: Record<string, unknown>): Promise<void> {
    if (!this.deps.unstable) {
      throw this.deps.sdk.RequestError.methodNotFound(method);
    }

    if (method !== METHOD_CANCEL_REQUEST) {
      return;
    }

    const sessionId = this.readCancelRequestSessionId(params);
    if (!sessionId) {
      this.deps.log("Ignoring $/cancel_request notification without a sessionId", params);
      return;
    }

    const session = this.sessionManager.getSession(sessionId);
    if (!session?.promptResolver) {
      return;
    }

    await this.cancel({ sessionId });
  }

  private assertUnstableEnabled(method: string): void {
    if (!this.deps.unstable) {
      throw this.deps.sdk.RequestError.methodNotFound(method);
    }
  }

  private parseListCursor(cursor: string | null | undefined): number {
    if (cursor == null) {
      return 0;
    }

    const trimmed = cursor.trim();
    if (trimmed.length === 0) {
      return 0;
    }

    if (!/^[0-9]+$/.test(trimmed)) {
      throw this.deps.sdk.RequestError.invalidParams(
        undefined,
        `Invalid session/list cursor: ${cursor}`
      );
    }

    const parsed = Number.parseInt(trimmed, 10);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
      throw this.deps.sdk.RequestError.invalidParams(
        undefined,
        `Invalid session/list cursor: ${cursor}`
      );
    }

    return parsed;
  }

  private readSessionInfoUpdateTitle(params: Record<string, unknown>): string | undefined {
    if (typeof params.title === "string") {
      return params.title;
    }

    const update = asRecord(params.update);
    if (typeof update?.title === "string") {
      return update.title;
    }

    return undefined;
  }

  private readCancelRequestSessionId(params: Record<string, unknown>): string | undefined {
    const directSessionId = normalizeNonEmptyString(params.sessionId);
    if (directSessionId) {
      return directSessionId;
    }

    const meta = asRecord(params._meta);
    const muxMeta = asRecord(meta?.mux);
    return normalizeNonEmptyString(muxMeta?.sessionId ?? meta?.sessionId);
  }

  private subscribeToChat(workspaceId: string): void {
    const session = this.sessionManager.getSession(workspaceId);
    assert(session, `Cannot subscribe unknown session ${workspaceId}`);

    const run = async () => {
      try {
        const iterator = await this.deps.orpcClient.workspace.onChat(
          { workspaceId },
          { signal: session.abortController.signal }
        );

        for await (const event of iterator) {
          if (session.abortController.signal.aborted || this.deps.conn.signal.aborted) {
            return;
          }

          await this.handleChatEvent(workspaceId, event);
        }

        if (!session.abortController.signal.aborted && !this.deps.conn.signal.aborted) {
          // Subscription dropped — force-reject any pending prompt regardless
          // of message ID correlation (the entire stream is gone).
          this.sessionManager.markSubscriptionDead(workspaceId);
          this.forceRejectActivePrompt(
            workspaceId,
            new Error(`workspace.onChat ended unexpectedly for ${workspaceId}`)
          );
        }
      } catch (error) {
        if (session.abortController.signal.aborted || this.deps.conn.signal.aborted) {
          return;
        }

        this.deps.log("workspace.onChat subscription failed", workspaceId, error);
        this.sessionManager.markSubscriptionDead(workspaceId);
        this.forceRejectActivePrompt(
          workspaceId,
          new Error(`workspace.onChat failed: ${this.describeUnknownError(error)}`)
        );
      }
    };

    run().catch((error) => {
      this.deps.log("Unexpected subscribeToChat failure", workspaceId, error);
    });
  }

  private async handleChatEvent(workspaceId: string, event: WorkspaceChatMessage): Promise<void> {
    const session = this.sessionManager.getSession(workspaceId);
    if (!session) {
      return;
    }

    if (event.type === "caught-up") {
      this.sessionManager.markCaughtUp(workspaceId);
    }

    // Track history sequence for all stream-starts (replay or not) so the
    // prompt resolver can use it for correlation.
    if (event.type === "stream-start") {
      this.sessionManager.updateLastSeenHistorySequence(workspaceId, event.historySequence);
    }

    // Bind the prompt resolver to the first stream-start (replay or live)
    // whose historySequence exceeds the snapshot taken when the prompt was
    // created. Replayed stream-start events can arrive before live events after
    // load/new session startup; historySequence + first-write-wins guards in
    // updatePromptMessageId keep this correlation safe.
    if (event.type === "stream-start") {
      this.sessionManager.updatePromptMessageId(
        workspaceId,
        event.messageId,
        event.historySequence
      );
    }

    for (const update of translateMuxEvent(event)) {
      await this.deps.conn.sessionUpdate({
        sessionId: workspaceId,
        update,
      });
    }

    if (event.type === "stream-end") {
      const usage = event.metadata.usage ? translateUsage(event.metadata.usage) : undefined;
      this.resolvePrompt(workspaceId, event.messageId, {
        stopReason: "end_turn",
        ...(usage ? { usage } : {}),
      });
      return;
    }

    if (event.type === "stream-abort") {
      const usage = event.metadata?.usage ? translateUsage(event.metadata.usage) : undefined;
      this.resolvePrompt(workspaceId, event.messageId, {
        stopReason: "cancelled",
        ...(usage ? { usage } : {}),
      });
      return;
    }

    if (event.type === "stream-error") {
      this.rejectPrompt(workspaceId, event.messageId, new Error(event.error));
    }
  }

  private resolvePrompt(
    sessionId: string,
    messageId: string | undefined,
    response: acpSchema.PromptResponse
  ): void {
    const session = this.sessionManager.getSession(sessionId);
    const promptResolver = session?.promptResolver;

    if (!promptResolver) {
      return;
    }

    if (!this.matchesPromptMessage(promptResolver.messageId, messageId)) {
      return;
    }

    this.sessionManager.clearPromptResolver(sessionId);
    promptResolver.resolve(response);
  }

  private rejectPrompt(sessionId: string, messageId: string | undefined, error: Error): void {
    const session = this.sessionManager.getSession(sessionId);
    const promptResolver = session?.promptResolver;

    if (!promptResolver) {
      return;
    }

    if (!this.matchesPromptMessage(promptResolver.messageId, messageId)) {
      return;
    }

    this.sessionManager.clearPromptResolver(sessionId);
    promptResolver.reject(error);
  }

  /**
   * Unconditionally reject the active prompt for a session, bypassing message
   * ID correlation. Used for subscription-level failures (onChat dropped or
   * errored) where the entire stream is gone and any pending prompt must fail.
   */
  private forceRejectActivePrompt(sessionId: string, error: Error): void {
    const session = this.sessionManager.getSession(sessionId);
    const promptResolver = session?.promptResolver;

    if (!promptResolver) {
      return;
    }

    this.sessionManager.clearPromptResolver(sessionId);
    promptResolver.reject(error);
  }

  private matchesPromptMessage(
    activeMessageId: string,
    eventMessageId: string | undefined
  ): boolean {
    // Require a concrete message ID on both sides before matching.
    // When the prompt resolver's messageId is still empty (stream-start has not
    // yet arrived for *this* prompt), we must not let a prior stream's
    // stream-end/stream-abort settle this prompt.  Once stream-start sets the
    // resolver's messageId, subsequent events are matched strictly.
    if (activeMessageId.length === 0) {
      return false;
    }

    if (eventMessageId == null || eventMessageId.length === 0) {
      return false;
    }

    return activeMessageId === eventMessageId;
  }

  private async getModeOptions(projectPath: string, workspaceId?: string): Promise<ModeOption[]> {
    assert(projectPath.length > 0, "projectPath must be non-empty");

    let descriptors: AgentDescriptor[] = [];
    try {
      descriptors = workspaceId
        ? await this.deps.orpcClient.agents.list({ workspaceId })
        : await this.deps.orpcClient.agents.list({ projectPath });
    } catch (error) {
      this.deps.log("agents.list failed; falling back to default mode list", error);
      return [
        {
          id: DEFAULT_AGENT_ID,
          name: "Exec",
          description: "Default Mux execution agent",
        },
      ];
    }

    const selectable = descriptors.filter((descriptor) => descriptor.uiSelectable);
    const candidateModes = selectable.length > 0 ? selectable : descriptors;

    const seen = new Set<string>();
    const options: ModeOption[] = [];
    for (const descriptor of candidateModes) {
      if (seen.has(descriptor.id)) {
        continue;
      }
      seen.add(descriptor.id);
      options.push({
        id: descriptor.id,
        name: descriptor.name,
        description: descriptor.description,
      });
    }

    if (options.length === 0) {
      return [
        {
          id: DEFAULT_AGENT_ID,
          name: "Exec",
          description: "Default Mux execution agent",
        },
      ];
    }

    return options;
  }

  private buildModes(
    modeOptions: ModeOption[],
    currentAgentId: string
  ): acpSchema.SessionModeState {
    assert(modeOptions.length > 0, "buildModes requires at least one mode option");

    const availableModes = modeOptions.map((option) => ({
      id: option.id,
      name: option.name,
      ...(option.description ? { description: option.description } : {}),
    }));

    const currentModeId =
      modeOptions.find((option) => option.id === currentAgentId)?.id ??
      modeOptions[0]?.id ??
      DEFAULT_AGENT_ID;

    return {
      availableModes,
      currentModeId,
    };
  }

  private buildConfigOptions(
    modeOptions: ModeOption[],
    current: {
      agentId: string;
      model: string;
      thinkingLevel: ThinkingLevel;
    }
  ): acpSchema.SessionConfigOption[] {
    const modeValueIds = new Set(modeOptions.map((mode) => mode.id));

    const normalizedAgentId = modeValueIds.has(current.agentId)
      ? current.agentId
      : (modeOptions[0]?.id ?? DEFAULT_AGENT_ID);

    const modelOptions = this.getModelOptions(current.model);

    return [
      {
        type: "select",
        id: CONFIG_ID_AGENT_ID,
        name: "Agent",
        category: "mode",
        currentValue: normalizedAgentId,
        options: modeOptions.map((mode) => ({
          name: mode.name,
          value: mode.id,
          ...(mode.description ? { description: mode.description } : {}),
        })),
      },
      {
        type: "select",
        id: CONFIG_ID_MODEL,
        name: "Model",
        category: "model",
        currentValue: modelOptions.currentValue,
        options: modelOptions.options,
      },
      {
        type: "select",
        id: CONFIG_ID_THINKING_LEVEL,
        name: "Thinking level",
        category: "thought_level",
        currentValue: current.thinkingLevel,
        options: THINKING_LEVELS.map((thinkingLevel) => ({
          name: thinkingLevel,
          value: thinkingLevel,
        })),
      },
    ];
  }

  private getModelOptions(currentModel: string): {
    currentValue: string;
    options: Array<{ name: string; value: string; description?: string }>;
  } {
    const knownModels = Object.values(KNOWN_MODELS)
      .map((model) => ({
        name: model.id,
        value: model.id,
        description: model.provider,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const knownModelIds = new Set<string>(knownModels.map((model) => model.value));
    if (knownModelIds.has(currentModel)) {
      return {
        currentValue: currentModel,
        options: knownModels,
      };
    }

    return {
      currentValue: currentModel,
      options: [
        {
          name: `${currentModel} (current)`,
          value: currentModel,
          description: "Currently configured model",
        },
        ...knownModels,
      ],
    };
  }

  private knownModelIds(): Set<string> {
    return new Set<string>(Object.values(KNOWN_MODELS).map((model) => model.id));
  }

  private async maybeGenerateName(session: SessionState, message: string): Promise<void> {
    const trimmedMessage = message.trim();
    if (trimmedMessage.length === 0) {
      return;
    }

    const candidateSet = new Set<string>([session.model, this.defaultModel()]);

    const generationResult = await this.deps.orpcClient.nameGeneration.generate({
      message: trimmedMessage,
      candidates: Array.from(candidateSet),
    });

    if (!generationResult.success) {
      this.deps.log("nameGeneration.generate failed", generationResult.error);
      return;
    }

    const renameResult = await this.deps.orpcClient.workspace.rename({
      workspaceId: session.workspaceId,
      newName: generationResult.data.name,
    });

    if (!renameResult.success) {
      this.deps.log("workspace.rename failed during ACP name generation", renameResult.error);
    }

    const titleResult = await this.deps.orpcClient.workspace.updateTitle({
      workspaceId: session.workspaceId,
      title: generationResult.data.title,
    });

    if (!titleResult.success) {
      this.deps.log("workspace.updateTitle failed during ACP name generation", titleResult.error);
    }
  }

  private parseMuxMeta(meta: Record<string, unknown> | null | undefined): ParsedMuxMeta {
    const metaRecord = asRecord(meta);
    const nestedMux = asRecord(metaRecord?.mux);

    const readMuxString = (key: string): string | undefined => {
      return normalizeNonEmptyString(nestedMux?.[key] ?? metaRecord?.[`mux.${key}`]);
    };

    const thinkingLevelCandidate = readMuxString("thinkingLevel");

    return {
      projectPath: readMuxString("projectPath"),
      branchName: readMuxString("branchName"),
      trunkBranch: readMuxString("trunkBranch"),
      title: readMuxString("title"),
      sectionId: readMuxString("sectionId"),
      runtimeConfig: this.parseRuntimeConfig(
        nestedMux?.runtimeConfig ?? metaRecord?.["mux.runtimeConfig"]
      ),
      agentId: this.resolveAgentId(readMuxString("agentId")),
      model: readMuxString("model"),
      thinkingLevel: this.resolveThinkingLevel(thinkingLevelCandidate),
    };
  }

  private parseRuntimeConfig(raw: unknown): RuntimeConfig | undefined {
    const record = asRecord(raw);
    if (!record) {
      return undefined;
    }

    if (typeof record.type !== "string") {
      return undefined;
    }

    return record as RuntimeConfig;
  }

  private async persistAiSettings(
    workspaceId: string,
    agentId: string,
    model: string,
    thinkingLevel: ThinkingLevel
  ): Promise<void> {
    try {
      const result = await this.deps.orpcClient.workspace.updateAgentAISettings({
        workspaceId,
        agentId,
        aiSettings: { model, thinkingLevel },
      });

      if (!result.success) {
        this.deps.log("workspace.updateAgentAISettings returned error", result.error);
      }
    } catch (error) {
      this.deps.log("workspace.updateAgentAISettings failed", error);
    }
  }

  private resolveAgentId(candidate: string | undefined): string {
    if (
      candidate &&
      candidate.length <= MuxAcpAgent.MAX_AGENT_ID_LENGTH &&
      AGENT_ID_PATTERN.test(candidate)
    ) {
      return candidate;
    }
    return DEFAULT_AGENT_ID;
  }

  private resolveThinkingLevel(candidate: string | undefined): ThinkingLevel {
    if (candidate && isThinkingLevel(candidate)) {
      return candidate;
    }
    return DEFAULT_THINKING_LEVEL;
  }

  private defaultModel(): string {
    if (typeof DEFAULT_MODEL === "string" && DEFAULT_MODEL.length > 0) {
      return DEFAULT_MODEL;
    }

    const fallback = Object.values(KNOWN_MODELS)[0]?.id;
    assert(
      typeof fallback === "string" && fallback.length > 0,
      "At least one known model must be available for ACP"
    );
    return fallback;
  }

  private describeUnknownError(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }

    if (typeof error === "string") {
      return error;
    }

    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
}

function normalizeNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, unknown>;
}
