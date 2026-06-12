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
import * as os from "node:os";
import * as path from "node:path";
import writeFileAtomic from "write-file-atomic";
import type { LanguageModel } from "ai";
import type { Result } from "@/common/types/result";

import {
  MEMORY_CONSOLIDATION_DEBOUNCE_MS,
  MEMORY_CONSOLIDATION_IDLE_MS,
} from "@/common/constants/memory";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import { defaultModel } from "@/common/utils/ai/models";
import { getErrorMessage } from "@/common/utils/errors";
import { Err, Ok } from "@/common/types/result";
import type { Config } from "@/node/config";
import { getBuiltInAgentDefinitions } from "@/node/services/agentDefinitions/builtInAgentDefinitions";
import { parseAgentDefinitionMarkdown } from "@/node/services/agentDefinitions/parseAgentDefinitionMarkdown";
import { log } from "@/node/services/log";
import {
  runMemoryConsolidation,
  type MemoryConsolidationOp,
} from "@/node/services/memoryConsolidation";
import type { MemoryScopeContext, MemoryService } from "@/node/services/memoryService";
import { memoryLogicalKey, type MemoryMetaService } from "@/node/services/memoryMeta";
import { MutexMap } from "@/node/utils/concurrency/mutexMap";

export type MemoryConsolidationTrigger = "compaction" | "launch" | "archive" | "manual";

/** Persisted per-workspace consolidation record (journal + debounce anchor). */
export interface MemoryConsolidationRecord {
  lastRunAt: number;
  trigger: MemoryConsolidationTrigger;
  summary: string;
  ops: MemoryConsolidationOp[];
}

interface ConsolidationSidecarFile {
  workspaces: Record<string, MemoryConsolidationRecord>;
}

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
 * Resolve the dream agent prompt body: a user override at ~/.mux/agents/dream.md
 * (global agent scope) shadows the built-in definition, like any other agent.
 * Host-side read only — dream runs are runtime-independent in v1, so project
 * scope overrides (which need a live checkout) are deferred with project
 * memories. Shared with the debug CLI.
 */
export async function resolveDreamAgentBody(): Promise<string | null> {
  try {
    const overridePath = path.join(os.homedir(), ".mux", "agents", "dream.md");
    const content = await fsPromises.readFile(overridePath, "utf-8");
    const parsed = parseAgentDefinitionMarkdown({
      content,
      byteSize: Buffer.byteLength(content, "utf8"),
    });
    const body = parsed.body.trim();
    if (body.length > 0) return body;
  } catch {
    // Missing or malformed override — fall back to the built-in.
  }
  const dream = getBuiltInAgentDefinitions().find((definition) => definition.id === "dream");
  return dream?.body ?? null;
}

export class MemoryConsolidationService {
  private readonly sidecarPath: string;
  /** Serializes sidecar reads/writes and prevents concurrent runs per process. */
  private readonly locks = new MutexMap<string>();
  /** Workspaces with a run in flight (debounce only anchors on completed runs). */
  private readonly inFlight = new Set<string>();

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
      const parsed: unknown = JSON.parse(raw);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        typeof (parsed as ConsolidationSidecarFile).workspaces === "object"
      ) {
        return parsed as ConsolidationSidecarFile;
      }
    } catch {
      // Missing or corrupt — start fresh.
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
    if (this.inFlight.has(workspaceId)) return Err("a consolidation run is already in flight");

    // Manual runs bypass debounce: an explicit /dream is an explicit intent.
    if (trigger !== "manual") {
      const record = await this.getRecord(workspaceId);
      if (record !== null && Date.now() - record.lastRunAt < MEMORY_CONSOLIDATION_DEBOUNCE_MS) {
        return Err("debounced: a recent consolidation run already covered this workspace");
      }
    }

    const workspace = this.config.findWorkspace(workspaceId);
    if (!workspace) return Err(`workspace not found: ${workspaceId}`);

    const agentBody = await resolveDreamAgentBody();
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
    // the project scope is structurally disabled, so stopped Docker/SSH
    // workspaces consolidate fine (PRD #3534).
    const ctx: MemoryScopeContext = {
      runtime: null,
      checkoutCwd: "",
      workspaceId,
      projectPath: workspace.projectPath,
    };

    this.inFlight.add(workspaceId);
    try {
      const result = await runMemoryConsolidation({
        model: modelResult.data,
        agentBody,
        memoryService: this.memoryService,
        metaService: this.metaService,
        ctx,
        dryRun: false,
        finalPass: trigger === "archive",
      });
      const record: MemoryConsolidationRecord = {
        lastRunAt: Date.now(),
        trigger,
        summary: result.summary,
        ops: result.ops,
      };
      await this.saveRecord(workspaceId, record);
      log.debug("[MemoryConsolidation] run complete", {
        workspaceId,
        trigger,
        ops: result.ops.length,
      });
      return Ok(record);
    } finally {
      this.inFlight.delete(workspaceId);
    }
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
   */
  async runLaunchSweep(recencyByWorkspace: Map<string, number>): Promise<void> {
    if (!this.enabled()) return;
    const now = Date.now();
    const meta = await this.metaService.getEntries();
    const sidecar = await this.load();

    for (const [workspaceId, recency] of recencyByWorkspace) {
      if (now - recency < MEMORY_CONSOLIDATION_IDLE_MS) continue;
      const lastRunAt = sidecar.workspaces[workspaceId]?.lastRunAt ?? 0;
      // "Writes since last run": any workspace-scope entry for this workspace
      // (or any global entry) written after the last consolidation. Prefix is
      // derived via memoryLogicalKey (relPath "" => "workspace:<id>:") so the
      // encoding always matches the sidecar's key scheme.
      const workspaceKeyPrefix = memoryLogicalKey("workspace", "", {
        projectPath: "",
        workspaceId,
      });
      let hasNewWrites = false;
      for (const [key, entry] of meta) {
        if (entry.lastWriteAt === null || entry.lastWriteAt <= lastRunAt) continue;
        if (key.startsWith(workspaceKeyPrefix) || key.startsWith("global:")) {
          hasNewWrites = true;
          break;
        }
      }
      if (!hasNewWrites) continue;
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
      }
    }
  }
}
