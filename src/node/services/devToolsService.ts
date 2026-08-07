import { EventEmitter } from "events";
import * as fs from "fs/promises";
import * as path from "path";
import assert from "@/common/utils/assert";
import type {
  DevToolsEvent,
  DevToolsLogEntry,
  DevToolsRun,
  DevToolsRunSummary,
  DevToolsStep,
} from "@/common/types/devtools";
import type { Config } from "@/node/config";
import { DEVTOOLS_LOG_MAX_BYTES, DEVTOOLS_LOG_ROTATED_SUFFIX } from "@/constants/devtools";
import { log } from "@/node/services/log";

interface WorkspaceData {
  runs: Map<string, DevToolsRun>;
  steps: Map<string, DevToolsStep>;
  loaded: boolean;
  /** Incremented on each clear() for defense-in-depth against stale state. */
  clearGeneration: number;
  /** Rotation count, persisted via snapshot-meta/log-meta pairs. */
  logGeneration: number;
  /**
   * Generation of the log-meta marker actually present in the live file.
   * Falls behind logGeneration when a snapshot commits but the live-marker
   * write fails (e.g. ENOSPC); appends repair the marker before writing so
   * they are not discarded as pre-snapshot on the next load.
   */
  liveMarkerGeneration: number;
  /**
   * Base-record content whose live-file write failed during rotation
   * reconciliation. Must land before any later append: a queued step append
   * succeeding while its run's base records exist nowhere durable would
   * orphan the step on the next load.
   */
  pendingLiveRepairs: string[];
  /**
   * Set when an append to the live file rejects: the write may have landed
   * partially, leaving an unterminated fragment as the file's tail. The
   * next append must start with a newline so the fragment seals into its
   * own malformed line instead of merging with (and destroying) the next
   * record.
   */
  liveTailMayBeTorn: boolean;
}

/**
 * Detects a live file shaped like a pre-rotation binary left it. Such a
 * binary clears by truncating devtools.jsonl to empty (or removes it
 * outright) without touching the rotated snapshot, and its appends carry no
 * log-meta marker. A markerless live file also arises when a first
 * snapshot commit (generation 0 -> 1) is interrupted before the live
 * rewrite; the retire sentinel written by commitSnapshotPair tells those
 * apart, so callers must also consult hasRetireSentinel. A partial
 * (unparseable) first line is not classified as legacy: marker writes are
 * atomic, so only a legacy append crash produces it, and preferring the
 * snapshot there merely loses part of one legacy debug session.
 */
function isLegacyLiveLog(liveRaw: string | null): boolean {
  if (liveRaw == null) {
    return true;
  }
  const firstLine = liveRaw.split("\n").find((line) => line.trim().length > 0);
  if (firstLine == null) {
    return true;
  }
  try {
    const entry = JSON.parse(firstLine) as DevToolsLogEntry;
    return entry.type !== "log-meta";
  } catch {
    return false;
  }
}

/**
 * True when the live file carries the retire sentinel for exactly this
 * snapshot generation, i.e. the markerless live file is an interrupted
 * current-version commit (snapshot wins), not a legacy rewrite (live wins).
 * A legacy clear truncates the live file, destroying any sentinel, so a
 * post-downgrade clear can never be mistaken for an interrupted commit.
 */
function hasRetireSentinel(liveRaw: string | null, snapshotGeneration: number): boolean {
  if (liveRaw == null) {
    return false;
  }
  for (const line of liveRaw.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    try {
      const entry = JSON.parse(line) as DevToolsLogEntry;
      if (entry.type === "log-retire" && entry.generation === snapshotGeneration) {
        return true;
      }
    } catch {
      // Partial trailing line from an interrupted append.
    }
  }
  return false;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * True only for a history entry a legacy writer could actually have
 * produced: the payload fields replay depends on must be present (a run
 * needs id, workspaceId, and startedAt; a step needs id, runId, and
 * startedAt). A line that parses as JSON with a recognized type but a
 * missing or gutted payload (for example a torn `{"type":"step-update"}`
 * or `{"run":{"id":"x"}}`) is corruption, and letting it count as legacy
 * evidence would discard the snapshot for a line that replays into
 * nothing usable.
 */
function isReplayableHistoryEntry(entry: DevToolsLogEntry): boolean {
  switch (entry.type) {
    case "run":
      return (
        isRecord(entry.run) &&
        isNonEmptyString(entry.run.id) &&
        isNonEmptyString(entry.run.workspaceId) &&
        isNonEmptyString(entry.run.startedAt)
      );
    case "step":
      return (
        isRecord(entry.step) &&
        isNonEmptyString(entry.step.id) &&
        isNonEmptyString(entry.step.runId) &&
        isNonEmptyString(entry.step.startedAt)
      );
    case "step-update":
      return typeof entry.stepId === "string" && entry.stepId.length > 0 && isRecord(entry.update);
    default:
      return false;
  }
}

/**
 * True when valid log entries follow the LAST retire sentinel for this
 * snapshot generation. The current binary never appends entries after
 * writing a sentinel (the commit either rewrites the live file or fails,
 * and a failed commit's retry writes a fresh sentinel after any entries it
 * appended), so such entries prove a downgraded pre-rotation binary
 * recorded them after the interrupted commit; the live history must win or
 * the downgraded session's runs would be discarded as stale.
 */
function hasLegacyEntriesAfterRetireSentinel(
  liveRaw: string | null,
  snapshotGeneration: number
): boolean {
  if (liveRaw == null) {
    return false;
  }
  let entriesSinceSentinel = false;
  let sawSentinel = false;
  for (const line of liveRaw.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    try {
      const entry = JSON.parse(line) as DevToolsLogEntry;
      if (entry.type === "log-retire" && entry.generation === snapshotGeneration) {
        sawSentinel = true;
        entriesSinceSentinel = false;
        continue;
      }
      if (isReplayableHistoryEntry(entry)) {
        entriesSinceSentinel = true;
      }
    } catch {
      // Partial trailing line from an interrupted append.
    }
  }
  return sawSentinel && entriesSinceSentinel;
}

/**
 * A live log written after a rotation starts with a log-meta line carrying
 * exactly the snapshot's generation. When a snapshot exists (generation >= 1)
 * and the marker generation differs, the pair is broken: replaying the live
 * log could resurrect runs a snapshot retirement dropped, so its marker gets
 * repaired before ordinary appends land and make the file look pre-snapshot
 * forever. Markerless and empty live files are classified by isLegacyLiveLog
 * before this check applies.
 */
function isStaleLiveLog(raw: string, snapshotGeneration: number): boolean {
  if (snapshotGeneration === 0) {
    return false;
  }
  const firstLine = raw.split("\n").find((line) => line.trim().length > 0);
  if (firstLine == null) {
    return true;
  }
  try {
    const entry = JSON.parse(firstLine) as DevToolsLogEntry;
    // The protocol only commits matching snapshot/live pairs: a lower or
    // missing generation predates the snapshot, a higher one pairs with a
    // snapshot that is no longer on disk, and either can resurrect dropped
    // runs. Strict equality against the validated snapshot generation also
    // rejects corrupt markers (numeric strings, unsafe numbers).
    return !(entry.type === "log-meta" && entry.generation === snapshotGeneration);
  } catch {
    return true;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function extractText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value
      .map((item) => extractText(item))
      .filter((item) => item.length > 0)
      .join(" ");
  }

  if (!isRecord(value)) {
    return "";
  }

  if (typeof value.text === "string") {
    return value.text;
  }

  if ("content" in value) {
    return extractText(value.content);
  }

  if ("parts" in value) {
    return extractText(value.parts);
  }

  return "";
}

function truncateMessage(message: string, maxLength = 80): string {
  if (message.length <= maxLength) {
    return message;
  }

  return `${message.slice(0, maxLength - 3)}...`;
}

function getStepSortKey(step: DevToolsStep): string {
  return `${String(step.stepNumber).padStart(8, "0")}:${step.startedAt}:${step.id}`;
}

function applyStepBackwardCompatibilityDefaults(step: DevToolsStep): DevToolsStep {
  return {
    ...step,
    rawRequest: step.rawRequest ?? null,
    requestHeaders: step.requestHeaders ?? null,
    responseHeaders: step.responseHeaders ?? null,
    rawResponse: step.rawResponse ?? null,
    rawChunks: step.rawChunks ?? null,
  };
}

type PendingRunMetadata = Partial<Pick<DevToolsRun, "toolPolicy">>;

export class DevToolsService extends EventEmitter {
  private readonly workspaces = new Map<string, WorkspaceData>();
  private readonly loadingPromises = new Map<string, Promise<void>>();
  private readonly writeQueues = new Map<string, Promise<void>>();

  /**
   * Queued run metadata grouped by workspace and request metadata ID.
   *
   * Multiple streamMessage calls can overlap within one workspace, so we keep
   * one pending metadata payload per request instead of a single workspace slot.
   */
  private readonly pendingRunMetadata = new Map<string, Map<string, PendingRunMetadata>>();

  constructor(
    private readonly config: Config,
    private readonly maxLogBytes: number = DEVTOOLS_LOG_MAX_BYTES
  ) {
    super();
  }

  get enabled(): boolean {
    return this.config.getLlmDebugLogsEnabled();
  }

  /**
   * Queue metadata to be merged into the next run created for this workspace.
   *
   * This bridges the timing gap between policy resolution in AIService (before
   * any provider call) and lazy run creation in DevTools middleware (on first
   * provider invocation). Metadata is consumed exactly once by createRun.
   */
  setPendingRunMetadata(
    workspaceId: string,
    metadataId: string,
    metadata: Partial<Pick<DevToolsRun, "toolPolicy">>
  ): void {
    assert(
      workspaceId.trim().length > 0,
      "DevToolsService.setPendingRunMetadata requires a workspaceId"
    );
    assert(
      metadataId.trim().length > 0,
      "DevToolsService.setPendingRunMetadata requires a metadataId"
    );

    if (!this.enabled) {
      return;
    }

    const byWorkspace =
      this.pendingRunMetadata.get(workspaceId) ?? new Map<string, PendingRunMetadata>();
    byWorkspace.set(metadataId, metadata);
    this.pendingRunMetadata.set(workspaceId, byWorkspace);
  }

  /**
   * Drop queued run metadata for a workspace.
   *
   * When metadataId is provided, clear only that request's entry.
   * This prevents one request's cleanup path from deleting metadata queued by
   * overlapping requests in the same workspace.
   */
  clearPendingRunMetadata(workspaceId: string, metadataId?: string): void {
    assert(
      workspaceId.trim().length > 0,
      "DevToolsService.clearPendingRunMetadata requires a workspaceId"
    );

    const byWorkspace = this.pendingRunMetadata.get(workspaceId);
    if (!byWorkspace) {
      return;
    }

    if (metadataId == null) {
      this.pendingRunMetadata.delete(workspaceId);
      return;
    }

    assert(
      metadataId.trim().length > 0,
      "DevToolsService.clearPendingRunMetadata requires a non-empty metadataId"
    );

    byWorkspace.delete(metadataId);
    if (byWorkspace.size === 0) {
      this.pendingRunMetadata.delete(workspaceId);
    }
  }

  async createRun(workspaceId: string, run: DevToolsRun, metadataId?: string): Promise<void> {
    if (!this.enabled) {
      return;
    }

    assert(workspaceId.trim().length > 0, "DevToolsService.createRun requires a workspaceId");
    assert(run.workspaceId === workspaceId, "DevToolsService.createRun run/workspace mismatch");

    await this.ensureLoaded(workspaceId);
    const data = this.getOrCreateWorkspaceData(workspaceId);

    // Apply queued run metadata (for example, effective tool policy) captured
    // before the stream reached provider middleware. Lookup is keyed by request
    // metadata ID so overlapping requests cannot overwrite each other.
    const byWorkspace = this.pendingRunMetadata.get(workspaceId);
    const normalizedMetadataId = metadataId?.trim();
    if (byWorkspace && normalizedMetadataId != null && normalizedMetadataId.length > 0) {
      const pendingMetadata = byWorkspace.get(normalizedMetadataId);
      if (pendingMetadata != null) {
        Object.assign(run, pendingMetadata);
        byWorkspace.delete(normalizedMetadataId);
      }

      if (byWorkspace.size === 0) {
        this.pendingRunMetadata.delete(workspaceId);
      }
    }

    data.runs.set(run.id, run);
    // Emit even when the append rejects (guarded against mid-append
    // eviction/clear): the run may already be durable (a rotation's snapshot
    // rename commits before a failed live-marker write throws), and memory,
    // which backs detail lookups, holds it either way; swallowing the event
    // would leave open panels inconsistent until resubscribe.
    const emitRunCreated = (): void => {
      if (!data.runs.has(run.id)) {
        return;
      }
      this.emitWorkspaceEvent(workspaceId, {
        type: "run-created",
        run: this.buildRunSummary(data, run.id),
      });
    };
    try {
      await this.appendToFile(workspaceId, { type: "run", run });
    } catch (error) {
      emitRunCreated();
      throw error;
    }
    emitRunCreated();
  }

  async createStep(workspaceId: string, step: DevToolsStep): Promise<void> {
    if (!this.enabled) {
      return;
    }

    assert(workspaceId.trim().length > 0, "DevToolsService.createStep requires a workspaceId");
    assert(step.runId.trim().length > 0, "DevToolsService.createStep requires step.runId");

    await this.ensureLoaded(workspaceId);
    const data = this.getOrCreateWorkspaceData(workspaceId);

    // Self-healing: if the run was cleared during an active stream,
    // recreate it so steps aren't orphaned.
    if (!data.runs.has(step.runId)) {
      const autoRun: DevToolsRun = {
        id: step.runId,
        workspaceId,
        startedAt: step.startedAt,
      };
      data.runs.set(autoRun.id, autoRun);
      // Emit-on-failure rationale in createRun.
      const emitAutoRunCreated = (): void => {
        if (!data.runs.has(autoRun.id)) {
          return;
        }
        this.emitWorkspaceEvent(workspaceId, {
          type: "run-created",
          run: this.buildRunSummary(data, autoRun.id),
        });
      };
      try {
        await this.appendToFile(workspaceId, { type: "run", run: autoRun });
      } catch (error) {
        emitAutoRunCreated();
        throw error;
      }
      emitAutoRunCreated();
    }

    data.steps.set(step.id, step);
    // The append itself can trigger a rotation that evicts this step's run;
    // emitting after the runs-evicted event would resurrect it in open
    // panels. Emit-on-failure rationale in createRun.
    const emitStepCreated = (): void => {
      if (!data.steps.has(step.id)) {
        return;
      }
      this.emitWorkspaceEvent(workspaceId, { type: "step-created", step });
      if (data.runs.has(step.runId)) {
        const summary = this.buildRunSummary(data, step.runId);
        this.emitWorkspaceEvent(workspaceId, { type: "run-updated", run: summary });
      }
    };
    try {
      await this.appendToFile(workspaceId, { type: "step", step });
    } catch (error) {
      emitStepCreated();
      throw error;
    }
    emitStepCreated();
  }

  async updateStep(
    workspaceId: string,
    stepId: string,
    update: Partial<DevToolsStep>
  ): Promise<void> {
    assert(workspaceId.trim().length > 0, "DevToolsService.updateStep requires a workspaceId");
    assert(stepId.trim().length > 0, "DevToolsService.updateStep requires stepId");

    await this.ensureLoaded(workspaceId);
    const data = this.getOrCreateWorkspaceData(workspaceId);

    const existing = data.steps.get(stepId);
    if (!existing) {
      log.warn(
        `DevToolsService.updateStep skipped missing step ${stepId} in workspace ${workspaceId}`
      );
      return;
    }

    const mergedStep: DevToolsStep = {
      ...existing,
      ...update,
    };
    data.steps.set(stepId, mergedStep);

    // The append itself can trigger a rotation that evicts this step's run
    // (a final step-update crossing the cap completes the run); emitting
    // after the runs-evicted event would resurrect the step in open panels.
    // Emit-on-failure rationale in createRun.
    const emitStepUpdated = (): void => {
      if (!data.steps.has(stepId)) {
        return;
      }
      this.emitWorkspaceEvent(workspaceId, {
        type: "step-updated",
        step: mergedStep,
      });

      if (data.runs.has(mergedStep.runId)) {
        const summary = this.buildRunSummary(data, mergedStep.runId);
        this.emitWorkspaceEvent(workspaceId, { type: "run-updated", run: summary });
      }
    };
    try {
      await this.appendToFile(workspaceId, {
        type: "step-update",
        stepId,
        update,
      });
    } catch (error) {
      emitStepUpdated();
      throw error;
    }
    emitStepUpdated();
  }

  async finalizeStaleSteps(workspaceId: string): Promise<void> {
    // Stale cleanup runs regardless of the current enabled state: steps that were
    // started while logging was ON should be properly finalized even if the user
    // later disables debug logging.
    assert(
      workspaceId.trim().length > 0,
      "DevToolsService.finalizeStaleSteps requires a workspaceId"
    );

    await this.ensureLoaded(workspaceId);
    const data = this.getOrCreateWorkspaceData(workspaceId);
    await this.finalizeStaleStepsForLoadedWorkspace(workspaceId, data);
  }

  async getRuns(workspaceId: string): Promise<DevToolsRunSummary[]> {
    if (!this.enabled) {
      return [];
    }

    assert(workspaceId.trim().length > 0, "DevToolsService.getRuns requires a workspaceId");

    await this.ensureLoaded(workspaceId);
    const data = this.getOrCreateWorkspaceData(workspaceId);

    return Array.from(data.runs.keys())
      .map((runId) => this.buildRunSummary(data, runId))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  async getRunWithSteps(
    workspaceId: string,
    runId: string
  ): Promise<{ run: DevToolsRunSummary; steps: DevToolsStep[] } | null> {
    if (!this.enabled) {
      return null;
    }

    assert(workspaceId.trim().length > 0, "DevToolsService.getRunWithSteps requires a workspaceId");
    assert(runId.trim().length > 0, "DevToolsService.getRunWithSteps requires runId");

    await this.ensureLoaded(workspaceId);
    const data = this.getOrCreateWorkspaceData(workspaceId);

    if (!data.runs.has(runId)) {
      return null;
    }

    const summary = this.buildRunSummary(data, runId);
    const steps = Array.from(data.steps.values())
      .filter((step) => step.runId === runId)
      .sort((a, b) => getStepSortKey(a).localeCompare(getStepSortKey(b)));

    return {
      run: summary,
      steps,
    };
  }

  async clear(workspaceId: string): Promise<void> {
    assert(workspaceId.trim().length > 0, "DevToolsService.clear requires a workspaceId");

    // Wait for any in-flight load to finish before clearing, otherwise the
    // pending loadFromDisk can repopulate stale data after the clear.
    const pendingLoad = this.loadingPromises.get(workspaceId);
    if (pendingLoad) {
      await pendingLoad;
    }

    const data = this.getOrCreateWorkspaceData(workspaceId);
    data.runs.clear();
    data.steps.clear();
    // Queued base repairs belong to cleared runs; flushing them after the
    // clear would resurrect those runs on the next load.
    data.pendingLiveRepairs = [];
    data.clearGeneration += 1;
    data.loaded = true;
    this.pendingRunMetadata.delete(workspaceId);

    // Enqueue so clear() cannot race with pending appends. An empty snapshot
    // pair (instead of truncate-then-remove) keeps an interrupted clear
    // cleared: after the snapshot rename commits, a leftover live log is
    // stale by generation and skipped on the next load.
    let markerError: Error | undefined;
    await this.enqueueWrite(workspaceId, async () => {
      markerError = await this.commitSnapshotPair(
        workspaceId,
        data,
        this.getSessionFilePath(workspaceId),
        []
      );
    });

    // A marker-write failure happens after the snapshot rename committed the
    // clear: memory, detail lookups, and future restarts are already empty,
    // so subscribers must drop their run cards before the failure propagates.
    this.emitWorkspaceEvent(workspaceId, { type: "cleared" });
    if (markerError !== undefined) {
      throw markerError;
    }
  }

  /**
   * Remove all DevTools state for a workspace: in-memory data and the on-disk
   * devtools.jsonl. Called when a workspace is archived or removed — debug logs
   * grow large and are only useful for live workspaces (worst case after
   * unarchive is an empty DevTools panel).
   *
   * Runs regardless of `enabled`: files written while logging was on must be
   * cleaned up even if the user has since disabled debug logging.
   */
  async removeWorkspaceData(workspaceId: string): Promise<void> {
    assert(
      workspaceId.trim().length > 0,
      "DevToolsService.removeWorkspaceData requires a workspaceId"
    );

    // Wait for any in-flight load to finish so it cannot repopulate state
    // after the removal below.
    const pendingLoad = this.loadingPromises.get(workspaceId);
    if (pendingLoad) {
      await pendingLoad;
    }

    // Deleting the entry (rather than clearing it in place) makes stale queued
    // appends no-ops via the existence guard in appendToFile.
    this.workspaces.delete(workspaceId);
    this.pendingRunMetadata.delete(workspaceId);

    // Enqueue the deletion so it serializes behind any pending appends.
    await this.enqueueWrite(workspaceId, async () => {
      await fs.rm(this.getSessionFilePath(workspaceId), { force: true });
      await fs.rm(this.getRotatedFilePath(workspaceId), { force: true });
      // An interrupted rotation can leave a full compacted snapshot here.
      await fs.rm(this.getRotatedTmpFilePath(workspaceId), { force: true });
      // An interrupted marker write can leave its tmp file behind.
      await fs.rm(`${this.getSessionFilePath(workspaceId)}.tmp`, { force: true });
    });

    this.emitWorkspaceEvent(workspaceId, { type: "cleared" });
  }

  private emitWorkspaceEvent(workspaceId: string, event: DevToolsEvent): void {
    this.emit(`update:${workspaceId}`, event);
  }

  private getSessionFilePath(workspaceId: string): string {
    return path.join(this.config.getSessionDir(workspaceId), "devtools.jsonl");
  }

  private getRotatedFilePath(workspaceId: string): string {
    return `${this.getSessionFilePath(workspaceId)}${DEVTOOLS_LOG_ROTATED_SUFFIX}`;
  }

  private getRotatedTmpFilePath(workspaceId: string): string {
    return `${this.getRotatedFilePath(workspaceId)}.tmp`;
  }

  private getOrCreateWorkspaceData(workspaceId: string): WorkspaceData {
    let data = this.workspaces.get(workspaceId);
    if (data) {
      return data;
    }

    data = {
      runs: new Map<string, DevToolsRun>(),
      steps: new Map<string, DevToolsStep>(),
      loaded: false,
      clearGeneration: 0,
      logGeneration: 0,
      liveMarkerGeneration: 0,
      pendingLiveRepairs: [],
      liveTailMayBeTorn: false,
    };
    this.workspaces.set(workspaceId, data);
    return data;
  }

  private async ensureLoaded(workspaceId: string): Promise<void> {
    const data = this.getOrCreateWorkspaceData(workspaceId);
    if (data.loaded) {
      return;
    }

    // Serialize concurrent loads for the same workspace: if another call is already
    // loading this workspace, await its promise instead of starting a second load.
    // This prevents duplicate disk reads and — critically — prevents stale-step
    // finalization from running while a concurrent request has a legitimate
    // in-progress step.
    const existingPromise = this.loadingPromises.get(workspaceId);
    if (existingPromise) {
      await existingPromise;
      return;
    }

    const loadPromise = this.loadFromDisk(workspaceId, data);
    this.loadingPromises.set(workspaceId, loadPromise);
    try {
      await loadPromise;
    } finally {
      this.loadingPromises.delete(workspaceId);
    }
  }

  private async loadFromDisk(workspaceId: string, data: WorkspaceData): Promise<void> {
    const readOrNull = async (filePath: string): Promise<string | null> => {
      try {
        return await fs.readFile(filePath, "utf-8");
      } catch (error) {
        if (isRecord(error) && error.code === "ENOENT") {
          return null;
        }
        throw error;
      }
    };

    const rotatedRaw = await readOrNull(this.getRotatedFilePath(workspaceId));
    const livePath = this.getSessionFilePath(workspaceId);
    const liveRaw = await readOrNull(livePath);

    // Rotated log first so live-file step-updates can find their base records.
    if (rotatedRaw != null) {
      this.replayLogLines(workspaceId, data, rotatedRaw);
    }

    // A validly committed snapshot paired with a markerless live file means
    // either a downgraded pre-rotation binary rewrote (or cleared) the live
    // file, or a commit was interrupted before the live rewrite. The retire
    // sentinel separates them: without it, the live file is legacy and wins,
    // because replaying the snapshot would resurrect history the user
    // cleared while downgraded and discard the legacy binary's newer runs.
    // Entries recorded AFTER the sentinel equally prove a legacy writer:
    // a downgraded binary appending to an interrupted commit's live file
    // leaves the stale marker (or no marker) in place, so without this
    // check its writes would be discarded as stale. Generations reset to 0,
    // so appends continue markerless until the next rotation re-establishes
    // a snapshot/marker pair.
    if (
      data.logGeneration > 0 &&
      (hasLegacyEntriesAfterRetireSentinel(liveRaw, data.logGeneration) ||
        (isLegacyLiveLog(liveRaw) && !hasRetireSentinel(liveRaw, data.logGeneration)))
    ) {
      data.runs.clear();
      data.steps.clear();
      data.logGeneration = 0;
      data.liveMarkerGeneration = 0;
      if (liveRaw != null) {
        this.replayLogLines(workspaceId, data, liveRaw);
      }
      data.loaded = true;
      await this.finalizeStaleStepsForLoadedWorkspace(workspaceId, data);
      return;
    }

    if (liveRaw != null && !isStaleLiveLog(liveRaw, data.logGeneration)) {
      this.replayLogLines(workspaceId, data, liveRaw);
      data.liveMarkerGeneration = data.logGeneration;
    } else if (data.logGeneration > 0) {
      // A crash interrupted rotation (or clear) between the snapshot rename
      // and the live-log rewrite, leaving the live file stale or missing.
      // Replaying a stale file would resurrect dropped runs, and appends
      // landing before a marker exists would look pre-snapshot on the next
      // load, so finish the interrupted retirement instead.
      if (liveRaw != null) {
        log.warn("Skipping stale devtools.jsonl superseded by rotated snapshot", { workspaceId });
      }
      try {
        await this.writeLiveMarker(livePath, data.logGeneration);
        data.liveMarkerGeneration = data.logGeneration;
      } catch (error) {
        // Best-effort: the snapshot already replayed, so loading must not
        // fail on an unwritable session dir. The lagging marker generation
        // makes the next append retry this repair.
        log.warn("Failed to repair devtools.jsonl live marker on load", {
          workspaceId,
          error: String(error),
        });
      }
    }

    data.loaded = true;
    await this.finalizeStaleStepsForLoadedWorkspace(workspaceId, data);
  }

  private replayLogLines(workspaceId: string, data: WorkspaceData, raw: string): void {
    const lines = raw.split("\n");
    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }

      try {
        const entry = JSON.parse(line) as DevToolsLogEntry;
        switch (entry.type) {
          case "run": {
            data.runs.set(entry.run.id, entry.run);
            break;
          }
          case "step": {
            data.steps.set(entry.step.id, applyStepBackwardCompatibilityDefaults(entry.step));
            break;
          }
          case "step-update": {
            const existing = data.steps.get(entry.stepId);
            if (existing) {
              data.steps.set(
                entry.stepId,
                applyStepBackwardCompatibilityDefaults({
                  ...existing,
                  ...entry.update,
                })
              );
            }
            break;
          }
          case "snapshot-meta": {
            // A malformed generation would poison logGeneration: a string
            // yields NaN (every comparison fails, the repair branch is
            // skipped, appends are discarded on each restart) and an unsafe
            // number like 1e100 stops incrementing (generation + 1 ===
            // generation), so rotations reuse the generation and a stale
            // live marker can pass as current. The next rotation writes
            // generation + 1, so that increment must be safe too, or its
            // snapshot would be ignored on the following load and the stale
            // live log replayed. Ignore invalid metadata.
            if (
              Number.isSafeInteger(entry.generation) &&
              Number.isSafeInteger(entry.generation + 1) &&
              entry.generation >= 0
            ) {
              data.logGeneration = Math.max(data.logGeneration, entry.generation);
            }
            break;
          }
          case "log-meta":
          case "log-retire": {
            // Pairing is decided in loadFromDisk before replay; nothing to apply.
            break;
          }
          default: {
            log.warn("Skipping unknown devtools.jsonl entry type", {
              workspaceId,
            });
          }
        }
      } catch {
        log.warn("Skipping corrupted devtools.jsonl line");
      }
    }
  }

  private async finalizeStaleStepsForLoadedWorkspace(
    workspaceId: string,
    data: WorkspaceData
  ): Promise<void> {
    assert(
      data.loaded,
      "DevToolsService.finalizeStaleStepsForLoadedWorkspace requires loaded workspace data"
    );

    const staleSteps = Array.from(data.steps.values()).filter(
      (step) => step.durationMs == null && step.error == null
    );
    if (staleSteps.length === 0) {
      return;
    }

    const nowMs = Date.now();
    for (const step of staleSteps) {
      const startedAtMs = new Date(step.startedAt).getTime();
      const durationMs = Number.isFinite(startedAtMs) ? Math.max(0, nowMs - startedAtMs) : 0;

      await this.updateStep(workspaceId, step.id, {
        durationMs,
        error: "Interrupted (stale)",
      });
    }
  }

  private buildRunSummary(data: WorkspaceData, runId: string): DevToolsRunSummary {
    const run = data.runs.get(runId);
    assert(run, `DevToolsService.buildRunSummary missing run ${runId}`);

    const steps = Array.from(data.steps.values())
      .filter((step) => step.runId === runId)
      .sort((a, b) => getStepSortKey(a).localeCompare(getStepSortKey(b)));

    const firstStep = steps[0];

    let firstMessage = "";
    if (firstStep?.input && isRecord(firstStep.input)) {
      const prompt = firstStep.input.prompt;
      if (isUnknownArray(prompt)) {
        for (let index = prompt.length - 1; index >= 0; index -= 1) {
          const message = prompt[index];
          if (!isRecord(message) || message.role !== "user") {
            continue;
          }

          const text = extractText(message.content ?? message);
          if (!text.trim()) {
            continue;
          }

          firstMessage = truncateMessage(text.trim());
          break;
        }
      }
    }

    const hasError = steps.some((step) => Boolean(step.error));
    const isInProgress = steps.some((step) => step.durationMs == null && !step.error);

    let totalDurationMs: number | null = 0;
    for (const step of steps) {
      if (step.durationMs == null) {
        totalDurationMs = null;
        break;
      }
      totalDurationMs += step.durationMs;
    }

    return {
      ...run,
      stepCount: steps.length,
      firstMessage,
      hasError,
      isInProgress,
      totalDurationMs,
      modelId: firstStep?.modelId ?? null,
    };
  }

  /**
   * Serialize all disk writes per workspace so clear() and appendToFile()
   * can never complete out of order.
   */
  private enqueueWrite(workspaceId: string, fn: () => Promise<void>): Promise<void> {
    const prev = this.writeQueues.get(workspaceId) ?? Promise.resolve();
    // Always chain regardless of prior failure so the queue never stalls.
    const next = prev.then(fn, () => fn());
    this.writeQueues.set(workspaceId, next);
    return next;
  }

  private async appendToFile(workspaceId: string, entry: DevToolsLogEntry): Promise<void> {
    return this.enqueueWrite(workspaceId, async () => {
      // Defense-in-depth: skip stale writes after clear() by requiring current entities.
      const data = this.workspaces.get(workspaceId);
      if (!data) {
        return;
      }
      if (entry.type === "run" && !data.runs.has(entry.run.id)) {
        return;
      }
      if (entry.type === "step" && !data.steps.has(entry.step.id)) {
        return;
      }
      if (entry.type === "step-update" && !data.steps.has(entry.stepId)) {
        return;
      }

      const filePath = this.getSessionFilePath(workspaceId);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await this.appendWithMarkerRepair(data, filePath, `${JSON.stringify(entry)}\n`);

      // The write queue serializes rotation with appends and clear().
      const stats = await fs.stat(filePath);
      if (stats.size > this.maxLogBytes) {
        await this.rotateLog(workspaceId, data, filePath);
      }
    });
  }

  /**
   * Rotation compacts in-memory state into a self-contained rotated snapshot
   * instead of renaming the live file: the live file may hold step-updates
   * whose base records came from the previous rotated file, so a rename chain
   * would orphan them on the next rotation. Active runs (zero steps yet, or
   * any in-progress step) are always retained so their upcoming steps and
   * step-updates keep a persisted base record; completed runs fill the
   * remaining cap newest-first. Dropped
   * runs are also evicted from memory: a late createStep then self-heals by
   * recreating the run record, and a late updateStep no-ops, so the live file
   * never references entities missing from the snapshot.
   */
  private async rotateLog(
    workspaceId: string,
    data: WorkspaceData,
    filePath: string
  ): Promise<void> {
    const stepsByRun = new Map<string, DevToolsStep[]>();
    for (const step of data.steps.values()) {
      const list = stepsByRun.get(step.runId) ?? [];
      list.push(step);
      stepsByRun.set(step.runId, list);
    }
    // Zero-step runs are just-created: their createRun caller may still be
    // awaiting the queued append, and their first steps are in flight, so
    // evicting them would strand those operations without a base record.
    const isActiveRun = (runId: string): boolean => {
      const steps = stepsByRun.get(runId);
      if (steps == null || steps.length === 0) {
        return true;
      }
      return steps.some((step) => step.durationMs == null && step.error == null);
    };

    const runsNewestFirst = Array.from(data.runs.values()).sort((a, b) =>
      b.startedAt.localeCompare(a.startedAt)
    );
    const retainedChunks: string[][] = [];
    const retainedRunIds = new Set<string>();
    let retainedBytes = 0;
    for (const run of runsNewestFirst) {
      const lines = [JSON.stringify({ type: "run", run } satisfies DevToolsLogEntry)];
      for (const step of stepsByRun.get(run.id) ?? []) {
        lines.push(JSON.stringify({ type: "step", step } satisfies DevToolsLogEntry));
      }
      const chunkBytes = lines.reduce(
        (total, line) => total + Buffer.byteLength(line, "utf-8") + 1,
        0
      );
      const overCap = retainedChunks.length > 0 && retainedBytes + chunkBytes > this.maxLogBytes;
      // The newest run and active runs are retained even over the cap.
      if (overCap && !isActiveRun(run.id)) {
        continue;
      }
      retainedChunks.push(lines);
      retainedRunIds.add(run.id);
      retainedBytes += chunkBytes;
    }
    // Chronological order for readability; replay only needs base-before-update.
    retainedChunks.reverse();

    const frozenStepIds = new Set<string>();
    for (const steps of stepsByRun.values()) {
      for (const step of steps) {
        frozenStepIds.add(step.id);
      }
    }
    const frozenClearGeneration = data.clearGeneration;

    const markerError = await this.commitSnapshotPair(workspaceId, data, filePath, retainedChunks);

    // clear() during the snapshot I/O empties the maps and queues an empty
    // snapshot commit behind this rotation, making every frozen retention
    // decision stale. Anything now in the maps is a post-clear recreation
    // that can reuse a frozen run ID with no steps inserted yet; evicting it
    // would make its queued base append skip and strand the first post-clear
    // step (createStep would then throw on the missing run).
    if (data.clearGeneration !== frozenClearGeneration) {
      if (markerError !== undefined) {
        throw markerError;
      }
      return;
    }

    // Eviction is restricted to the decision set frozen above: overlapping
    // provider calls can add runs and steps while commitSnapshotPair awaits
    // filesystem I/O, and those entities were never considered for the
    // snapshot, so deleting them would strand their in-flight operations.
    // Reconciliation runs even when the live-marker write failed: the
    // snapshot rename already committed the retention decision, so leaving
    // dropped runs in memory would let later appends target runs whose
    // records exist nowhere durable.
    let repairError: Error | undefined;
    const evictedRunIds: string[] = [];
    for (const run of runsNewestFirst) {
      // A clear landing during the repair await below supersedes the frozen
      // decision set, exactly like the pre-loop check: later iterations
      // would evict post-clear recreations or re-persist cleared history.
      if (data.clearGeneration !== frozenClearGeneration) {
        break;
      }
      if (retainedRunIds.has(run.id)) {
        continue;
      }
      const liveRun = data.runs.get(run.id);
      const midIoSteps = Array.from(data.steps.values()).filter(
        (step) => step.runId === run.id && !frozenStepIds.has(step.id)
      );
      if (liveRun != null && midIoSteps.length > 0) {
        // The run gained activity mid-I/O after losing its snapshot spot.
        // Keep it and re-persist its base records into the fresh live file
        // so the new steps (whose queued appends land next) stay replayable.
        const lines = [JSON.stringify({ type: "run", run: liveRun } satisfies DevToolsLogEntry)];
        for (const step of stepsByRun.get(run.id) ?? []) {
          lines.push(JSON.stringify({ type: "step", step } satisfies DevToolsLogEntry));
        }
        try {
          await this.appendWithMarkerRepair(data, filePath, `${lines.join("\n")}\n`);
        } catch (error) {
          // Keep the run in memory and queue the base records as a pending
          // repair: the queued step appends that motivated keeping this run
          // must not land without them, or the next load would orphan the
          // steps and drop the run. Replay is Map.set-idempotent, so a
          // partially-written repair retried later is harmless. A clear that
          // landed during this failed append already emptied the repair
          // queue; requeueing these pre-clear base records would flush them
          // on the next successful append and resurrect cleared history.
          if (data.clearGeneration === frozenClearGeneration) {
            data.pendingLiveRepairs.push(`${lines.join("\n")}\n`);
          }
          repairError ??= error instanceof Error ? error : new Error(String(error));
        }
        continue;
      }
      evictedRunIds.push(run.id);
      data.runs.delete(run.id);
      for (const step of stepsByRun.get(run.id) ?? []) {
        data.steps.delete(step.id);
      }
    }
    if (evictedRunIds.length > 0) {
      // Open DevTools panels must drop evicted run cards.
      this.emitWorkspaceEvent(workspaceId, { type: "runs-evicted", runIds: evictedRunIds });
    }
    const firstError = markerError ?? repairError;
    if (firstError !== undefined) {
      throw firstError;
    }
  }

  /**
   * Commits a snapshot/live-log pair. Write-then-rename keeps the previous
   * snapshot intact if the write is interrupted; rename replaces the
   * destination in one step (POSIX rename, MOVEFILE_REPLACE_EXISTING on
   * Windows), so no crash window exists where neither snapshot is on disk.
   * The generation pair makes live-log retirement recoverable: if the
   * process dies before the live file is rewritten, its stale generation
   * tells the next load to skip it instead of resurrecting runs the snapshot
   * deliberately dropped. clear() commits an empty snapshot through the same
   * protocol so an interrupted clear stays cleared.
   *
   * A live-marker write failure after the rename is returned instead of
   * thrown: the snapshot is committed at that point, so callers must finish
   * reconciling in-memory state with it before propagating the failure.
   */
  private async commitSnapshotPair(
    workspaceId: string,
    data: WorkspaceData,
    filePath: string,
    chunks: string[][]
  ): Promise<Error | undefined> {
    const rotatedPath = this.getRotatedFilePath(workspaceId);
    // The load guard rejects a generation whose own increment is unsafe, so
    // the value written here must stay one increment below that ceiling or
    // the next load would ignore this snapshot and replay the stale live
    // log. Restart the sequence instead; pairing is by strict equality plus
    // the retire sentinel, so a restart cannot mis-pair this commit's files.
    const generation = Number.isSafeInteger(data.logGeneration + 2) ? data.logGeneration + 1 : 1;
    const tmpPath = this.getRotatedTmpFilePath(workspaceId);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    // Retire sentinel before the snapshot commit: if a crash leaves a
    // markerless live file next to the renamed snapshot, this line marks it
    // as an interrupted commit (snapshot wins) rather than a legacy
    // pre-rotation rewrite (live wins). The live rewrite below discards it
    // on success, and replay ignores it.
    await this.appendToLiveFile(
      data,
      filePath,
      `${JSON.stringify({ type: "log-retire", generation } satisfies DevToolsLogEntry)}\n`
    );
    await fs.writeFile(
      tmpPath,
      [
        `${JSON.stringify({ type: "snapshot-meta", generation } satisfies DevToolsLogEntry)}\n`,
        ...chunks.map((lines) => `${lines.join("\n")}\n`),
      ].join(""),
      "utf-8"
    );
    await fs.rename(tmpPath, rotatedPath);
    // The snapshot is committed once the rename lands: advance the in-memory
    // generation before the live-marker write so a marker failure (e.g.
    // ENOSPC) leaves the append path knowing a repair is needed.
    data.logGeneration = generation;
    try {
      await this.writeLiveMarker(filePath, generation);
      data.liveMarkerGeneration = generation;
      // The marker rewrite replaced the whole file, discarding any torn tail.
      data.liveTailMayBeTorn = false;
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
    return undefined;
  }

  /**
   * Appends after repairing a lagging live marker: a snapshot committed but
   * its live-marker write failed, so entries appended before the repair
   * would be discarded as pre-snapshot on the next load. The stale content
   * being truncated is already superseded by the committed snapshot.
   */
  private async appendWithMarkerRepair(
    data: WorkspaceData,
    filePath: string,
    content: string
  ): Promise<void> {
    if (data.liveMarkerGeneration !== data.logGeneration) {
      await this.writeLiveMarker(filePath, data.logGeneration);
      data.liveMarkerGeneration = data.logGeneration;
      // The marker rewrite replaced the whole file, discarding any torn tail.
      data.liveTailMayBeTorn = false;
    }
    // Failed rotation-time base repairs must land before this append (see
    // pendingLiveRepairs); a failure here rejects the append too, so a step
    // can never be persisted ahead of its run's base records. Each retry
    // keeps an unconditional leading newline: the failed attempt that
    // queued it may have bypassed the torn-tail flag (it can fail between
    // sub-writes), and duplicated records from a fully-written-but-rejected
    // attempt are harmless because replay is Map.set-idempotent.
    while (data.pendingLiveRepairs.length > 0) {
      await this.appendToLiveFile(data, filePath, `\n${data.pendingLiveRepairs[0]}`);
      data.pendingLiveRepairs.shift();
    }
    await this.appendToLiveFile(data, filePath, content);
  }

  /**
   * All live-file appends go through this seal. A previously failed append
   * may have written a partial fragment as the file's tail; appending
   * directly onto it would merge the fragment with this content into one
   * malformed line that replay skips, losing this record too. A leading
   * newline instead seals the fragment as its own malformed line. A failure
   * here may itself be partial, so it re-arms the seal.
   */
  private async appendToLiveFile(
    data: WorkspaceData,
    filePath: string,
    content: string
  ): Promise<void> {
    const sealed = data.liveTailMayBeTorn ? `\n${content}` : content;
    try {
      await fs.appendFile(filePath, sealed, "utf-8");
      data.liveTailMayBeTorn = false;
    } catch (error) {
      data.liveTailMayBeTorn = true;
      throw error;
    }
  }

  private async writeLiveMarker(filePath: string, generation: number): Promise<void> {
    // Atomic tmp+rename: a crash mid-write must not leave an empty or
    // partial live file, which the loader would misread as a legacy
    // (pre-rotation) rewrite and skip the snapshot for.
    const tmpPath = `${filePath}.tmp`;
    await fs.writeFile(
      tmpPath,
      `${JSON.stringify({ type: "log-meta", generation } satisfies DevToolsLogEntry)}\n`,
      "utf-8"
    );
    await fs.rename(tmpPath, filePath);
  }
}
