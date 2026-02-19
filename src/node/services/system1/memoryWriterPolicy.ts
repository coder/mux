import * as os from "node:os";

import assert from "@/common/utils/assert";
import { buildProviderOptions } from "@/common/utils/ai/providerOptions";
import { enforceThinkingPolicy } from "@/common/utils/thinking/policy";

import type { RuntimeConfig } from "@/common/types/runtime";
import type { MuxProviderOptions } from "@/common/types/providerOptions";
import { DEFAULT_TASK_SETTINGS, SYSTEM1_MEMORY_WRITER_LIMITS } from "@/common/types/tasks";
import type { ThinkingLevel } from "@/common/types/thinking";

import type { Config } from "@/node/config";
import type { HistoryService } from "@/node/services/historyService";
import { SessionFileManager } from "@/node/utils/sessionFile";
import { log } from "@/node/services/log";
import { createRuntime } from "@/node/runtime/runtimeFactory";

import type { LanguageModel } from "ai";

import {
  runSystem1WriteProjectMemories,
  type System1MemoryWriterRunResult,
} from "./system1MemoryWriter";

const SYSTEM1_MEMORY_WRITER_AGENT_ID = "system1_memory_writer";

const MEMORY_WRITER_STATE_FILE_NAME = "system1-memory-writer-state.json" as const;

interface MemoryWriterSchedulingState {
  schemaVersion: 1;
  turnsSinceLastRun: number;
  lastRunStartedAt?: number;
  lastRunCompletedAt?: number;
  lastRunMessageId?: string;
}

const DEFAULT_MEMORY_WRITER_SCHEDULING_STATE: MemoryWriterSchedulingState = {
  schemaVersion: 1,
  turnsSinceLastRun: 0,
};

function coerceMemoryWriterSchedulingState(raw: unknown): MemoryWriterSchedulingState {
  if (!raw || typeof raw !== "object") {
    return { ...DEFAULT_MEMORY_WRITER_SCHEDULING_STATE };
  }

  const record = raw as Record<string, unknown>;

  const turnsRaw = record.turnsSinceLastRun;
  const turnsSinceLastRun =
    typeof turnsRaw === "number" && Number.isFinite(turnsRaw) && turnsRaw > 0
      ? Math.floor(turnsRaw)
      : 0;

  const startedAtRaw = record.lastRunStartedAt;
  const lastRunStartedAt =
    typeof startedAtRaw === "number" && Number.isFinite(startedAtRaw) ? startedAtRaw : undefined;

  const completedAtRaw = record.lastRunCompletedAt;
  const lastRunCompletedAt =
    typeof completedAtRaw === "number" && Number.isFinite(completedAtRaw)
      ? completedAtRaw
      : undefined;

  const messageIdRaw = record.lastRunMessageId;
  const lastRunMessageId =
    typeof messageIdRaw === "string" && messageIdRaw.trim().length > 0
      ? messageIdRaw.trim()
      : undefined;

  return {
    schemaVersion: 1,
    turnsSinceLastRun: Math.max(0, turnsSinceLastRun),
    lastRunStartedAt,
    lastRunCompletedAt,
    lastRunMessageId,
  };
}
export interface MemoryWriterStreamContext {
  workspaceId: string;
  messageId: string;
  workspaceName: string;
  projectPath: string;
  runtimeConfig: RuntimeConfig;
  parentWorkspaceId?: string;

  // Stream options (captured at send time)
  modelString: string;
  muxProviderOptions: MuxProviderOptions;
  system1Enabled: boolean;
}

export type ResolveModelFn = (
  modelString: string,
  thinkingLevel: ThinkingLevel,
  muxProviderOptions: MuxProviderOptions
) => Promise<
  | {
      model: LanguageModel;
      effectiveModelString: string;
    }
  | undefined
>;

export class MemoryWriterPolicy {
  private readonly stateByWorkspace = new Map<string, MemoryWriterSchedulingState>();
  private readonly queueByWorkspace = new Map<string, Promise<void>>();
  private readonly inFlightByWorkspace = new Map<string, Promise<void>>();
  // Tracks the latest resolved System 1 gate from stream contexts per workspace.
  // Deferred runs re-check this value at execution time instead of trusting any
  // cached context that may have gone stale.
  private readonly system1EnabledByWorkspace = new Map<string, boolean>();
  // Keep the most recent eligible stream context so we can trigger a deferred run
  // when turns reach the interval while another run is still in-flight.
  private readonly latestContextByWorkspace = new Map<string, MemoryWriterStreamContext>();
  private readonly stateFileManager: SessionFileManager<MemoryWriterSchedulingState>;

  constructor(
    private readonly config: Pick<Config, "getSessionDir" | "loadConfigOrDefault">,
    private readonly historyService: Pick<HistoryService, "getHistoryFromLatestBoundary">,
    private readonly resolveModel: ResolveModelFn
  ) {
    assert(config, "MemoryWriterPolicy: config is required");
    assert(historyService, "MemoryWriterPolicy: historyService is required");
    assert(
      typeof resolveModel === "function",
      "MemoryWriterPolicy: resolveModel must be a function"
    );

    this.stateFileManager = new SessionFileManager(config, MEMORY_WRITER_STATE_FILE_NAME);
  }

  async onAssistantStreamEnd(ctx: MemoryWriterStreamContext): Promise<void> {
    assert(ctx, "MemoryWriterPolicy.onAssistantStreamEnd: ctx is required");

    const workspaceLog = log.withFields({
      workspaceId: ctx.workspaceId,
      workspaceName: ctx.workspaceName,
      messageId: ctx.messageId,
    });

    this.system1EnabledByWorkspace.set(ctx.workspaceId, ctx.system1Enabled === true);

    if (ctx.system1Enabled !== true) {
      // Clear any stale eligible context so an in-flight run completion cannot
      // schedule a deferred run after the user opts out.
      this.latestContextByWorkspace.delete(ctx.workspaceId);
      workspaceLog.debug("[system1][memory] Skipping memory writer scheduling (System 1 disabled)");
      return;
    }

    // Avoid polluting project memories with child task workspaces.
    if (ctx.parentWorkspaceId) {
      // Defensive: child workspaces should never inherit a previous eligible
      // context from the same workspace ID.
      this.latestContextByWorkspace.delete(ctx.workspaceId);
      workspaceLog.debug("[system1][memory] Skipping memory writer scheduling (child workspace)", {
        parentWorkspaceId: ctx.parentWorkspaceId,
      });
      return;
    }

    const taskSettings = this.config.loadConfigOrDefault().taskSettings ?? DEFAULT_TASK_SETTINGS;
    const interval =
      taskSettings.memoryWriterIntervalMessages ??
      SYSTEM1_MEMORY_WRITER_LIMITS.memoryWriterIntervalMessages.default;

    if (!Number.isInteger(interval) || interval <= 0) {
      workspaceLog.debug("[system1][memory] Skipping memory writer scheduling (invalid interval)", {
        interval,
      });
      return;
    }

    // Store the latest eligible context so we can run immediately after an
    // in-flight memory writer completes, without waiting for another message.
    this.latestContextByWorkspace.set(ctx.workspaceId, ctx);

    const scheduleResult = await this.enqueueWorkspaceUpdate(
      ctx.workspaceId,
      "assistant-stream-end",
      () => this.scheduleStreamEnd(ctx, interval),
      {}
    );

    if (scheduleResult.runPromise) {
      await scheduleResult.runPromise;
    }
  }

  private enqueueWorkspaceUpdate<T>(
    workspaceId: string,
    opName: string,
    op: () => Promise<T>,
    fallback: T
  ): Promise<T> {
    const prev = this.queueByWorkspace.get(workspaceId) ?? Promise.resolve();

    const next = prev
      .catch(() => undefined)
      .then(async () => {
        try {
          return await op();
        } catch (error) {
          log.debug("[system1][memory] Memory writer scheduling op failed", {
            workspaceId,
            opName,
            error: error instanceof Error ? error.message : String(error),
          });
          return fallback;
        }
      });

    const completion = next.then(
      () => undefined,
      () => undefined
    );
    this.queueByWorkspace.set(workspaceId, completion);

    void completion.finally(() => {
      const current = this.queueByWorkspace.get(workspaceId);
      if (current === completion) {
        this.queueByWorkspace.delete(workspaceId);
      }
    });

    return next;
  }

  private async getOrLoadState(workspaceId: string): Promise<MemoryWriterSchedulingState> {
    const cached = this.stateByWorkspace.get(workspaceId);
    if (cached) {
      return cached;
    }

    const raw = await this.stateFileManager.read(workspaceId);
    const state = coerceMemoryWriterSchedulingState(raw);
    this.stateByWorkspace.set(workspaceId, state);
    return state;
  }

  private async persistState(
    workspaceId: string,
    state: MemoryWriterSchedulingState
  ): Promise<void> {
    const result = await this.stateFileManager.write(workspaceId, state);
    if (!result.success) {
      log.debug("[system1][memory] Failed to persist memory writer schedule state", {
        workspaceId,
        error: result.error,
      });
    }
  }

  private async scheduleStreamEnd(
    ctx: MemoryWriterStreamContext,
    interval: number
  ): Promise<{ runPromise?: Promise<void> }> {
    const state = await this.getOrLoadState(ctx.workspaceId);

    const hasIncompleteRun =
      typeof state.lastRunStartedAt === "number" &&
      (typeof state.lastRunCompletedAt !== "number" ||
        state.lastRunCompletedAt < state.lastRunStartedAt);

    if (hasIncompleteRun) {
      // Restart-safe: if the last run started but never recorded completion,
      // assume we crashed mid-run and make the next message trigger a run.
      state.turnsSinceLastRun = Math.max(state.turnsSinceLastRun, interval - 1);
    }

    state.turnsSinceLastRun += 1;

    const inFlight = this.inFlightByWorkspace.get(ctx.workspaceId);
    if (inFlight) {
      await this.persistState(ctx.workspaceId, state);
      return {};
    }

    if (state.turnsSinceLastRun < interval) {
      await this.persistState(ctx.workspaceId, state);
      return {};
    }

    const { runPromise } = await this.startScheduledRun(ctx, state);
    return { runPromise };
  }

  private async startScheduledRun(
    ctx: MemoryWriterStreamContext,
    state: MemoryWriterSchedulingState
  ): Promise<{ runPromise: Promise<void> }> {
    // Wrap the run promise so queue-serialized callers can await schedule setup
    // (state persistence + run start) without accidentally awaiting run completion.
    // Awaiting completion inside the queue operation can deadlock against run-finally
    // bookkeeping that is also queued.
    state.turnsSinceLastRun = 0;

    const runStartedAt = Date.now();
    state.lastRunStartedAt = runStartedAt;
    state.lastRunCompletedAt = undefined;
    state.lastRunMessageId = ctx.messageId;

    await this.persistState(ctx.workspaceId, state);

    const runPromise = this.startRun(ctx, runStartedAt);
    return { runPromise };
  }

  private async maybeStartDeferredRun(workspaceId: string): Promise<void> {
    const inFlight = this.inFlightByWorkspace.get(workspaceId);
    if (inFlight) {
      return;
    }

    const taskSettings = this.config.loadConfigOrDefault().taskSettings ?? DEFAULT_TASK_SETTINGS;
    const interval =
      taskSettings.memoryWriterIntervalMessages ??
      SYSTEM1_MEMORY_WRITER_LIMITS.memoryWriterIntervalMessages.default;

    if (!Number.isInteger(interval) || interval <= 0) {
      return;
    }

    const state = await this.getOrLoadState(workspaceId);
    if (state.turnsSinceLastRun < interval) {
      return;
    }

    const latestCtx = this.latestContextByWorkspace.get(workspaceId);
    if (!latestCtx) {
      return;
    }

    // Re-check the latest System 1 gate at execution time before launching a
    // deferred run from cached context.
    if (this.system1EnabledByWorkspace.get(workspaceId) !== true || latestCtx.parentWorkspaceId) {
      return;
    }

    await this.startScheduledRun(latestCtx, state);
  }

  private startRun(ctx: MemoryWriterStreamContext, runStartedAt: number): Promise<void> {
    const workspaceLog = log.withFields({
      workspaceId: ctx.workspaceId,
      workspaceName: ctx.workspaceName,
      messageId: ctx.messageId,
    });

    const runPromise = this.runOnce(ctx)
      .catch((error) => {
        workspaceLog.warn("[system1][memory] Memory writer run failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(async () => {
        await this.enqueueWorkspaceUpdate(
          ctx.workspaceId,
          "run-complete",
          async () => {
            const state = await this.getOrLoadState(ctx.workspaceId);
            if (state.lastRunStartedAt !== runStartedAt) {
              return;
            }

            state.lastRunCompletedAt = Date.now();
            await this.persistState(ctx.workspaceId, state);
          },
          undefined
        );

        const current = this.inFlightByWorkspace.get(ctx.workspaceId);
        if (current === runPromise) {
          this.inFlightByWorkspace.delete(ctx.workspaceId);
        }

        await this.enqueueWorkspaceUpdate(
          ctx.workspaceId,
          "maybe-start-deferred-run",
          async () => {
            await this.maybeStartDeferredRun(ctx.workspaceId);
          },
          undefined
        );
      });

    this.inFlightByWorkspace.set(ctx.workspaceId, runPromise);
    return runPromise;
  }

  private async runOnce(ctx: MemoryWriterStreamContext): Promise<void> {
    const workspaceLog = log.withFields({
      workspaceId: ctx.workspaceId,
      workspaceName: ctx.workspaceName,
      messageId: ctx.messageId,
    });

    try {
      const historyResult = await this.historyService.getHistoryFromLatestBoundary(ctx.workspaceId);
      if (!historyResult.success) {
        workspaceLog.warn("[system1][memory] Failed to read history", {
          error: historyResult.error,
        });
        return;
      }

      const cfg = this.config.loadConfigOrDefault();

      const system1Defaults = cfg.agentAiDefaults?.[SYSTEM1_MEMORY_WRITER_AGENT_ID];
      const system1ModelOverride =
        typeof system1Defaults?.modelString === "string" ? system1Defaults.modelString.trim() : "";
      const system1ModelCandidate = system1ModelOverride || ctx.modelString;
      const trimmedSystem1ModelCandidate = system1ModelCandidate.trim();

      if (!trimmedSystem1ModelCandidate) {
        workspaceLog.debug("[system1][memory] Skipping memory writer (missing System1 model)");
        return;
      }

      const requestedThinkingLevel = system1Defaults?.thinkingLevel ?? "off";
      const effectiveThinkingLevel = enforceThinkingPolicy(
        trimmedSystem1ModelCandidate,
        requestedThinkingLevel
      );

      const resolvedModel = await this.resolveModel(
        trimmedSystem1ModelCandidate,
        effectiveThinkingLevel,
        ctx.muxProviderOptions
      );
      if (!resolvedModel) {
        workspaceLog.debug("[system1][memory] Skipping memory writer (model unavailable)", {
          system1Model: trimmedSystem1ModelCandidate,
          thinkingLevel: effectiveThinkingLevel,
        });
        return;
      }

      const { model, effectiveModelString: effectiveSystem1ModelString } = resolvedModel;

      // Tool-only request; we don't need message history for provider persistence.
      const providerOptions = buildProviderOptions(
        effectiveSystem1ModelString,
        effectiveThinkingLevel,
        undefined,
        undefined,
        ctx.muxProviderOptions,
        ctx.workspaceId
      ) as unknown as Record<string, unknown>;

      const runtime = createRuntime(ctx.runtimeConfig, {
        projectPath: ctx.projectPath,
        workspaceName: ctx.workspaceName,
      });

      const workspacePath = runtime.getWorkspacePath(ctx.projectPath, ctx.workspaceName);

      let timedOut = false;
      try {
        const result: System1MemoryWriterRunResult | undefined =
          await runSystem1WriteProjectMemories({
            runtime,
            agentDiscoveryPath: workspacePath,
            runtimeTempDir: os.tmpdir(),
            model,
            modelString: effectiveSystem1ModelString,
            providerOptions,
            workspaceId: ctx.workspaceId,
            triggerMessageId: ctx.messageId,
            workspaceName: ctx.workspaceName,
            projectPath: ctx.projectPath,
            workspacePath,
            history: historyResult.data,
            timeoutMs: 10_000,
            onTimeout: () => {
              timedOut = true;
            },
          });

        if (!result) {
          workspaceLog.debug(
            "[system1][memory] Memory writer exited without satisfying required tool policy",
            {
              timedOut,
              system1Model: effectiveSystem1ModelString,
            }
          );
          return;
        }

        workspaceLog.debug("[system1][memory] Memory writer completed", {
          timedOut,
          finishReason: result.finishReason,
          memoryAction: result.memoryAction,
          system1Model: effectiveSystem1ModelString,
        });
      } catch (error) {
        workspaceLog.warn("[system1][memory] Memory writer failed", {
          timedOut,
          system1Model: effectiveSystem1ModelString,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } catch (error) {
      workspaceLog.warn("[system1][memory] Memory writer failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
