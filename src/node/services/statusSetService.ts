import type { Runtime } from "@/node/runtime/Runtime";
import { createRuntime } from "@/node/runtime/runtimeFactory";
import { getMuxEnv, getRuntimeType } from "@/node/runtime/initHook";
import { log } from "@/node/services/log";
import { StatusScriptPoller } from "@/node/services/statusScriptPoller";
import { SessionFileManager } from "@/node/utils/sessionFile";

import type { Config } from "@/node/config";
import type { StatusSetToolArgs } from "@/common/types/tools";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import type { RuntimeConfig } from "@/common/types/runtime";
import { secretsToRecord } from "@/common/types/secrets";
import type { Result } from "@/common/types/result";
import { Ok, Err } from "@/common/types/result";
import type { ParsedAgentStatus } from "@/common/utils/status/parseAgentStatus";

export type AgentStatus = ParsedAgentStatus;

export interface AgentStatusUpdateEvent {
  type: "agent-status-update";
  workspaceId: string;
  status: AgentStatus;
}

interface PersistedStatusSetState {
  version: 1;
  script: string;
  poll_interval_s?: number;
  lastStatus?: AgentStatus;
  updatedAt: string;
}

interface StatusSetRuntimeContext {
  runtime: Runtime;
  cwd: string;
  env: Record<string, string>;
}

interface PollerState {
  poller: StatusScriptPoller;
  lastStatus?: AgentStatus;
  lastPersisted?: PersistedStatusSetState;
  runtimeContext?: StatusSetRuntimeContext;
}

export class StatusSetService {
  private readonly file: SessionFileManager<PersistedStatusSetState>;
  private readonly pollersByWorkspaceId = new Map<string, PollerState>();

  constructor(
    private readonly config: Config,
    private readonly emitAIEvent: (event: string, payload: unknown) => void
  ) {
    // Must be initialized in the constructor so this.config is available.
    this.file = new SessionFileManager<PersistedStatusSetState>(this.config, "status_set.json");
  }

  getSnapshot(workspaceId: string): AgentStatusUpdateEvent | null {
    const state = this.pollersByWorkspaceId.get(workspaceId);
    if (!state?.lastStatus) {
      return null;
    }
    return { type: "agent-status-update", workspaceId, status: state.lastStatus };
  }

  stop(workspaceId: string): void {
    const state = this.pollersByWorkspaceId.get(workspaceId);
    if (!state) return;
    state.poller.stop();
    this.pollersByWorkspaceId.delete(workspaceId);
  }

  /**
   * Ensure any persisted status_set config is loaded and polling is started.
   *
   * This is what makes status_set robust to:
   * - backend restarts (config is reloaded from ~/.mux/sessions/{workspaceId}/status_set.json)
   * - renderer reloads (callers can request getSnapshot() on every subscribe)
   */
  async ensureRunning(workspaceId: string): Promise<void> {
    const state = this.getOrCreateState(workspaceId);

    if (state.lastPersisted && state.runtimeContext) {
      // Already configured and running (or attempted).
      return;
    }

    const persisted = await this.file.read(workspaceId);
    if (!persisted) {
      return;
    }

    state.lastPersisted = persisted;
    state.lastStatus = persisted.lastStatus;

    const ctxResult = await this.getRuntimeContextForWorkspace(workspaceId);
    if (!ctxResult.success) {
      log.debug("status_set: failed to create runtime context for persisted poller", {
        workspaceId,
        error: ctxResult.error,
      });
      return;
    }

    state.runtimeContext = ctxResult.data;

    log.debug("status_set: rehydrating", {
      workspaceId,
      poll_interval_s: persisted.poll_interval_s ?? 0,
    });

    state.poller.set({
      workspaceId,
      runtime: state.runtimeContext.runtime,
      cwd: state.runtimeContext.cwd,
      env: state.runtimeContext.env,
      script: persisted.script,
      pollIntervalMs: (persisted.poll_interval_s ?? 0) * 1000,
    });
  }

  async setFromToolCall(args: {
    workspaceId: string;
    toolArgs: StatusSetToolArgs;
    runtime: Runtime;
    cwd: string;
    env: Record<string, string>;
  }): Promise<Result<void, string>> {
    const persisted: PersistedStatusSetState = {
      version: 1,
      script: args.toolArgs.script,
      ...(args.toolArgs.poll_interval_s ? { poll_interval_s: args.toolArgs.poll_interval_s } : {}),
      // New script config: clear lastStatus so we don't show stale info on restart.
      lastStatus: undefined,
      updatedAt: new Date().toISOString(),
    };

    // Persist first so restarts are robust even if the app crashes after updating memory.
    const writeResult = await this.file.write(args.workspaceId, persisted);
    if (!writeResult.success) {
      return Err(writeResult.error);
    }

    const state = this.getOrCreateState(args.workspaceId);
    state.lastPersisted = persisted;
    state.lastStatus = undefined;
    state.runtimeContext = {
      runtime: args.runtime,
      cwd: args.cwd,
      env: args.env,
    };

    log.debug("status_set: configured", {
      workspaceId: args.workspaceId,
      poll_interval_s: persisted.poll_interval_s ?? 0,
    });

    state.poller.set({
      workspaceId: args.workspaceId,
      runtime: args.runtime,
      cwd: args.cwd,
      env: args.env,
      script: args.toolArgs.script,
      pollIntervalMs: (args.toolArgs.poll_interval_s ?? 0) * 1000,
    });

    return Ok(undefined);
  }

  private getOrCreateState(workspaceId: string): PollerState {
    const existing = this.pollersByWorkspaceId.get(workspaceId);
    if (existing) return existing;

    const poller = new StatusScriptPoller(async (status) => {
      await this.onStatus(workspaceId, status);
    });

    const state: PollerState = { poller };
    this.pollersByWorkspaceId.set(workspaceId, state);
    return state;
  }

  private async onStatus(workspaceId: string, status: AgentStatus): Promise<void> {
    const state = this.pollersByWorkspaceId.get(workspaceId);
    if (!state) return;

    state.lastStatus = status;

    // Persist the last known status so it can be shown immediately after restart.
    if (state.lastPersisted) {
      const nextPersisted: PersistedStatusSetState = {
        ...state.lastPersisted,
        lastStatus: status,
        updatedAt: new Date().toISOString(),
      };
      const result = await this.file.write(workspaceId, nextPersisted);
      if (result.success) {
        state.lastPersisted = nextPersisted;
      }
    }

    log.debug("status_set: emit", {
      workspaceId,
      message: status.message,
      url: status.url,
    });

    this.emitAIEvent("agent-status-update", {
      type: "agent-status-update",
      workspaceId,
      status,
    });
  }

  private async getRuntimeContextForWorkspace(
    workspaceId: string
  ): Promise<Result<StatusSetRuntimeContext, string>> {
    const metadata = await this.getWorkspaceMetadata(workspaceId);
    if (!metadata.success) {
      return Err(metadata.error);
    }

    const runtimeConfig: RuntimeConfig =
      metadata.data.runtimeConfig ?? ({ type: "local", srcBaseDir: this.config.srcDir } as const);

    let runtime: Runtime;
    try {
      runtime = createRuntime(runtimeConfig, { projectPath: metadata.data.projectPath });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Err(`Failed to create runtime: ${message}`);
    }

    const cwd = runtime.getWorkspacePath(metadata.data.projectPath, metadata.data.name);

    const projectSecrets = this.config.getProjectSecrets(metadata.data.projectPath);
    const env = {
      ...getMuxEnv(
        metadata.data.projectPath,
        getRuntimeType(metadata.data.runtimeConfig),
        metadata.data.name
      ),
      ...secretsToRecord(projectSecrets),
    };

    return Ok({ runtime, cwd, env });
  }

  private async getWorkspaceMetadata(
    workspaceId: string
  ): Promise<Result<FrontendWorkspaceMetadata, string>> {
    const allMetadata = await this.config.getAllWorkspaceMetadata();
    const found = allMetadata.find((m) => m.id === workspaceId);
    if (!found) {
      return Err(`Workspace metadata not found for ${workspaceId}`);
    }
    return Ok(found);
  }
}
