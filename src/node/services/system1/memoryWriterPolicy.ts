import * as os from "node:os";

import assert from "@/common/utils/assert";
import { buildProviderOptions } from "@/common/utils/ai/providerOptions";
import { enforceThinkingPolicy } from "@/common/utils/thinking/policy";

import type { ThinkingLevel } from "@/common/types/thinking";
import type { RuntimeConfig } from "@/common/types/runtime";
import type { MuxProviderOptions } from "@/common/types/providerOptions";
import { DEFAULT_TASK_SETTINGS, SYSTEM1_MEMORY_WRITER_LIMITS } from "@/common/types/tasks";

import type { Config } from "@/node/config";
import type { HistoryService } from "@/node/services/historyService";
import { log } from "@/node/services/log";
import { createRuntime } from "@/node/runtime/runtimeFactory";

import type { LanguageModel } from "ai";

import { runSystem1WriteProjectMemories } from "./system1MemoryWriter";

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
  system1Model?: string;
  system1ThinkingLevel?: ThinkingLevel;
  system1Enabled: boolean;
}

export type CreateModelFn = (
  modelString: string,
  muxProviderOptions: MuxProviderOptions
) => Promise<LanguageModel | undefined>;

export class MemoryWriterPolicy {
  private readonly turnsSinceLastRunByWorkspace = new Map<string, number>();
  private readonly inFlightByWorkspace = new Map<string, Promise<void>>();

  constructor(
    private readonly config: Pick<Config, "loadConfigOrDefault">,
    private readonly historyService: Pick<HistoryService, "getHistory">,
    private readonly createModel: CreateModelFn
  ) {
    assert(config, "MemoryWriterPolicy: config is required");
    assert(historyService, "MemoryWriterPolicy: historyService is required");
    assert(typeof createModel === "function", "MemoryWriterPolicy: createModel must be a function");
  }

  onAssistantStreamEnd(ctx: MemoryWriterStreamContext): Promise<void> | undefined {
    assert(ctx, "MemoryWriterPolicy.onAssistantStreamEnd: ctx is required");

    if (ctx.system1Enabled !== true) {
      return undefined;
    }

    // Avoid polluting project memories with child task workspaces.
    if (ctx.parentWorkspaceId) {
      return undefined;
    }

    const taskSettings = this.config.loadConfigOrDefault().taskSettings ?? DEFAULT_TASK_SETTINGS;
    const interval =
      taskSettings.memoryWriterIntervalMessages ??
      SYSTEM1_MEMORY_WRITER_LIMITS.memoryWriterIntervalMessages.default;

    if (!Number.isInteger(interval) || interval <= 0) {
      return undefined;
    }

    const prev = this.turnsSinceLastRunByWorkspace.get(ctx.workspaceId) ?? 0;
    const next = prev + 1;
    this.turnsSinceLastRunByWorkspace.set(ctx.workspaceId, next);

    const inFlight = this.inFlightByWorkspace.get(ctx.workspaceId);
    if (inFlight) {
      return undefined;
    }

    if (next < interval) {
      return undefined;
    }

    this.turnsSinceLastRunByWorkspace.set(ctx.workspaceId, 0);

    const runPromise = this.runOnce(ctx).finally(() => {
      const current = this.inFlightByWorkspace.get(ctx.workspaceId);
      if (current === runPromise) {
        this.inFlightByWorkspace.delete(ctx.workspaceId);
      }
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
      const historyResult = await this.historyService.getHistory(ctx.workspaceId);
      if (!historyResult.success) {
        workspaceLog.warn("[system1][memory] Failed to read history", {
          error: historyResult.error,
        });
        return;
      }

      const system1ModelString =
        typeof ctx.system1Model === "string" ? ctx.system1Model.trim() : "";
      const effectiveSystem1ModelString = system1ModelString || ctx.modelString;

      const effectiveThinkingLevel = enforceThinkingPolicy(
        effectiveSystem1ModelString,
        ctx.system1ThinkingLevel ?? "off"
      );

      const model = await this.createModel(effectiveSystem1ModelString, ctx.muxProviderOptions);
      if (!model) {
        workspaceLog.debug("[system1][memory] Skipping memory writer (model unavailable)", {
          system1Model: effectiveSystem1ModelString,
        });
        return;
      }

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
        const result = await runSystem1WriteProjectMemories({
          runtime,
          agentDiscoveryPath: workspacePath,
          runtimeTempDir: os.tmpdir(),
          model,
          modelString: effectiveSystem1ModelString,
          providerOptions,
          workspaceId: ctx.workspaceId,
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
          workspaceLog.debug("[system1][memory] Memory writer produced no output", {
            timedOut,
            system1Model: effectiveSystem1ModelString,
          });
          return;
        }

        workspaceLog.debug("[system1][memory] Memory writer completed", {
          timedOut,
          finishReason: result.finishReason,
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
