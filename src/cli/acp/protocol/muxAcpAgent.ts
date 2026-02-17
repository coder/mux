import { PROTOCOL_VERSION, type Agent, type AgentSideConnection } from "@agentclientprotocol/sdk";
import type * as schema from "@agentclientprotocol/sdk";
import type { RouterClient } from "@orpc/server";
import assert from "@/common/utils/assert";
import { log } from "@/node/services/log";
import { resolveModelAlias } from "@/common/utils/ai/models";
import type { AppRouter } from "@/node/orpc/router";
import { VERSION } from "@/version";
import {
  buildConfigOptionUpdate,
  buildConfigOptions,
  buildCurrentModeUpdate,
  buildModeState,
  buildModelState,
  MODEL_CONFIG_ID,
  THINKING_LEVEL_CONFIG_ID,
} from "../mappers/configOptions";
import { sendPromptToWorkspace } from "../mappers/prompt";
import {
  createWorkspaceBackedSession,
  forkWorkspaceBackedSession,
  listWorkspaceBackedSessions,
  loadWorkspaceBackedSession,
  resumeWorkspaceBackedSession,
} from "../mappers/workspace";
import { SessionStateMap, type SessionState } from "../sessionState";
import { pumpOnChatToAcpUpdates } from "../streamPump";

interface MuxAcpAgentOptions {
  unstable: boolean;
}

interface CombinedSignalHandle {
  signal: AbortSignal;
  dispose: () => void;
}

function buildAgentVersion(): string {
  const versionRecord = VERSION as Record<string, unknown>;
  const gitDescribe =
    typeof versionRecord.git_describe === "string" && versionRecord.git_describe.trim().length > 0
      ? versionRecord.git_describe
      : undefined;
  const gitCommit =
    typeof versionRecord.git_commit === "string" && versionRecord.git_commit.trim().length > 0
      ? versionRecord.git_commit
      : undefined;

  return gitDescribe ?? gitCommit ?? "unknown";
}

function combineAbortSignals(signals: readonly AbortSignal[]): CombinedSignalHandle {
  const controller = new AbortController();

  const callbacks = signals.map((signal) => {
    const onAbort = () => {
      controller.abort();
    };

    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }

    return { signal, onAbort };
  });

  return {
    signal: controller.signal,
    dispose: () => {
      for (const callback of callbacks) {
        callback.signal.removeEventListener("abort", callback.onAbort);
      }
    },
  };
}

function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") {
    return true;
  }

  if (error instanceof Error) {
    return error.name === "AbortError" || error.message.toLowerCase().includes("abort");
  }

  return false;
}

function parseModelId(value: string): string {
  const normalized = resolveModelAlias(value.trim());
  assert(normalized.length > 0, "model id must be non-empty");
  return normalized;
}

function parseModeId(value: string): SessionState["modeId"] {
  const normalized = value.trim().toLowerCase();
  if (normalized === "exec" || normalized === "plan") {
    return normalized;
  }

  throw new Error(`Unsupported mode "${value}". Expected "exec" or "plan".`);
}

function parseThinkingLevel(value: string): SessionState["thinkingLevel"] {
  const normalized = value.trim().toLowerCase();

  switch (normalized) {
    case "off":
    case "low":
    case "medium":
    case "high":
    case "xhigh":
    case "max":
      return normalized;
    case "med":
      return "medium";
    default:
      throw new Error(
        `Unsupported thinking level "${value}". Expected off|low|med|medium|high|max|xhigh.`
      );
  }
}

export class MuxAcpAgent implements Agent {
  private readonly sessions = new SessionStateMap();
  private readonly agentVersion = buildAgentVersion();

  constructor(
    private readonly conn: AgentSideConnection,
    private readonly orpcClient: RouterClient<AppRouter>,
    private readonly options: MuxAcpAgentOptions
  ) {}

  private assertUnstableEnabled(methodName: string): void {
    if (!this.options.unstable) {
      throw new Error(
        `${methodName} requires unstable ACP methods. Restart with --acp-unstable to enable it.`
      );
    }
  }

  private buildSessionStatePayload(session: SessionState): {
    configOptions: schema.SessionConfigOption[];
    modes: schema.SessionModeState;
    models?: schema.SessionModelState;
  } {
    const payload = {
      configOptions: buildConfigOptions(session),
      modes: buildModeState(session),
      models: this.options.unstable ? buildModelState(session) : undefined,
    };

    return payload;
  }

  private async emitModeAndConfigUpdates(session: SessionState): Promise<void> {
    await this.conn.sessionUpdate({
      sessionId: session.sessionId,
      update: {
        sessionUpdate: "current_mode_update",
        ...buildCurrentModeUpdate(session.modeId),
      },
    });

    await this.conn.sessionUpdate({
      sessionId: session.sessionId,
      update: {
        sessionUpdate: "config_option_update",
        ...buildConfigOptionUpdate(session),
      },
    });
  }

  private async persistSessionAISettings(session: SessionState): Promise<void> {
    const aiSettings = {
      model: session.modelId,
      thinkingLevel: session.thinkingLevel,
    } as const;

    const updateResult = await this.orpcClient.workspace.updateAgentAISettings({
      workspaceId: session.workspaceId,
      agentId: session.modeId,
      aiSettings,
    });

    if (!updateResult.success) {
      throw new Error(`workspace.updateAgentAISettings failed: ${updateResult.error}`);
    }

    // Keep the local snapshot in sync so mode switches restore the latest
    // user-chosen values rather than stale creation-time defaults.
    session.aiSettingsByAgent ??= {};
    (session.aiSettingsByAgent as Record<string, typeof aiSettings>)[session.modeId] = aiSettings;
  }

  /**
   * Restore per-mode AI defaults from the workspace metadata snapshot.
   * Called on mode switch so that the session reflects the new mode's
   * saved model/thinkingLevel rather than carrying over the previous mode's values.
   */
  private applyPerModeAiDefaults(session: SessionState): void {
    const byAgent = session.aiSettingsByAgent?.[session.modeId];
    if (byAgent) {
      session.modelId = resolveModelAlias(byAgent.model);
      session.thinkingLevel = byAgent.thinkingLevel;
    } else {
      // No per-mode override exists — restore the workspace's persisted base
      // defaults so the previous mode's values are not accidentally carried forward.
      // Uses the user's configured baseline (from metadata.aiSettings) rather than
      // the hard-coded defaultModel/"off", preserving their preferences.
      session.modelId = session.defaultModelId;
      session.thinkingLevel = session.defaultThinkingLevel;
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- Agent interface requires Promise return
  async initialize(_params: schema.InitializeRequest): Promise<schema.InitializeResponse> {
    const sessionCapabilities: schema.SessionCapabilities = {};
    if (this.options.unstable) {
      sessionCapabilities.fork = {};
      sessionCapabilities.list = {};
      sessionCapabilities.resume = {};
    }

    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: {
          embeddedContext: true,
        },
        sessionCapabilities,
      },
      agentInfo: {
        name: "mux",
        version: this.agentVersion,
      },
    };
  }

  async newSession(params: schema.NewSessionRequest): Promise<schema.NewSessionResponse> {
    const session = await createWorkspaceBackedSession(this.orpcClient, params);
    this.sessions.set(session.sessionId, session);

    return {
      sessionId: session.sessionId,
      ...this.buildSessionStatePayload(session),
    };
  }

  async loadSession(params: schema.LoadSessionRequest): Promise<schema.LoadSessionResponse> {
    const existingSession = this.sessions.get(params.sessionId);
    if (existingSession) {
      if (existingSession.projectPath !== params.cwd) {
        throw new Error(
          `Session ${params.sessionId} already loaded for ${existingSession.projectPath}, requested ${params.cwd}`
        );
      }

      return this.buildSessionStatePayload(existingSession);
    }

    const session = await loadWorkspaceBackedSession(this.orpcClient, params);
    this.sessions.set(session.sessionId, session);

    return this.buildSessionStatePayload(session);
  }

  async unstable_forkSession(
    params: schema.ForkSessionRequest
  ): Promise<schema.ForkSessionResponse> {
    this.assertUnstableEnabled("session/fork");

    const sourceSession = this.sessions.get(params.sessionId);
    const forkedSession = await forkWorkspaceBackedSession(this.orpcClient, params, sourceSession);

    this.sessions.set(forkedSession.sessionId, forkedSession);

    return {
      sessionId: forkedSession.sessionId,
      ...this.buildSessionStatePayload(forkedSession),
    };
  }

  async unstable_listSessions(
    params: schema.ListSessionsRequest
  ): Promise<schema.ListSessionsResponse> {
    this.assertUnstableEnabled("session/list");
    return listWorkspaceBackedSessions(this.orpcClient, params);
  }

  async unstable_resumeSession(
    params: schema.ResumeSessionRequest
  ): Promise<schema.ResumeSessionResponse> {
    this.assertUnstableEnabled("session/resume");

    const existingSession = this.sessions.get(params.sessionId);
    if (existingSession) {
      if (existingSession.projectPath !== params.cwd) {
        throw new Error(
          `Session ${params.sessionId} already loaded for ${existingSession.projectPath}, requested ${params.cwd}`
        );
      }

      return this.buildSessionStatePayload(existingSession);
    }

    const resumedSession = await resumeWorkspaceBackedSession(this.orpcClient, params);
    this.sessions.set(resumedSession.sessionId, resumedSession);

    return this.buildSessionStatePayload(resumedSession);
  }

  async setSessionMode(
    params: schema.SetSessionModeRequest
  ): Promise<schema.SetSessionModeResponse> {
    const session = this.sessions.require(params.sessionId);
    const nextModeId = parseModeId(params.modeId);

    if (session.modeId === nextModeId) {
      return {};
    }

    session.modeId = nextModeId;
    // Restore the new mode's persisted AI defaults so subsequent prompts use the
    // correct model/thinking for this mode rather than the previous mode's settings.
    this.applyPerModeAiDefaults(session);
    await this.emitModeAndConfigUpdates(session);

    return {};
  }

  async unstable_setSessionModel(
    params: schema.SetSessionModelRequest
  ): Promise<schema.SetSessionModelResponse> {
    this.assertUnstableEnabled("session/set_model");

    const session = this.sessions.require(params.sessionId);
    const nextModelId = parseModelId(params.modelId);

    if (session.modelId === nextModelId) {
      return {};
    }

    session.modelId = nextModelId;
    await this.persistSessionAISettings(session);

    await this.conn.sessionUpdate({
      sessionId: session.sessionId,
      update: {
        sessionUpdate: "config_option_update",
        ...buildConfigOptionUpdate(session),
      },
    });

    return {};
  }

  async setSessionConfigOption(
    params: schema.SetSessionConfigOptionRequest
  ): Promise<schema.SetSessionConfigOptionResponse> {
    const session = this.sessions.require(params.sessionId);

    let persistAiSettings = false;
    let emitModeUpdate = false;

    switch (params.configId) {
      case MODEL_CONFIG_ID: {
        const nextModelId = parseModelId(params.value);
        if (session.modelId !== nextModelId) {
          session.modelId = nextModelId;
          persistAiSettings = true;
        }
        break;
      }

      case THINKING_LEVEL_CONFIG_ID: {
        const nextThinkingLevel = parseThinkingLevel(params.value);
        if (session.thinkingLevel !== nextThinkingLevel) {
          session.thinkingLevel = nextThinkingLevel;
          persistAiSettings = true;
        }
        break;
      }

      case "mode": {
        const nextModeId = parseModeId(params.value);
        if (session.modeId !== nextModeId) {
          session.modeId = nextModeId;
          // Restore the new mode's persisted AI defaults so subsequent prompts
          // use the correct model/thinking rather than the previous mode's settings.
          this.applyPerModeAiDefaults(session);
          emitModeUpdate = true;
        }
        break;
      }

      default:
        throw new Error(
          `Unknown config option "${params.configId}". Supported options: ${MODEL_CONFIG_ID}, ${THINKING_LEVEL_CONFIG_ID}, mode`
        );
    }

    if (persistAiSettings) {
      await this.persistSessionAISettings(session);
    }

    if (emitModeUpdate) {
      await this.conn.sessionUpdate({
        sessionId: session.sessionId,
        update: {
          sessionUpdate: "current_mode_update",
          ...buildCurrentModeUpdate(session.modeId),
        },
      });
    }

    await this.conn.sessionUpdate({
      sessionId: session.sessionId,
      update: {
        sessionUpdate: "config_option_update",
        ...buildConfigOptionUpdate(session),
      },
    });

    return {
      configOptions: buildConfigOptions(session),
    };
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- Agent interface requires Promise return
  async authenticate(_params: schema.AuthenticateRequest): Promise<schema.AuthenticateResponse> {
    return {};
  }

  async prompt(params: schema.PromptRequest): Promise<schema.PromptResponse> {
    const session = this.sessions.require(params.sessionId);

    // Always interrupt the backend workspace stream before sending a new prompt.
    // This handles both locally-tracked ACP prompts (via activePromptAbort) and
    // externally-started streams (e.g., workspace loaded from another client/process).
    // Without this, sendMessage may queue behind the existing stream and the pump
    // could resolve on the old stream's terminal event instead of the new prompt's.
    try {
      const interruptResult = await this.orpcClient.workspace.interruptStream({
        workspaceId: session.workspaceId,
      });
      if (!interruptResult.success) {
        log.debug(
          `[acp] workspace.interruptStream failed for ${session.workspaceId}: ${interruptResult.error ?? "unknown"}`
        );
      }
    } catch {
      // RPC transport error — backend may already be idle or unreachable.
      log.debug(`[acp] workspace.interruptStream threw for ${session.workspaceId}`);
    }

    if (session.activePromptAbort) {
      session.activePromptAbort.abort();
    }

    const promptAbort = new AbortController();
    session.activePromptAbort = promptAbort;

    const combinedSignal = combineAbortSignals([promptAbort.signal, this.conn.signal]);

    try {
      const streamResult = await pumpOnChatToAcpUpdates({
        client: this.orpcClient,
        conn: this.conn,
        session,
        unstableEnabled: this.options.unstable,
        signal: combinedSignal.signal,
        onReady: async () => {
          // Guard against cancellation that arrived during the caught-up wait.
          // Without this check, sendMessage could start a new backend stream
          // after the ACP prompt has already been cancelled.
          if (combinedSignal.signal.aborted) {
            return;
          }
          await sendPromptToWorkspace(this.orpcClient, session, params);
        },
      });

      return {
        stopReason: streamResult.stopReason,
      };
    } catch (error) {
      if (combinedSignal.signal.aborted || isAbortError(error)) {
        return {
          stopReason: "cancelled",
        };
      }

      throw error;
    } finally {
      combinedSignal.dispose();
      if (session.activePromptAbort === promptAbort) {
        session.activePromptAbort = undefined;
      }
    }
  }

  async cancel(params: schema.CancelNotification): Promise<void> {
    const session = this.sessions.get(params.sessionId);
    if (!session) {
      return;
    }

    session.activePromptAbort?.abort();

    // Best-effort interrupt — a transport error during cancel should not
    // tear down the ACP connection (consistent with prompt preemption path).
    try {
      const interruptResult = await this.orpcClient.workspace.interruptStream({
        workspaceId: session.workspaceId,
      });

      if (!interruptResult.success) {
        log.debug(
          `[acp] cancel: workspace.interruptStream failed for ${session.workspaceId}: ${interruptResult.error ?? "unknown"}`
        );
      }
    } catch {
      log.debug(`[acp] cancel: workspace.interruptStream threw for ${session.workspaceId}`);
    }
  }
}
