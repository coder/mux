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
import { log } from "@/node/services/log";

interface WorkspaceData {
  runs: Map<string, DevToolsRun>;
  steps: Map<string, DevToolsStep>;
  loaded: boolean;
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

export class DevToolsService extends EventEmitter {
  private readonly workspaces = new Map<string, WorkspaceData>();

  constructor(private readonly config: Config) {
    super();
  }

  get enabled(): boolean {
    return this.config.getLlmDebugLogsEnabled();
  }

  async createRun(workspaceId: string, run: DevToolsRun): Promise<void> {
    if (!this.enabled) {
      return;
    }

    assert(workspaceId.trim().length > 0, "DevToolsService.createRun requires a workspaceId");
    assert(run.workspaceId === workspaceId, "DevToolsService.createRun run/workspace mismatch");

    await this.ensureLoaded(workspaceId);
    const data = this.getOrCreateWorkspaceData(workspaceId);

    data.runs.set(run.id, run);
    await this.appendToFile(workspaceId, { type: "run", run });

    const summary = this.buildRunSummary(data, run.id);
    this.emitWorkspaceEvent(workspaceId, { type: "run-created", run: summary });
  }

  async createStep(workspaceId: string, step: DevToolsStep): Promise<void> {
    if (!this.enabled) {
      return;
    }

    assert(workspaceId.trim().length > 0, "DevToolsService.createStep requires a workspaceId");
    assert(step.runId.trim().length > 0, "DevToolsService.createStep requires step.runId");

    await this.ensureLoaded(workspaceId);
    const data = this.getOrCreateWorkspaceData(workspaceId);

    data.steps.set(step.id, step);
    await this.appendToFile(workspaceId, { type: "step", step });

    this.emitWorkspaceEvent(workspaceId, { type: "step-created", step });
    if (data.runs.has(step.runId)) {
      const summary = this.buildRunSummary(data, step.runId);
      this.emitWorkspaceEvent(workspaceId, { type: "run-updated", run: summary });
    }
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

    await this.appendToFile(workspaceId, {
      type: "step-update",
      stepId,
      update,
    });

    this.emitWorkspaceEvent(workspaceId, {
      type: "step-updated",
      step: mergedStep,
    });

    if (data.runs.has(mergedStep.runId)) {
      const summary = this.buildRunSummary(data, mergedStep.runId);
      this.emitWorkspaceEvent(workspaceId, { type: "run-updated", run: summary });
    }
  }

  async finalizeStaleSteps(workspaceId: string): Promise<void> {
    if (!this.enabled) {
      return;
    }

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

    const data = this.getOrCreateWorkspaceData(workspaceId);
    data.runs.clear();
    data.steps.clear();
    data.loaded = true;

    const filePath = this.getSessionFilePath(workspaceId);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, "", "utf-8");

    this.emitWorkspaceEvent(workspaceId, { type: "cleared" });
  }

  private emitWorkspaceEvent(workspaceId: string, event: DevToolsEvent): void {
    this.emit(`update:${workspaceId}`, event);
  }

  private getSessionFilePath(workspaceId: string): string {
    return path.join(this.config.getSessionDir(workspaceId), "devtools.jsonl");
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
    };
    this.workspaces.set(workspaceId, data);
    return data;
  }

  private async ensureLoaded(workspaceId: string): Promise<void> {
    const data = this.getOrCreateWorkspaceData(workspaceId);
    if (data.loaded) {
      return;
    }

    const filePath = this.getSessionFilePath(workspaceId);
    let raw = "";

    try {
      raw = await fs.readFile(filePath, "utf-8");
    } catch (error) {
      if (isRecord(error) && error.code === "ENOENT") {
        data.loaded = true;
        return;
      }
      throw error;
    }

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

    data.loaded = true;
    await this.finalizeStaleStepsForLoadedWorkspace(workspaceId, data);
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

  private async appendToFile(workspaceId: string, entry: DevToolsLogEntry): Promise<void> {
    const filePath = this.getSessionFilePath(workspaceId);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.appendFile(filePath, `${JSON.stringify(entry)}\n`, "utf-8");
  }
}
