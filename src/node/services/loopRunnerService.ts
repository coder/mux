import { EventEmitter } from "events";
import * as fsPromises from "fs/promises";
import * as path from "path";

import assert from "@/common/utils/assert";
import { Ok, type Result } from "@/common/types/result";
import type {
  HarnessChecklistItem,
  HarnessGateRunResult,
  HarnessLoopState,
} from "@/common/types/harness";
import { HarnessLoopStateSchema } from "@/common/orpc/schemas";
import { createMuxMessage } from "@/common/types/message";
import { defaultModel } from "@/common/utils/ai/models";
import { getPlanFilePath } from "@/common/utils/planStorage";
import type { WorkspaceService } from "@/node/services/workspaceService";
import type { AIService } from "@/node/services/aiService";
import type { Config } from "@/node/config";
import { log } from "@/node/services/log";
import { MutexMap } from "@/node/utils/concurrency/mutexMap";
import type { WorkspaceHarnessService } from "@/node/services/workspaceHarnessService";
import type { GateRunnerService } from "@/node/services/gateRunnerService";
import type { GitCheckpointService } from "@/node/services/gitCheckpointService";
import { createRuntime } from "@/node/runtime/runtimeFactory";
import { execBuffered } from "@/node/utils/runtime/helpers";

const LOOP_STATE_FILENAME = "harness-loop.json";

const DEFAULT_STATE: HarnessLoopState = {
  status: "stopped",
  startedAt: null,
  iteration: 0,
  consecutiveFailures: 0,
  currentItemId: null,
  currentItemTitle: null,
  lastGateRun: null,
  lastCheckpoint: null,
  lastError: null,
  stoppedReason: null,
};

function coerceNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function findNextChecklistItem(config: {
  checklist: HarnessChecklistItem[];
}): HarnessChecklistItem | null {
  const doing = config.checklist.find((item) => item.status === "doing");
  if (doing) return doing;

  const todo = config.checklist.find((item) => item.status === "todo");
  if (todo) return todo;

  return null;
}

function hasUnfinishedChecklistItems(config: { checklist: HarnessChecklistItem[] }): boolean {
  return config.checklist.some((item) => item.status !== "done");
}

export function buildIterationPrompt(params: {
  iteration: number;
  itemId: string;
  itemTitle: string;
  configPathHint: string;
  progressPathHint: string;
}): string {
  const lines: string[] = [];
  lines.push(`Ralph loop iteration ${params.iteration}`);
  lines.push("");
  lines.push(`Checklist item: ${params.itemId} — ${params.itemTitle}`);
  lines.push("");
  lines.push("Rules:");
  lines.push("- Make a small, mergeable change.");
  lines.push("- Run the configured gates (see harness config) before stopping.");
  lines.push("- Do NOT start the next checklist item.");
  lines.push(`- Before coding: skim the journal for prior attempts on item ${params.itemId}.`);
  lines.push(
    "- After you finish (and gates), append a short entry to the journal (do not edit old entries)."
  );
  lines.push("");
  lines.push("Harness files:");
  lines.push(`- Journal: ${params.progressPathHint}`);
  lines.push(`- Config: ${params.configPathHint}`);
  return lines.join("\n");
}

function renderLoopSummaryMarkdown(params: {
  workspaceId: string;
  iteration: number;
  currentItemTitle: string | null;
  configPathHint: string;
  progressPathHint: string;
  planPathHint: string;
  checklist: HarnessChecklistItem[];
  lastGateRun: HarnessGateRunResult | null;
  lastCommitSha: string | null;
  note?: string;
}): string {
  const lines: string[] = [];

  lines.push("# Ralph loop bearings");
  lines.push("");
  lines.push(`- Workspace: ${params.workspaceId}`);
  lines.push(`- Iteration: ${params.iteration}`);
  if (params.currentItemTitle) {
    lines.push(`- Current item: ${params.currentItemTitle}`);
  }
  if (params.lastGateRun) {
    lines.push(
      `- Gates: ${params.lastGateRun.ok ? "PASS" : "FAIL"} (${Math.round(
        params.lastGateRun.totalDurationMs / 1000
      )}s)`
    );
  }
  if (params.lastCommitSha) {
    lines.push(`- Last commit: ${params.lastCommitSha}`);
  }
  if (params.note) {
    lines.push(`- Note: ${params.note}`);
  }
  lines.push("");

  lines.push("Harness files:");
  lines.push(`- ${params.progressPathHint}`);
  lines.push(`- ${params.configPathHint}`);
  lines.push(`- Plan: ${params.planPathHint}`);
  lines.push("");

  lines.push("Checklist:");
  if (params.checklist.length === 0) {
    lines.push("(no checklist items)");
  } else {
    for (const item of params.checklist) {
      const marker =
        item.status === "done"
          ? "[x]"
          : item.status === "doing"
            ? "[~]"
            : item.status === "blocked"
              ? "[!]"
              : "[ ]";
      lines.push(`- ${marker} ${item.title}`);
    }
  }

  lines.push("");
  lines.push("Continue with one small step, then run gates and stop.");

  return lines.join("\n");
}

export class LoopRunnerService extends EventEmitter {
  private readonly locks = new MutexMap<string>();
  private readonly states = new Map<string, HarnessLoopState>();
  private readonly controllers = new Map<string, AbortController>();

  constructor(
    private readonly config: Config,
    private readonly workspaceService: WorkspaceService,
    private readonly aiService: AIService,
    private readonly workspaceHarnessService: WorkspaceHarnessService,
    private readonly gateRunnerService: GateRunnerService,
    private readonly gitCheckpointService: GitCheckpointService
  ) {
    super();
    assert(config, "LoopRunnerService requires a Config instance");
    assert(workspaceService, "LoopRunnerService requires a WorkspaceService instance");
    assert(aiService, "LoopRunnerService requires an AIService instance");
    assert(
      workspaceHarnessService,
      "LoopRunnerService requires a WorkspaceHarnessService instance"
    );
    assert(gateRunnerService, "LoopRunnerService requires a GateRunnerService instance");
    assert(gitCheckpointService, "LoopRunnerService requires a GitCheckpointService instance");
  }

  private getStatePath(workspaceId: string): string {
    assert(typeof workspaceId === "string", "workspaceId must be a string");
    const trimmed = workspaceId.trim();
    assert(trimmed.length > 0, "workspaceId must not be empty");
    return path.join(this.config.sessionsDir, trimmed, LOOP_STATE_FILENAME);
  }

  private async persistState(workspaceId: string, state: HarnessLoopState): Promise<void> {
    const filePath = this.getStatePath(workspaceId);
    const dir = path.dirname(filePath);

    try {
      await fsPromises.mkdir(dir, { recursive: true });
      await fsPromises.writeFile(filePath, JSON.stringify(state, null, 2) + "\n", "utf-8");
    } catch (error) {
      log.debug("[HARNESS] Failed to persist loop state", { workspaceId, error });
    }

    // Best-effort: ensure harness journal exists, but never block loop control on remote IO.
    void this.workspaceHarnessService
      .updateProgressFile(workspaceId, state)
      .catch((error: unknown) => {
        log.debug("[HARNESS] Failed to ensure harness journal exists", { workspaceId, error });
      });

    this.emit("change", workspaceId);
  }

  /**
   * Update checklist item status without clobbering concurrent harness edits.
   *
   * The loop runner may hold an in-memory snapshot of the harness config for the
   * duration of an iteration. Users (or harness-init) can edit the harness file
   * concurrently; when we update a status (todo→doing, doing→done), we must merge
   * onto the latest on-disk config to avoid overwriting those edits.
   */
  private async updateChecklistItemStatus(
    workspaceId: string,
    itemId: string,
    status: HarnessChecklistItem["status"]
  ): Promise<void> {
    assert(typeof itemId === "string" && itemId.trim().length > 0, "itemId must be non-empty");

    try {
      const latest = await this.workspaceHarnessService.getHarnessForWorkspace(workspaceId);
      const existing = latest.config.checklist.find((item) => item.id === itemId) ?? null;
      if (!existing) {
        return;
      }

      if (existing.status === status) {
        return;
      }

      await this.workspaceHarnessService.setHarnessForWorkspace(workspaceId, {
        ...latest.config,
        checklist: latest.config.checklist.map((item) =>
          item.id === itemId ? { ...item, status } : item
        ),
      });
    } catch (error) {
      log.debug("[HARNESS] Failed to update checklist item status", {
        workspaceId,
        itemId,
        status,
        error,
      });
    }
  }

  private async loadStateFromDisk(workspaceId: string): Promise<HarnessLoopState> {
    const filePath = this.getStatePath(workspaceId);

    try {
      const raw = await fsPromises.readFile(filePath, "utf-8");
      const parsed: unknown = JSON.parse(raw) as unknown;
      const result = HarnessLoopStateSchema.safeParse(parsed);
      if (!result.success) {
        return { ...DEFAULT_STATE };
      }

      // If mux restarts mid-loop, force manual resume.
      if (result.data.status === "running") {
        return {
          ...result.data,
          status: "paused",
          stoppedReason: result.data.stoppedReason ?? "Mux restarted; resume manually",
        };
      }

      return result.data;
    } catch {
      return { ...DEFAULT_STATE };
    }
  }

  private async getStateUnlocked(workspaceId: string): Promise<HarnessLoopState> {
    const cached = this.states.get(workspaceId);
    if (cached) {
      return cached;
    }

    const loaded = await this.loadStateFromDisk(workspaceId);
    this.states.set(workspaceId, loaded);
    return loaded;
  }

  async getState(workspaceId: string): Promise<HarnessLoopState> {
    return this.locks.withLock(workspaceId, () => this.getStateUnlocked(workspaceId));
  }

  async start(workspaceId: string): Promise<Result<void>> {
    return this.locks.withLock(workspaceId, async () => {
      const prev = await this.getStateUnlocked(workspaceId);
      if (prev.status === "running") {
        return Ok(undefined);
      }

      const next: HarnessLoopState = {
        ...prev,
        status: "running",
        startedAt: prev.status === "paused" ? (prev.startedAt ?? Date.now()) : Date.now(),
        iteration: prev.status === "paused" ? prev.iteration : 0,
        consecutiveFailures: prev.status === "paused" ? prev.consecutiveFailures : 0,
        stoppedReason: null,
        lastError: null,
      };

      this.states.set(workspaceId, next);
      await this.persistState(workspaceId, next);

      this.startRunner(workspaceId);

      return Ok(undefined);
    });
  }

  async pause(workspaceId: string, reason?: string): Promise<Result<void>> {
    return this.locks.withLock(workspaceId, async () => {
      const prev = await this.getStateUnlocked(workspaceId);
      if (prev.status !== "running") {
        return Ok(undefined);
      }

      const next: HarnessLoopState = {
        ...prev,
        status: "paused",
        stoppedReason: coerceNonEmptyString(reason) ?? prev.stoppedReason,
      };

      this.states.set(workspaceId, next);
      await this.persistState(workspaceId, next);

      // Best-effort: stop any in-flight stream.
      void this.aiService.stopStream(workspaceId, { soft: true });

      const controller = this.controllers.get(workspaceId);
      controller?.abort();

      return Ok(undefined);
    });
  }

  async stop(workspaceId: string, reason?: string): Promise<Result<void>> {
    return this.locks.withLock(workspaceId, async () => {
      const prev = await this.getStateUnlocked(workspaceId);

      const next: HarnessLoopState = {
        ...prev,
        status: "stopped",
        startedAt: null,
        currentItemId: null,
        currentItemTitle: null,
        consecutiveFailures: 0,
        stoppedReason: coerceNonEmptyString(reason) ?? prev.stoppedReason,
      };

      this.states.set(workspaceId, next);
      await this.persistState(workspaceId, next);

      void this.aiService.stopStream(workspaceId, { soft: true });

      const controller = this.controllers.get(workspaceId);
      controller?.abort();
      this.controllers.delete(workspaceId);

      return Ok(undefined);
    });
  }

  private startRunner(workspaceId: string): void {
    const existing = this.controllers.get(workspaceId);
    existing?.abort();

    const abortController = new AbortController();
    this.controllers.set(workspaceId, abortController);

    void this.runLoop(workspaceId, abortController.signal)
      .catch((error: unknown) => {
        log.error("[HARNESS] Loop runner crashed", { workspaceId, error });
      })
      .finally(() => {
        const current = this.controllers.get(workspaceId);
        if (current === abortController) {
          this.controllers.delete(workspaceId);
        }
      });
  }

  private async isGitDirty(workspaceId: string): Promise<boolean> {
    try {
      const { runtime, workspacePath } =
        await this.workspaceHarnessService.getRuntimeAndWorkspacePath(workspaceId);

      const ready = await runtime.ensureReady();
      if (!ready.ready) {
        return false;
      }

      const status = await execBuffered(runtime, "git status --porcelain", {
        cwd: workspacePath,
        timeout: 30,
      });

      return status.exitCode === 0 && status.stdout.trim().length > 0;
    } catch {
      return false;
    }
  }

  private async runLoop(workspaceId: string, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const state = await this.getState(workspaceId);
      if (state.status !== "running") {
        return;
      }

      const harness = await this.workspaceHarnessService.getHarnessForWorkspace(workspaceId);
      const config = harness.config;
      const loop = config.loop;

      const maxIterations = loop?.maxIterations ?? 50;
      const maxWallTimeMins = loop?.maxWallTimeMins ?? 8 * 60;
      const maxConsecutiveFailures = loop?.maxConsecutiveFailures ?? 3;
      const contextReset = loop?.contextReset ?? "replace_history";
      const autoCommit = loop?.autoCommit ?? true;
      const commitMessageTemplate = loop?.commitMessageTemplate ?? "mux(harness): {{item}}";
      const toolPolicy = loop?.toolPolicy;

      if (state.iteration >= maxIterations) {
        await this.pause(workspaceId, `Max iterations reached (${maxIterations})`);
        return;
      }

      if (state.startedAt) {
        const elapsedMins = (Date.now() - state.startedAt) / 1000 / 60;
        if (elapsedMins >= maxWallTimeMins) {
          await this.pause(workspaceId, `Max wall time reached (${maxWallTimeMins} mins)`);
          return;
        }
      }

      const info = await this.workspaceService.getInfo(workspaceId);
      if (!info) {
        await this.pause(workspaceId, "Workspace not found");
        return;
      }

      const configPathHint = `.mux/harness/${info.name}.jsonc`;
      const progressPathHint = `.mux/harness/${info.name}.progress.md`;

      const modelString =
        info.aiSettingsByMode?.exec?.model ?? info.aiSettings?.model ?? defaultModel;
      const thinkingLevel =
        info.aiSettingsByMode?.exec?.thinkingLevel ?? info.aiSettings?.thinkingLevel;

      const blocked = config.checklist.find((item) => item.status === "blocked") ?? null;
      const nextItem = findNextChecklistItem(config);

      const isFinalCleanup = nextItem === null;
      if (isFinalCleanup && blocked) {
        await this.pause(workspaceId, `Checklist blocked: ${blocked.title}`);
        return;
      }

      const itemTitle = nextItem?.title ?? "Final cleanup (gates + git clean)";
      const itemId = nextItem?.id ?? "final-cleanup";
      const prompt = buildIterationPrompt({
        iteration: state.iteration,
        itemId,
        itemTitle,
        configPathHint,
        progressPathHint,
      });

      const updatedStateBeforeSend: HarnessLoopState = {
        ...state,
        currentItemId: nextItem?.id ?? null,
        currentItemTitle: itemTitle,
      };

      this.states.set(workspaceId, updatedStateBeforeSend);
      await this.persistState(workspaceId, updatedStateBeforeSend);

      // If this is a checklist item, mark it doing before we start.
      if (nextItem?.status === "todo") {
        await this.updateChecklistItemStatus(workspaceId, nextItem.id, "doing");
      }

      const sendResult = await this.workspaceService.sendMessage(workspaceId, prompt, {
        model: modelString,
        thinkingLevel,
        mode: "exec",
        toolPolicy,
        muxMetadata: { type: "harness-loop", iteration: updatedStateBeforeSend.iteration },
      });

      if (!sendResult.success) {
        await this.pause(workspaceId, `sendMessage failed: ${sendResult.error.type}`);
        return;
      }

      if (signal.aborted) {
        return;
      }

      // Run gates (stop on first failure).
      const gatesResult = await this.gateRunnerService.runGates(workspaceId, config.gates);
      if (!gatesResult.success) {
        await this.pause(workspaceId, `Failed to run gates: ${gatesResult.error}`);
        return;
      }

      let nextState: HarnessLoopState = {
        ...updatedStateBeforeSend,
        lastGateRun: gatesResult.data,
        lastError: gatesResult.data.ok ? null : "Gates failed",
      };

      if (gatesResult.data.ok) {
        nextState = { ...nextState, consecutiveFailures: 0 };

        if (autoCommit) {
          const checkpointResult = await this.gitCheckpointService.checkpoint(workspaceId, {
            messageTemplate: commitMessageTemplate,
            itemTitle,
            iteration: nextState.iteration,
          });

          if (!checkpointResult.success) {
            await this.pause(workspaceId, `Checkpoint failed: ${checkpointResult.error}`);
            return;
          }

          nextState = { ...nextState, lastCheckpoint: checkpointResult.data };
        }

        // If this was a checklist item, mark it done.
        if (nextItem) {
          await this.updateChecklistItemStatus(workspaceId, nextItem.id, "done");
        }
      } else {
        const failures = nextState.consecutiveFailures + 1;
        nextState = { ...nextState, consecutiveFailures: failures };

        if (failures >= maxConsecutiveFailures) {
          await this.pause(workspaceId, `Gates failed ${maxConsecutiveFailures} times in a row`);
          return;
        }
      }

      // Stop condition: when checklist is finished and the repo is clean.
      if (!hasUnfinishedChecklistItems(config) && gatesResult.data.ok && !blocked) {
        const dirty = await this.isGitDirty(workspaceId);
        if (!dirty) {
          await this.stop(workspaceId, "All checklist items done; gates passing; git clean");
          return;
        }
      }

      nextState = { ...nextState, iteration: nextState.iteration + 1 };
      this.states.set(workspaceId, nextState);
      await this.persistState(workspaceId, nextState);

      if (contextReset === "replace_history") {
        const runtime = createRuntime(info.runtimeConfig, { projectPath: info.projectPath });
        const planPathHint = getPlanFilePath(info.name, info.projectName, runtime.getMuxHome());

        const summary = renderLoopSummaryMarkdown({
          workspaceId,
          iteration: nextState.iteration,
          currentItemTitle: nextState.currentItemTitle,
          configPathHint,
          progressPathHint,
          planPathHint,
          checklist: config.checklist,
          lastGateRun: nextState.lastGateRun,
          lastCommitSha: nextState.lastCheckpoint?.commitSha ?? null,
        });

        const summaryMessage = createMuxMessage(
          `harness-loop-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
          "assistant",
          summary,
          {
            timestamp: Date.now(),
            compacted: "user",
            mode: "exec",
            muxMetadata: { type: "harness-loop-bearings" },
          }
        );

        const replaceResult = await this.workspaceService.replaceHistory(
          workspaceId,
          summaryMessage
        );
        if (!replaceResult.success) {
          log.debug("[HARNESS] Failed to reset context", {
            workspaceId,
            error: replaceResult.error,
          });
        }
      }

      // Give the event loop a breath so stop/pause can land quickly.
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}
