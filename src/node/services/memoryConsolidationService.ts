/**
 * Memory-consolidation orchestration ("dream" agent, issue #3534, phase 2).
 *
 * Owns everything around the runner (memoryConsolidation.ts): experiment
 * gating, per-workspace debounce, trigger funneling (compaction / launch-idle
 * sweep / archive / manual), model resolution (inherit cascade), and journal
 * persistence for the Memory tab's "last consolidated" line.
 *
 * Failure posture: best-effort everywhere. Triggers fire-and-forget; a
 * failed run logs and waits for the next trigger. Nothing here may block a
 * stream, compaction, archival, or app launch.
 */
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import writeFileAtomic from "write-file-atomic";
import { z } from "zod";
import type { LanguageModel } from "ai";
import type { Result } from "@/common/types/result";

import {
  MEMORY_CONSOLIDATION_DEBOUNCE_MS,
  MEMORY_CONSOLIDATION_IDLE_MS,
  MEMORY_CONSOLIDATION_LAUNCH_SWEEP_CAP,
  MEMORY_CONSOLIDATION_TIMEOUT_MS,
} from "@/common/constants/memory";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import {
  MemoryConsolidationRecordSchema,
  type MemoryConsolidationRecordPayload,
  type MemoryConsolidationTrigger,
} from "@/common/orpc/schemas/memory";
import { defaultModel } from "@/common/utils/ai/models";
import { isWorkspaceArchived } from "@/common/utils/archive";
import { getErrorMessage } from "@/common/utils/errors";
import { Err, Ok } from "@/common/types/result";
import type { Config } from "@/node/config";
import { getBuiltInAgentDefinitions } from "@/node/services/agentDefinitions/builtInAgentDefinitions";
import { parseAgentDefinitionMarkdown } from "@/node/services/agentDefinitions/parseAgentDefinitionMarkdown";
import { log } from "@/node/services/log";
import { runMemoryConsolidation } from "@/node/services/memoryConsolidation";
import type { MemoryScopeContext, MemoryService } from "@/node/services/memoryService";
import { memoryLogicalKey, type MemoryMetaService } from "@/node/services/memoryMeta";
import { MutexMap } from "@/node/utils/concurrency/mutexMap";

// Types derive from the oRPC schemas (z.infer single source) so node-side
// fields can never silently be stripped by output validation.
export type { MemoryConsolidationTrigger };
export type MemoryConsolidationRecord = MemoryConsolidationRecordPayload;

/**
 * Sidecar wire format. Validated with zod on load: hand-rolled checks once
 * let `{"workspaces": null}` through (typeof null === "object") and bricked
 * every later read with a TypeError.
 */
const ConsolidationSidecarFileSchema = z.object({
  workspaces: z.record(z.string(), MemoryConsolidationRecordSchema),
});
type ConsolidationSidecarFile = z.infer<typeof ConsolidationSidecarFileSchema>;

interface ExperimentsCheck {
  isExperimentEnabled(experimentId: string): boolean;
}

interface ModelFactoryLike {
  createModel(
    modelString: string,
    muxProviderOptions?: undefined,
    opts?: { agentInitiated?: boolean; workspaceId?: string }
  ): Promise<Result<LanguageModel, { type: string }>>;
}

/**
 * Resolve the model for a dream run — the inherit cascade from PRD #3534
 * (uniform with other agents): per-workspace dream override → global dream
 * default → workspace session model → app default. Shared with the debug CLI.
 */
export function resolveDreamModelString(config: Config, workspaceId: string): string {
  const cfg = config.loadConfigOrDefault();
  const workspace = config.findWorkspace(workspaceId);
  const workspaceEntry = workspace
    ? cfg.projects.get(workspace.projectPath)?.workspaces.find((entry) => entry.id === workspaceId)
    : undefined;
  return (
    workspaceEntry?.aiSettingsByAgent?.dream?.model ??
    cfg.agentAiDefaults?.dream?.modelString ??
    workspaceEntry?.aiSettings?.model ??
    defaultModel
  );
}

/**
 * Resolve the dream agent prompt body: a user override at <muxRoot>/agents/dream.md
 * (global agent scope) shadows the built-in definition, like any other agent.
 * `muxRoot` is Config.rootDir — NOT a hardcoded ~/.mux — so dev builds
 * (~/.mux-dev), MUX_ROOT sandboxes, and tests all stay isolated.
 * Host-side read only — dream runs are runtime-independent in v1, so project
 * scope overrides (which need a live checkout) are deferred with project
 * memories. Shared with the debug CLI.
 */
export async function resolveDreamAgentBody(muxRoot: string): Promise<string | null> {
  const overridePath = path.join(muxRoot, "agents", "dream.md");
  try {
    const content = await fsPromises.readFile(overridePath, "utf-8");
    const parsed = parseAgentDefinitionMarkdown({
      content,
      byteSize: Buffer.byteLength(content, "utf8"),
    });
    const body = parsed.body.trim();
    if (body.length > 0) return body;
    log.warn("[MemoryConsolidation] dream override has an empty body; using built-in", {
      overridePath,
    });
  } catch (error) {
    // Missing override is the normal case; anything else (malformed
    // frontmatter, permissions) deserves a warning instead of a silent
    // fallback the user cannot debug.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      log.warn("[MemoryConsolidation] failed to read dream override; using built-in", {
        overridePath,
        error: getErrorMessage(error),
      });
    }
  }
  const dream = getBuiltInAgentDefinitions().find((definition) => definition.id === "dream");
  return dream?.body ?? null;
}

export class MemoryConsolidationService {
  private readonly sidecarPath: string;
  /** Serializes sidecar read-modify-write cycles (journal persistence only). */
  private readonly locks = new MutexMap<string>();
  /**
   * Per-workspace run lock holding the active run's promise. Reserved
   * SYNCHRONOUSLY in maybeRun before any await so two near-simultaneous
   * triggers can never both start a run; archive triggers queue behind the
   * active run via the stored promise.
   */
  private readonly inFlight = new Map<string, Promise<Result<MemoryConsolidationRecord, string>>>();

  constructor(
    private readonly config: Config,
    private readonly memoryService: MemoryService,
    private readonly metaService: MemoryMetaService,
    private readonly modelFactory: ModelFactoryLike,
    private readonly experiments: ExperimentsCheck
  ) {
    this.sidecarPath = path.join(config.rootDir, "memory-consolidation.json");
  }

  private enabled(): boolean {
    return (
      this.experiments.isExperimentEnabled(EXPERIMENT_IDS.MEMORY) &&
      this.experiments.isExperimentEnabled(EXPERIMENT_IDS.MEMORY_CONSOLIDATION)
    );
  }

  /** Self-healing load: malformed sidecar yields an empty file. */
  private async load(): Promise<ConsolidationSidecarFile> {
    try {
      const raw = await fsPromises.readFile(this.sidecarPath, "utf-8");
      const parsed = ConsolidationSidecarFileSchema.safeParse(JSON.parse(raw));
      if (parsed.success) return parsed.data;
    } catch {
      // Missing or corrupt — start fresh (the next save overwrites the file).
    }
    return { workspaces: {} };
  }

  async getRecord(workspaceId: string): Promise<MemoryConsolidationRecord | null> {
    const file = await this.load();
    return file.workspaces[workspaceId] ?? null;
  }

  private async saveRecord(workspaceId: string, record: MemoryConsolidationRecord): Promise<void> {
    await this.locks.withLock(this.sidecarPath, async () => {
      const file = await this.load();
      file.workspaces[workspaceId] = record;
      await writeFileAtomic(this.sidecarPath, JSON.stringify(file, null, 2));
    });
  }

  /**
   * Funnel for every trigger. Checks experiment + debounce, then runs and
   * journals. Returns the record on a completed run, or a skip reason.
   */
  async maybeRun(
    workspaceId: string,
    trigger: MemoryConsolidationTrigger
  ): Promise<Result<MemoryConsolidationRecord, string>> {
    if (!this.enabled()) return Err("memory-consolidation experiment is disabled");
    const active = this.inFlight.get(workspaceId);
    if (active !== undefined) {
      // Archive is the workspace's one-shot final pass (workspace→global
      // promotion) and its caller never retries — queue it behind the active
      // run instead of dropping it. Other triggers are repetitive
      // housekeeping and may be dropped.
      if (trigger !== "archive") return Err("a consolidation run is already in flight");
      await active.catch(() => undefined);
      return this.maybeRun(workspaceId, trigger);
    }
    // Reserve the run lock in the same synchronous frame as the check above:
    // the awaits in runLocked (sidecar read, agent body, model creation) are
    // a wide window where a racing trigger would otherwise also pass the
    // check and start a second concurrent run over the same directories.
    // runLocked executes synchronously up to its first await, so the map is
    // populated before any other caller can observe it.
    const run = this.runLocked(workspaceId, trigger);
    this.inFlight.set(workspaceId, run);
    try {
      return await run;
    } finally {
      this.inFlight.delete(workspaceId);
    }
  }

  /** The actual run; only ever invoked by maybeRun while holding the lock. */
  private async runLocked(
    workspaceId: string,
    trigger: MemoryConsolidationTrigger
  ): Promise<Result<MemoryConsolidationRecord, string>> {
    // Manual runs bypass debounce (an explicit /dream is explicit intent).
    // Archive too: it is the workspace's one-shot final pass — the only
    // chance to promote durable lessons to global scope — and archival
    // typically follows a compaction-triggered run within the window.
    if (trigger !== "manual" && trigger !== "archive") {
      const record = await this.getRecord(workspaceId);
      if (record !== null && Date.now() - record.lastRunAt < MEMORY_CONSOLIDATION_DEBOUNCE_MS) {
        return Err("debounced: a recent consolidation run already covered this workspace");
      }
    }

    const workspace = this.config.findWorkspace(workspaceId);
    if (!workspace) return Err(`workspace not found: ${workspaceId}`);

    const agentBody = await resolveDreamAgentBody(this.config.rootDir);
    if (agentBody === null) return Err("dream agent definition is missing");

    const modelString = resolveDreamModelString(this.config, workspaceId);
    const modelResult = await this.modelFactory.createModel(modelString, undefined, {
      agentInitiated: true,
      workspaceId,
    });
    if (!modelResult.success) {
      return Err(`could not create model ${modelString}: ${modelResult.error.type}`);
    }

    // v1 scopes are host-local (workspace + global): runtime stays null and
    // checkoutCwd/projectPath stay "" so BOTH repo-backed project memory and
    // host-local project-local memory are structurally disabled — including
    // for reads, which bypass the tool's mutation guard. A dream pass must
    // never ship project-private notes to the provider (PRD #3534). The
    // stopped-runtime case also works: no live checkout is needed.
    const ctx: MemoryScopeContext = {
      runtime: null,
      checkoutCwd: "",
      workspaceId,
      projectPath: "",
    };

    const result = await runMemoryConsolidation({
      model: modelResult.data,
      agentBody,
      memoryService: this.memoryService,
      metaService: this.metaService,
      ctx,
      dryRun: false,
      finalPass: trigger === "archive",
      // Hard timeout: a wedged provider stream must not hold the in-flight
      // lock forever (and stall the sequential launch sweep behind it).
      abortSignal: AbortSignal.timeout(MEMORY_CONSOLIDATION_TIMEOUT_MS),
    });
    // A stream failure (provider error or the run timeout) means the pass did
    // NOT cover the memory state: skip the journal record so the debounce and
    // launch sweep retry later instead of reporting a successful consolidation
    // that never happened.
    if (result.streamError !== undefined) {
      return Err(`consolidation stream failed: ${result.streamError}`);
    }

    const record: MemoryConsolidationRecord = {
      lastRunAt: Date.now(),
      trigger,
      summary: result.summary,
      ops: result.ops,
      usage: result.usage,
    };
    await this.saveRecord(workspaceId, record);
    log.debug("[MemoryConsolidation] run complete", {
      workspaceId,
      trigger,
      ops: result.ops.length,
      applied: result.ops.filter((op) => op.applied).length,
      globalWrites: result.ops.filter((op) => op.path.startsWith("/memories/global/")).length,
      usage: result.usage,
    });
    return Ok(record);
  }

  /** Fire-and-forget wrapper for trigger sites; never throws. */
  triggerInBackground(workspaceId: string, trigger: MemoryConsolidationTrigger): void {
    // Cheap synchronous pre-check so disabled installs pay zero I/O.
    if (!this.enabled()) return;
    void this.maybeRun(workspaceId, trigger)
      .then((result) => {
        if (!result.success) {
          log.debug("[MemoryConsolidation] skipped", {
            workspaceId,
            trigger,
            reason: result.error,
          });
        }
      })
      .catch((error: unknown) => {
        log.warn("[MemoryConsolidation] background run failed", {
          workspaceId,
          trigger,
          error: getErrorMessage(error),
        });
      });
  }

  /**
   * App-launch sweep (launch-only by design, PRD #3534): consolidate
   * workspaces idle ≥ MEMORY_CONSOLIDATION_IDLE_MS that have memory writes
   * newer than their last run. `recencyByWorkspace` comes from the host-local
   * extension metadata (last user interaction).
   *
   * Cost rails: archived workspaces never qualify (they got their final pass
   * at archive time and would otherwise stay "idle" forever); global-scope
   * writes are anchored on the newest run across ALL workspaces — global
   * scope is shared, so one pass covers it, and anchoring per-workspace would
   * let each run's own global cleanup re-qualify every other workspace in an
   * endless multi-launch loop; at most MEMORY_CONSOLIDATION_LAUNCH_SWEEP_CAP
   * workspaces run per launch.
   */
  async runLaunchSweep(recencyByWorkspace: Map<string, number>): Promise<void> {
    if (!this.enabled()) return;
    const now = Date.now();
    const meta = await this.metaService.getEntries();
    const sidecar = await this.load();
    // Newest completed run anywhere = last time global scope was covered
    // (every run consolidates global). Derived, so no sidecar schema change.
    // Advanced after each successful run below: a global-only write needs ONE
    // covering pass, not one per idle workspace in the same sweep.
    let globalLastRunAt = Math.max(
      0,
      ...Object.values(sidecar.workspaces).map((record) => record.lastRunAt)
    );
    const archivedById = new Map<string, boolean>();
    for (const project of this.config.loadConfigOrDefault().projects.values()) {
      for (const workspace of project.workspaces) {
        if (workspace.id === undefined) continue;
        archivedById.set(
          workspace.id,
          isWorkspaceArchived(workspace.archivedAt, workspace.unarchivedAt)
        );
      }
    }

    let started = 0;
    for (const [workspaceId, recency] of recencyByWorkspace) {
      if (started >= MEMORY_CONSOLIDATION_LAUNCH_SWEEP_CAP) break;
      if (now - recency < MEMORY_CONSOLIDATION_IDLE_MS) continue;
      if (archivedById.get(workspaceId) === true) continue;
      const lastRunAt = sidecar.workspaces[workspaceId]?.lastRunAt ?? 0;
      // "Writes since last run": any workspace-scope entry for this workspace
      // (or any global entry newer than the newest run anywhere) qualifies.
      // Prefix is derived via memoryLogicalKey (relPath "" =>
      // "workspace:<id>:") so the encoding always matches the meta key scheme.
      const workspaceKeyPrefix = memoryLogicalKey("workspace", "", {
        projectPath: "",
        workspaceId,
      });
      let hasNewWrites = false;
      for (const [key, entry] of meta) {
        if (entry.lastWriteAt === null) continue;
        if (key.startsWith(workspaceKeyPrefix) && entry.lastWriteAt > lastRunAt) {
          hasNewWrites = true;
          break;
        }
        if (key.startsWith("global:") && entry.lastWriteAt > globalLastRunAt) {
          hasNewWrites = true;
          break;
        }
      }
      if (!hasNewWrites) continue;
      started++;
      // Sequential, not parallel: the sweep is background housekeeping and
      // must not stampede the provider on launch.
      const result = await this.maybeRun(workspaceId, "launch").catch((error: unknown) =>
        Err(getErrorMessage(error))
      );
      if (!result.success) {
        log.debug("[MemoryConsolidation] launch sweep skipped workspace", {
          workspaceId,
          reason: result.error,
        });
        continue;
      }
      // This run covered global scope; later candidates in this sweep only
      // qualify via their own workspace writes or genuinely newer global ones.
      globalLastRunAt = Math.max(globalLastRunAt, result.data.lastRunAt);
    }
  }
}
