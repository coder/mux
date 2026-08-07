import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import type { DevToolsEvent, DevToolsRun, DevToolsStep } from "@/common/types/devtools";
import { Config } from "@/node/config";
import { DevToolsService } from "@/node/services/devToolsService";

function makeRun(id: string, startedAt = "2025-06-01T00:00:00Z"): DevToolsRun {
  return { id, workspaceId: "ws-1", startedAt };
}

function makeStep(overrides: Partial<DevToolsStep> & { id: string; runId: string }): DevToolsStep {
  const { id, runId, ...rest } = overrides;

  return {
    id,
    runId,
    stepNumber: 1,
    type: "generate",
    modelId: "test-model",
    provider: null,
    startedAt: "2025-06-01T00:00:00Z",
    durationMs: 100,
    input: null,
    output: null,
    usage: null,
    error: null,
    rawRequest: null,
    requestHeaders: null,
    responseHeaders: null,
    rawResponse: null,
    rawChunks: null,
    ...rest,
  };
}

function createTestConfig(opts: { sessionsDir: string; enabled?: boolean }): Config {
  const config = new Config(opts.sessionsDir);
  spyOn(config, "getSessionDir").mockImplementation((workspaceId: string) =>
    path.join(opts.sessionsDir, workspaceId)
  );
  spyOn(config, "getLlmDebugLogsEnabled").mockImplementation(() => opts.enabled ?? true);
  return config;
}

function getDevtoolsLogPath(sessionsDir: string, workspaceId: string): string {
  return path.join(sessionsDir, workspaceId, "devtools.jsonl");
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function countStaleStepUpdates(logContents: string, stepId: string): number {
  return logContents.split("\n").reduce((count, line) => {
    if (!line.trim()) {
      return count;
    }

    try {
      const parsed = JSON.parse(line) as {
        type?: unknown;
        stepId?: unknown;
        update?: { error?: unknown } | null;
      };

      if (
        parsed.type === "step-update" &&
        parsed.stepId === stepId &&
        parsed.update?.error === "Interrupted (stale)"
      ) {
        return count + 1;
      }
    } catch {
      // Ignore malformed test fixture lines while counting stale-step updates.
    }

    return count;
  }, 0);
}

describe("DevToolsService", () => {
  let tempDir: string;
  let sessionsDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-devtools-service-test-"));
    sessionsDir = path.join(tempDir, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe("when disabled", () => {
    it("createRun/createStep are no-ops, getRuns returns empty, and no file is written", async () => {
      const config = createTestConfig({ sessionsDir, enabled: false });
      const service = new DevToolsService(config);

      await service.createRun("ws-1", makeRun("run-1"));
      await service.createStep("ws-1", makeStep({ id: "step-1", runId: "run-1" }));

      expect(await service.getRuns("ws-1")).toEqual([]);
      expect(await pathExists(getDevtoolsLogPath(sessionsDir, "ws-1"))).toBe(false);
    });

    it("finalizeStaleSteps still finalizes persisted stale data when logging is disabled", async () => {
      const config = createTestConfig({ sessionsDir, enabled: false });
      const run = makeRun("run-1");
      const staleStep = makeStep({
        id: "step-stale",
        runId: "run-1",
        durationMs: null,
        error: null,
      });
      const logPath = getDevtoolsLogPath(sessionsDir, "ws-1");

      await fs.mkdir(path.dirname(logPath), { recursive: true });
      await fs.writeFile(
        logPath,
        `${JSON.stringify({ type: "run", run })}\n${JSON.stringify({ type: "step", step: staleStep })}\n`,
        "utf-8"
      );

      const service = new DevToolsService(config);
      await service.finalizeStaleSteps("ws-1");

      const logAfterFirstFinalize = await fs.readFile(logPath, "utf-8");
      expect(countStaleStepUpdates(logAfterFirstFinalize, staleStep.id)).toBe(1);

      await service.finalizeStaleSteps("ws-1");
      const logAfterSecondFinalize = await fs.readFile(logPath, "utf-8");
      expect(countStaleStepUpdates(logAfterSecondFinalize, staleStep.id)).toBe(1);
    });
  });

  describe("when enabled", () => {
    it("createRun stores run and returns a summary with stepCount=0", async () => {
      const service = new DevToolsService(createTestConfig({ sessionsDir, enabled: true }));

      await service.createRun("ws-1", makeRun("run-1"));

      const runs = await service.getRuns("ws-1");
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({
        id: "run-1",
        workspaceId: "ws-1",
        stepCount: 0,
        firstMessage: "",
        hasError: false,
        isInProgress: false,
        totalDurationMs: 0,
        modelId: null,
      });
    });

    it("applies pending toolPolicy metadata to the next run", async () => {
      const config = createTestConfig({ sessionsDir, enabled: true });
      const service = new DevToolsService(config);
      const policy = [
        { regex_match: "propose_plan", action: "require" as const },
        { regex_match: "agent_report", action: "disable" as const },
      ];
      const metadataId = "metadata-1";

      service.setPendingRunMetadata("ws-1", metadataId, { toolPolicy: policy });
      await service.createRun("ws-1", makeRun("run-1"), metadataId);

      const runs = await service.getRuns("ws-1");
      expect(runs).toHaveLength(1);
      expect(runs[0]?.toolPolicy).toEqual(policy);
    });

    it("persists toolPolicy metadata in jsonl replay", async () => {
      const config = createTestConfig({ sessionsDir, enabled: true });
      const service1 = new DevToolsService(config);
      const policy = [{ regex_match: "bash", action: "disable" as const }];
      const metadataId = "metadata-2";

      service1.setPendingRunMetadata("ws-1", metadataId, { toolPolicy: policy });
      await service1.createRun("ws-1", makeRun("run-1"), metadataId);

      const service2 = new DevToolsService(config);
      const runs = await service2.getRuns("ws-1");
      expect(runs).toHaveLength(1);
      expect(runs[0]?.toolPolicy).toEqual(policy);
    });

    it("does not set toolPolicy when no pending metadata exists", async () => {
      const service = new DevToolsService(createTestConfig({ sessionsDir, enabled: true }));

      await service.createRun("ws-1", makeRun("run-1"));

      const runs = await service.getRuns("ws-1");
      expect(runs).toHaveLength(1);
      expect(runs[0]?.toolPolicy).toBeUndefined();
    });

    it("consumes pending metadata once", async () => {
      const service = new DevToolsService(createTestConfig({ sessionsDir, enabled: true }));
      const policy = [{ regex_match: ".*", action: "enable" as const }];
      const metadataId = "metadata-3";

      service.setPendingRunMetadata("ws-1", metadataId, { toolPolicy: policy });
      await service.createRun("ws-1", makeRun("run-1", "2025-06-01T00:00:00Z"), metadataId);
      await service.createRun("ws-1", makeRun("run-2", "2025-06-01T00:01:00Z"));

      const runs = await service.getRuns("ws-1");
      const run1 = runs.find((run) => run.id === "run-1");
      const run2 = runs.find((run) => run.id === "run-2");

      expect(run1?.toolPolicy).toEqual(policy);
      expect(run2?.toolPolicy).toBeUndefined();
    });

    it("stores pending metadata per metadata id for overlapping requests", async () => {
      const service = new DevToolsService(createTestConfig({ sessionsDir, enabled: true }));
      const policyA = [{ regex_match: "propose_plan", action: "require" as const }];
      const policyB = [{ regex_match: "task_.*", action: "disable" as const }];

      service.setPendingRunMetadata("ws-1", "metadata-a", { toolPolicy: policyA });
      service.setPendingRunMetadata("ws-1", "metadata-b", { toolPolicy: policyB });

      await service.createRun("ws-1", makeRun("run-1", "2025-06-01T00:00:00Z"), "metadata-a");
      await service.createRun("ws-1", makeRun("run-2", "2025-06-01T00:01:00Z"), "metadata-b");

      const runs = await service.getRuns("ws-1");
      const run1 = runs.find((run) => run.id === "run-1");
      const run2 = runs.find((run) => run.id === "run-2");

      expect(run1?.toolPolicy).toEqual(policyA);
      expect(run2?.toolPolicy).toEqual(policyB);
    });

    it("retains pending metadata when metadata id does not match", async () => {
      const service = new DevToolsService(createTestConfig({ sessionsDir, enabled: true }));
      const policy = [{ regex_match: ".*", action: "disable" as const }];

      service.setPendingRunMetadata("ws-1", "stale-metadata", { toolPolicy: policy });
      await service.createRun("ws-1", makeRun("run-1"), "different-metadata");
      await service.createRun("ws-1", makeRun("run-2", "2025-06-01T00:01:00Z"), "stale-metadata");

      const runs = await service.getRuns("ws-1");
      const run1 = runs.find((run) => run.id === "run-1");
      const run2 = runs.find((run) => run.id === "run-2");
      expect(run1?.toolPolicy).toBeUndefined();
      expect(run2?.toolPolicy).toEqual(policy);
    });

    it("clearPendingRunMetadata only clears matching metadata id", async () => {
      const service = new DevToolsService(createTestConfig({ sessionsDir, enabled: true }));
      const policy = [{ regex_match: ".*", action: "require" as const }];

      service.setPendingRunMetadata("ws-1", "metadata-keep", { toolPolicy: policy });
      service.clearPendingRunMetadata("ws-1", "metadata-other");
      await service.createRun("ws-1", makeRun("run-1"), "metadata-keep");

      const runs = await service.getRuns("ws-1");
      expect(runs[0]?.toolPolicy).toEqual(policy);
    });

    it("createStep stores step and getRunWithSteps returns it", async () => {
      const service = new DevToolsService(createTestConfig({ sessionsDir, enabled: true }));
      await service.createRun("ws-1", makeRun("run-1"));

      const step = makeStep({
        id: "step-1",
        runId: "run-1",
        input: {
          prompt: [
            { role: "system", content: "be helpful" },
            {
              role: "user",
              content: [{ type: "text", text: "hello from user prompt" }],
            },
          ],
        },
      });

      await service.createStep("ws-1", step);

      const runWithSteps = await service.getRunWithSteps("ws-1", "run-1");
      expect(runWithSteps).not.toBeNull();
      expect(runWithSteps?.steps).toEqual([step]);
      expect(runWithSteps?.run.firstMessage).toBe("hello from user prompt");
    });

    it("sets isInProgress=true when a step has null duration", async () => {
      const service = new DevToolsService(createTestConfig({ sessionsDir, enabled: true }));
      await service.createRun("ws-1", makeRun("run-1"));

      await service.createStep(
        "ws-1",
        makeStep({
          id: "step-1",
          runId: "run-1",
          durationMs: null,
        })
      );

      const runs = await service.getRuns("ws-1");
      expect(runs).toHaveLength(1);
      expect(runs[0]?.isInProgress).toBe(true);
      expect(runs[0]?.totalDurationMs).toBeNull();
    });

    it("finalizeStaleSteps marks in-progress steps as interrupted", async () => {
      const service = new DevToolsService(createTestConfig({ sessionsDir, enabled: true }));
      await service.createRun("ws-1", makeRun("run-1"));
      await service.createStep("ws-1", makeStep({ id: "s-1", runId: "run-1", durationMs: null }));
      await service.createStep("ws-1", makeStep({ id: "s-2", runId: "run-1", durationMs: 500 }));

      await service.finalizeStaleSteps("ws-1");

      const detail = await service.getRunWithSteps("ws-1", "run-1");
      expect(detail).not.toBeNull();

      const staleStep = detail?.steps.find((step) => step.id === "s-1");
      expect(staleStep).toBeDefined();
      expect(staleStep?.error).toBe("Interrupted (stale)");
      expect(staleStep?.durationMs).not.toBeNull();

      const completeStep = detail?.steps.find((step) => step.id === "s-2");
      expect(completeStep).toBeDefined();
      expect(completeStep?.error).toBeNull();
      expect(completeStep?.durationMs).toBe(500);
    });

    it("updateStep merges fields", async () => {
      const service = new DevToolsService(createTestConfig({ sessionsDir, enabled: true }));
      await service.createRun("ws-1", makeRun("run-1"));
      await service.createStep("ws-1", makeStep({ id: "step-1", runId: "run-1" }));

      await service.updateStep("ws-1", "step-1", {
        durationMs: 250,
        output: { finishReason: "stop" },
        usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
      });

      const runWithSteps = await service.getRunWithSteps("ws-1", "run-1");
      expect(runWithSteps).not.toBeNull();
      expect(runWithSteps?.steps[0]).toMatchObject({
        id: "step-1",
        durationMs: 250,
        output: { finishReason: "stop" },
        usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
      });
    });

    it("updateStep with error marks run summary hasError=true", async () => {
      const service = new DevToolsService(createTestConfig({ sessionsDir, enabled: true }));
      await service.createRun("ws-1", makeRun("run-1"));
      await service.createStep("ws-1", makeStep({ id: "step-1", runId: "run-1" }));

      await service.updateStep("ws-1", "step-1", {
        error: "request failed",
      });

      const runs = await service.getRuns("ws-1");
      expect(runs).toHaveLength(1);
      expect(runs[0]?.hasError).toBe(true);
    });

    it("getRuns returns runs sorted by startedAt descending", async () => {
      const service = new DevToolsService(createTestConfig({ sessionsDir, enabled: true }));

      await service.createRun("ws-1", makeRun("run-old", "2025-06-01T00:00:00Z"));
      await service.createRun("ws-1", makeRun("run-new", "2025-06-02T00:00:00Z"));

      const runs = await service.getRuns("ws-1");
      expect(runs.map((run) => run.id)).toEqual(["run-new", "run-old"]);
    });

    it("isolates data per workspace", async () => {
      const service = new DevToolsService(createTestConfig({ sessionsDir, enabled: true }));

      await service.createRun("ws-1", makeRun("run-1"));
      await service.createRun("ws-2", { ...makeRun("run-2"), workspaceId: "ws-2" });

      const ws1Runs = await service.getRuns("ws-1");
      const ws2Runs = await service.getRuns("ws-2");

      expect(ws1Runs.map((run) => run.id)).toEqual(["run-1"]);
      expect(ws2Runs.map((run) => run.id)).toEqual(["run-2"]);
    });

    it("clear removes all workspace data", async () => {
      const service = new DevToolsService(createTestConfig({ sessionsDir, enabled: true }));
      await service.createRun("ws-1", makeRun("run-1"));
      await service.createStep("ws-1", makeStep({ id: "step-1", runId: "run-1" }));

      await service.clear("ws-1");

      expect(await service.getRuns("ws-1")).toEqual([]);
      expect(await service.getRunWithSteps("ws-1", "run-1")).toBeNull();
      // Only the generation marker remains on disk.
      expect(
        (await fs.readFile(getDevtoolsLogPath(sessionsDir, "ws-1"), "utf-8"))
          .split("\n")
          .filter(Boolean)
          .map((line) => (JSON.parse(line) as { type: string }).type)
      ).toEqual(["log-meta"]);
    });

    it("removeWorkspaceData deletes the log file and in-memory state", async () => {
      const service = new DevToolsService(createTestConfig({ sessionsDir, enabled: true }));
      await service.createRun("ws-1", makeRun("run-1"));
      await service.createStep("ws-1", makeStep({ id: "step-1", runId: "run-1" }));

      await service.removeWorkspaceData("ws-1");

      expect(await pathExists(getDevtoolsLogPath(sessionsDir, "ws-1"))).toBe(false);
      expect(await service.getRuns("ws-1")).toEqual([]);
      expect(await service.getRunWithSteps("ws-1", "run-1")).toBeNull();
    });

    it("removeWorkspaceData deletes stale log files even when logging is disabled", async () => {
      // Simulate a file written while logging was enabled, then the user disabling it.
      const logPath = getDevtoolsLogPath(sessionsDir, "ws-1");
      await fs.mkdir(path.dirname(logPath), { recursive: true });
      await fs.writeFile(logPath, `${JSON.stringify({ type: "run", run: makeRun("run-1") })}\n`);

      const service = new DevToolsService(createTestConfig({ sessionsDir, enabled: false }));
      await service.removeWorkspaceData("ws-1");

      expect(await pathExists(logPath)).toBe(false);
    });
  });

  describe("persistence", () => {
    it("loads persisted data after service recreation", async () => {
      const config = createTestConfig({ sessionsDir, enabled: true });

      const service1 = new DevToolsService(config);
      await service1.createRun("ws-1", makeRun("run-1"));
      await service1.createStep(
        "ws-1",
        makeStep({
          id: "step-1",
          runId: "run-1",
          durationMs: null,
        })
      );
      await service1.updateStep("ws-1", "step-1", {
        durationMs: 125,
        output: { finishReason: "stop" },
      });

      const service2 = new DevToolsService(config);
      const runWithSteps = await service2.getRunWithSteps("ws-1", "run-1");

      expect(runWithSteps).not.toBeNull();
      expect(runWithSteps?.steps).toHaveLength(1);
      expect(runWithSteps?.steps[0]).toMatchObject({
        id: "step-1",
        durationMs: 125,
        output: { finishReason: "stop" },
      });
    });

    it("finalizes stale in-progress steps once when persisted data is first loaded", async () => {
      const config = createTestConfig({ sessionsDir, enabled: true });
      const staleStepId = "step-stale";
      const run = makeRun("run-1");
      const staleStep = makeStep({
        id: staleStepId,
        runId: "run-1",
        durationMs: null,
        error: null,
      });
      const logPath = getDevtoolsLogPath(sessionsDir, "ws-1");

      await fs.mkdir(path.dirname(logPath), { recursive: true });
      await fs.writeFile(
        logPath,
        `${JSON.stringify({ type: "run", run })}\n${JSON.stringify({ type: "step", step: staleStep })}\n`,
        "utf-8"
      );

      const service = new DevToolsService(config);
      const runWithSteps = await service.getRunWithSteps("ws-1", "run-1");

      expect(runWithSteps).not.toBeNull();
      const finalizedStep = runWithSteps?.steps.find((step) => step.id === staleStepId);
      expect(finalizedStep).toBeDefined();
      expect(finalizedStep?.error).toBe("Interrupted (stale)");
      expect(finalizedStep?.durationMs).not.toBeNull();

      const logAfterFirstLoad = await fs.readFile(logPath, "utf-8");
      expect(countStaleStepUpdates(logAfterFirstLoad, staleStepId)).toBe(1);

      await service.getRuns("ws-1");
      const logAfterSecondLoad = await fs.readFile(logPath, "utf-8");
      expect(countStaleStepUpdates(logAfterSecondLoad, staleStepId)).toBe(1);
    });

    it("serializes concurrent workspace loads so createStep does not stale-finalize sibling requests", async () => {
      const config = createTestConfig({ sessionsDir, enabled: true });
      const run = makeRun("run-1");
      const logPath = getDevtoolsLogPath(sessionsDir, "ws-1");

      await fs.mkdir(path.dirname(logPath), { recursive: true });
      await fs.writeFile(logPath, `${JSON.stringify({ type: "run", run })}\n`, "utf-8");

      const service = new DevToolsService(config);

      const originalReadFile = fs.readFile;
      let logReadCount = 0;
      let releaseReadGate!: () => void;
      const readGate = new Promise<void>((resolve) => {
        releaseReadGate = resolve;
      });

      let firstReadStartedResolve!: () => void;
      const firstReadStarted = new Promise<void>((resolve) => {
        firstReadStartedResolve = resolve;
      });

      const mockedReadFile = (async (...args: Parameters<typeof fs.readFile>) => {
        const [filePath] = args;
        if (filePath === logPath) {
          logReadCount += 1;
          firstReadStartedResolve();
          await readGate;
        }
        return originalReadFile(...args);
      }) as typeof fs.readFile;

      const readFileSpy = spyOn(fs, "readFile").mockImplementation(mockedReadFile);

      try {
        const firstCreateStep = service.createStep(
          "ws-1",
          makeStep({ id: "step-1", runId: "run-1", durationMs: null })
        );
        await firstReadStarted;

        const secondCreateStep = service.createStep(
          "ws-1",
          makeStep({ id: "step-2", runId: "run-1", durationMs: null, stepNumber: 2 })
        );

        await Promise.resolve();
        expect(logReadCount).toBe(1);

        releaseReadGate();
        await Promise.all([firstCreateStep, secondCreateStep]);
      } finally {
        readFileSpy.mockRestore();
      }

      const runWithSteps = await service.getRunWithSteps("ws-1", "run-1");
      expect(runWithSteps).not.toBeNull();
      const step1 = runWithSteps?.steps.find((step) => step.id === "step-1");
      const step2 = runWithSteps?.steps.find((step) => step.id === "step-2");
      expect(step1?.error).toBeNull();
      expect(step2?.error).toBeNull();
      expect(step1?.durationMs).toBeNull();
      expect(step2?.durationMs).toBeNull();

      const logAfterCreates = await fs.readFile(logPath, "utf-8");
      expect(countStaleStepUpdates(logAfterCreates, "step-1")).toBe(0);
      expect(countStaleStepUpdates(logAfterCreates, "step-2")).toBe(0);
    });

    it("defaults missing raw fields to null when replaying legacy step entries", async () => {
      const config = createTestConfig({ sessionsDir, enabled: true });
      const run = makeRun("run-1");
      const legacyStep = {
        ...makeStep({ id: "step-1", runId: "run-1" }),
      };
      delete (legacyStep as Record<string, unknown>).rawChunks;
      delete (legacyStep as Record<string, unknown>).requestHeaders;
      delete (legacyStep as Record<string, unknown>).responseHeaders;
      const logPath = getDevtoolsLogPath(sessionsDir, "ws-1");

      await fs.mkdir(path.dirname(logPath), { recursive: true });
      await fs.writeFile(
        logPath,
        `${JSON.stringify({ type: "run", run })}\n${JSON.stringify({ type: "step", step: legacyStep })}\n`,
        "utf-8"
      );

      const service = new DevToolsService(config);
      const runWithSteps = await service.getRunWithSteps("ws-1", "run-1");

      expect(runWithSteps).not.toBeNull();
      expect(runWithSteps?.steps[0]?.requestHeaders).toBeNull();
      expect(runWithSteps?.steps[0]?.responseHeaders).toBeNull();
      expect(runWithSteps?.steps[0]?.rawChunks).toBeNull();
    });

    it("skips corrupted lines while replaying persisted logs", async () => {
      const config = createTestConfig({ sessionsDir, enabled: true });
      const run = makeRun("run-1");
      const step = makeStep({ id: "step-1", runId: "run-1" });
      const logPath = getDevtoolsLogPath(sessionsDir, "ws-1");

      await fs.mkdir(path.dirname(logPath), { recursive: true });
      await fs.writeFile(
        logPath,
        `${JSON.stringify({ type: "run", run })}\n{this-is-not-json}\n${JSON.stringify({ type: "step", step })}\n${JSON.stringify({ type: "step-update", stepId: "step-1", update: { error: "boom" } })}\n`,
        "utf-8"
      );

      const service = new DevToolsService(config);
      const runWithSteps = await service.getRunWithSteps("ws-1", "run-1");

      expect(runWithSteps).not.toBeNull();
      expect(runWithSteps?.steps).toHaveLength(1);
      expect(runWithSteps?.steps[0]?.error).toBe("boom");
    });

    it("clear leaves nothing replayable in the persisted file", async () => {
      const service = new DevToolsService(createTestConfig({ sessionsDir, enabled: true }));
      await service.createRun("ws-1", makeRun("run-1"));
      await service.clear("ws-1");

      expect(
        (await fs.readFile(getDevtoolsLogPath(sessionsDir, "ws-1"), "utf-8"))
          .split("\n")
          .filter(Boolean)
          .map((line) => (JSON.parse(line) as { type: string }).type)
      ).toEqual(["log-meta"]);
    });
  });

  describe("event emission", () => {
    it("emits toolPolicy in run-created summary", async () => {
      const service = new DevToolsService(createTestConfig({ sessionsDir, enabled: true }));
      const events: DevToolsEvent[] = [];
      const policy = [{ regex_match: "propose_plan", action: "require" as const }];
      const metadataId = "metadata-4";

      service.on("update:ws-1", (event: DevToolsEvent) => {
        events.push(event);
      });

      service.setPendingRunMetadata("ws-1", metadataId, { toolPolicy: policy });
      await service.createRun("ws-1", makeRun("run-1"), metadataId);

      const runCreated = events.find((event) => event.type === "run-created");
      expect(runCreated).toBeDefined();
      if (runCreated?.type === "run-created") {
        expect(runCreated.run.toolPolicy).toEqual(policy);
      }
    });

    it("emits run-created, updateStep events, and cleared", async () => {
      const service = new DevToolsService(createTestConfig({ sessionsDir, enabled: true }));
      const events: DevToolsEvent[] = [];

      service.on("update:ws-1", (event: DevToolsEvent) => {
        events.push(event);
      });

      await service.createRun("ws-1", makeRun("run-1"));
      await service.createStep("ws-1", makeStep({ id: "step-1", runId: "run-1" }));
      await service.updateStep("ws-1", "step-1", { durationMs: 500 });
      await service.clear("ws-1");

      expect(events.map((event) => event.type)).toEqual([
        "run-created",
        "step-created",
        "run-updated",
        "step-updated",
        "run-updated",
        "cleared",
      ]);

      const runCreated = events[0];
      expect(runCreated?.type).toBe("run-created");
      if (runCreated?.type === "run-created") {
        expect(runCreated.run.id).toBe("run-1");
      }

      const stepUpdated = events[3];
      expect(stepUpdated?.type).toBe("step-updated");
      if (stepUpdated?.type === "step-updated") {
        expect(stepUpdated.step.durationMs).toBe(500);
      }

      expect(events[5]).toEqual({ type: "cleared" });
    });
  });

  describe("log rotation", () => {
    function getRotatedLogPath(dir: string, workspaceId: string): string {
      return `${getDevtoolsLogPath(dir, workspaceId)}.1`;
    }

    /** Makes the service's next live-marker write reject (simulated ENOSPC). */
    function installMarkerWriteFailure(service: DevToolsService): { failNext: () => void } {
      interface MarkerAccess {
        writeLiveMarker(filePath: string, generation: number): Promise<void>;
      }
      const priv = service as unknown as MarkerAccess;
      const originalWriteLiveMarker = priv.writeLiveMarker.bind(service);
      let failNextMarkerWrite = false;
      priv.writeLiveMarker = (filePath: string, generation: number) => {
        if (failNextMarkerWrite) {
          failNextMarkerWrite = false;
          return Promise.reject(new Error("ENOSPC: simulated marker write failure"));
        }
        return originalWriteLiveMarker(filePath, generation);
      };
      return {
        failNext: () => {
          failNextMarkerWrite = true;
        },
      };
    }

    it("rotates the log exactly once when the cap is crossed and preserves line integrity", async () => {
      const config = createTestConfig({ sessionsDir });
      // Cap sized so run + step-1 crosses it but log-meta + step-2 does not.
      const service = new DevToolsService(config, 400);
      const logPath = getDevtoolsLogPath(sessionsDir, "ws-1");
      const rotatedPath = getRotatedLogPath(sessionsDir, "ws-1");

      await service.createRun("ws-1", makeRun("run-1"));
      expect(await pathExists(rotatedPath)).toBe(false);

      await service.createStep("ws-1", makeStep({ id: "step-1", runId: "run-1" }));
      expect(await pathExists(rotatedPath)).toBe(true);
      // The live file is rewritten (not removed) so its generation marker
      // pairs it with the snapshot.
      const retiredLines = (await fs.readFile(logPath, "utf-8")).split("\n").filter(Boolean);
      expect(retiredLines.map((line) => (JSON.parse(line) as { type: string }).type)).toEqual([
        "log-meta",
      ]);

      const rotatedLines = (await fs.readFile(rotatedPath, "utf-8")).split("\n").filter(Boolean);
      expect(rotatedLines.map((line) => (JSON.parse(line) as { type: string }).type)).toEqual([
        "snapshot-meta",
        "run",
        "step",
      ]);

      await service.createStep("ws-1", makeStep({ id: "step-2", runId: "run-1" }));
      const liveLines = (await fs.readFile(logPath, "utf-8")).split("\n").filter(Boolean);
      expect(liveLines).toHaveLength(2);
      expect((JSON.parse(liveLines[1]) as { step: { id: string } }).step.id).toBe("step-2");
      expect((await fs.readFile(rotatedPath, "utf-8")).split("\n").filter(Boolean)).toEqual(
        rotatedLines
      );
    });

    it("replays the rotated file on load so history survives a restart", async () => {
      const config = createTestConfig({ sessionsDir });
      const service = new DevToolsService(config, 350);

      await service.createRun("ws-1", makeRun("run-1"));
      // Crossing the cap moves run-1 and step-1 into the rotated file; the
      // step-update for step-1 lands in the fresh live file.
      await service.createStep("ws-1", makeStep({ id: "step-1", runId: "run-1" }));
      await service.updateStep("ws-1", "step-1", { durationMs: 1234 });

      // A fresh instance simulates an app restart after rotation.
      const reloaded = new DevToolsService(config, 350);
      const runs = await reloaded.getRuns("ws-1");
      expect(runs.map((run) => run.id)).toEqual(["run-1"]);
      const runWithSteps = await reloaded.getRunWithSteps("ws-1", "run-1");
      expect(runWithSteps?.steps.map((step) => step.id)).toEqual(["step-1"]);
      // The live-file step-update found its rotated base record.
      expect(runWithSteps?.steps[0]?.durationMs).toBe(1234);
    });

    it("keeps history replayable across repeated rotations", async () => {
      const config = createTestConfig({ sessionsDir });
      const service = new DevToolsService(config, 350);

      await service.createRun("ws-1", makeRun("run-1"));
      // First rotation: run-1 and step-1 move into the rotated snapshot.
      await service.createStep("ws-1", makeStep({ id: "step-1", runId: "run-1" }));
      // This update alone crosses the cap, forcing a second rotation while
      // the live file holds only a step-update without its base records.
      await service.updateStep("ws-1", "step-1", {
        rawResponse: "x".repeat(400),
        durationMs: 77,
      });

      const reloaded = new DevToolsService(config, 350);
      const runWithSteps = await reloaded.getRunWithSteps("ws-1", "run-1");
      expect(runWithSteps?.steps.map((step) => step.id)).toEqual(["step-1"]);
      expect(runWithSteps?.steps[0]?.durationMs).toBe(77);
      expect(runWithSteps?.steps[0]?.rawResponse).toBe("x".repeat(400));
    });

    it("retains only the newest runs that fit the cap when compacting", async () => {
      const config = createTestConfig({ sessionsDir });
      const service = new DevToolsService(config, 700);

      await service.createRun("ws-1", makeRun("run-1", "2025-06-01T00:00:00Z"));
      await service.createStep("ws-1", makeStep({ id: "step-1", runId: "run-1" }));
      await service.createRun("ws-1", makeRun("run-2", "2025-06-01T00:01:00Z"));
      // Crossing the cap rotates; run-1 + step-1 + run-2 exceed 700 bytes, so
      // only the newest run survives in the snapshot.
      await service.createStep(
        "ws-1",
        makeStep({ id: "step-2", runId: "run-2", rawResponse: "y".repeat(400) })
      );

      const reloaded = new DevToolsService(config, 700);
      const runs = await reloaded.getRuns("ws-1");
      expect(runs.map((run) => run.id)).toEqual(["run-2"]);
    });

    it("keeps an older zero-step run when rotation happens before its first step", async () => {
      const config = createTestConfig({ sessionsDir });
      const service = new DevToolsService(config, 700);

      // run-pending has no steps yet when the cap is crossed (its caller may
      // still be awaiting createRun, with steps in flight).
      await service.createRun("ws-1", makeRun("run-pending", "2025-06-01T00:00:00Z"));
      await service.createRun("ws-1", makeRun("run-new", "2025-06-01T00:01:00Z"));
      await service.createStep(
        "ws-1",
        makeStep({ id: "step-new", runId: "run-new", rawResponse: "y".repeat(400) })
      );
      const reloaded = new DevToolsService(config, 700);
      const runs = await reloaded.getRuns("ws-1");
      expect(runs.map((run) => run.id).sort()).toEqual(["run-new", "run-pending"]);
      // The retained record is the original, not a createStep self-heal stub.
      expect(runs.find((run) => run.id === "run-pending")?.startedAt).toBe("2025-06-01T00:00:00Z");
    });

    it("keeps an older still-active run replayable when newer runs fill the cap", async () => {
      const config = createTestConfig({ sessionsDir });
      const service = new DevToolsService(config, 700);

      await service.createRun("ws-1", makeRun("run-old", "2025-06-01T00:00:00Z"));
      // In-progress step (no duration, no error) marks run-old as active.
      await service.createStep(
        "ws-1",
        makeStep({ id: "step-old", runId: "run-old", durationMs: null })
      );
      await service.createRun("ws-1", makeRun("run-new", "2025-06-01T00:01:00Z"));
      // Crossing the cap rotates while run-old is still streaming.
      await service.createStep(
        "ws-1",
        makeStep({ id: "step-new", runId: "run-new", rawResponse: "y".repeat(400) })
      );
      // The active run's completion lands in the fresh live file.
      await service.updateStep("ws-1", "step-old", { durationMs: 55 });

      const reloaded = new DevToolsService(config, 700);
      const runs = await reloaded.getRuns("ws-1");
      expect(runs.map((run) => run.id).sort()).toEqual(["run-new", "run-old"]);
      const oldRun = await reloaded.getRunWithSteps("ws-1", "run-old");
      expect(oldRun?.steps[0]?.durationMs).toBe(55);
    });

    it("does not resurrect evicted runs from a live log orphaned by a rotation crash", async () => {
      const config = createTestConfig({ sessionsDir });
      const logPath = getDevtoolsLogPath(sessionsDir, "ws-1");
      const rotatedPath = getRotatedLogPath(sessionsDir, "ws-1");
      await fs.mkdir(path.dirname(logPath), { recursive: true });

      // Simulate a crash between the snapshot rename and the live-log
      // rewrite: the snapshot (generation 2) already dropped run-evicted,
      // but the pre-rotation live log (generation 1) still holds it.
      await fs.writeFile(
        rotatedPath,
        [
          JSON.stringify({ type: "snapshot-meta", generation: 2 }),
          JSON.stringify({ type: "run", run: makeRun("run-keep", "2025-06-01T00:01:00Z") }),
        ]
          .map((line) => `${line}\n`)
          .join(""),
        "utf-8"
      );
      await fs.writeFile(
        logPath,
        [
          JSON.stringify({ type: "log-meta", generation: 1 }),
          JSON.stringify({ type: "run", run: makeRun("run-evicted", "2025-06-01T00:00:00Z") }),
        ]
          .map((line) => `${line}\n`)
          .join(""),
        "utf-8"
      );

      const service = new DevToolsService(config, 700);
      const runs = await service.getRuns("ws-1");
      expect(runs.map((run) => run.id)).toEqual(["run-keep"]);

      // Load completed the interrupted retirement, so new appends pair with
      // the snapshot and survive the next restart.
      await service.createRun("ws-1", makeRun("run-after", "2025-06-01T00:02:00Z"));
      const reloaded = new DevToolsService(config, 700);
      const reloadedRuns = await reloaded.getRuns("ws-1");
      expect(reloadedRuns.map((run) => run.id).sort()).toEqual(["run-after", "run-keep"]);
    });

    it("keeps runs and steps that arrive while snapshot I/O is in flight", async () => {
      const config = createTestConfig({ sessionsDir });
      // Cap sized so the oversized step triggers exactly one rotation and the
      // mid-I/O appends stay under it (no second rotation evicting them).
      const service = new DevToolsService(config, 1500);
      type SnapshotFn = (...args: unknown[]) => Promise<void>;
      const priv = service as unknown as { commitSnapshotPair: SnapshotFn };
      const originalCommit = priv.commitSnapshotPair.bind(service);

      await service.createRun("ws-1", makeRun("run-old", "2025-06-01T00:00:00Z"));
      await service.createStep("ws-1", makeStep({ id: "step-old", runId: "run-old" }));
      await service.createRun("ws-1", makeRun("run-new", "2025-06-01T00:01:00Z"));

      // Overlapping provider calls land between the retention decision and
      // the snapshot I/O completing: a brand-new run, plus a new step for
      // run-old (which lost its snapshot spot to the cap).
      let midIo: Promise<void> | undefined;
      priv.commitSnapshotPair = async (...args: unknown[]) => {
        priv.commitSnapshotPair = originalCommit;
        midIo = Promise.all([
          service.createRun("ws-1", makeRun("run-mid", "2025-06-01T00:02:00Z")),
          service.createStep("ws-1", makeStep({ id: "step-mid-old", runId: "run-old" })),
        ]).then(() => undefined);
        await originalCommit(...args);
      };
      // Crossing the cap triggers rotation with the wrapped snapshot commit.
      await service.createStep(
        "ws-1",
        makeStep({ id: "step-new", runId: "run-new", rawResponse: "y".repeat(2000) })
      );
      expect(midIo).toBeDefined();
      await midIo;

      const runs = await service.getRuns("ws-1");
      expect(runs.map((run) => run.id).sort()).toEqual(["run-mid", "run-new", "run-old"]);

      // Everything also survives a restart: mid-I/O entities landed in the
      // fresh live file with their base records.
      const reloaded = new DevToolsService(config, 700);
      const reloadedRuns = await reloaded.getRuns("ws-1");
      expect(reloadedRuns.map((run) => run.id).sort()).toEqual(["run-mid", "run-new", "run-old"]);
      const oldRun = await reloaded.getRunWithSteps("ws-1", "run-old");
      expect(oldRun?.steps.map((step) => step.id).sort()).toEqual(["step-mid-old", "step-old"]);
    });

    it("removeWorkspaceData removes an abandoned snapshot temp file", async () => {
      const config = createTestConfig({ sessionsDir });
      const service = new DevToolsService(config, 700);
      const tmpPath = `${getRotatedLogPath(sessionsDir, "ws-1")}.tmp`;

      await service.createRun("ws-1", makeRun("run-1"));
      // Simulate a rotation interrupted between the tmp write and the rename.
      await fs.writeFile(tmpPath, "orphaned snapshot\n", "utf-8");

      await service.removeWorkspaceData("ws-1");
      expect(await pathExists(tmpPath)).toBe(false);
    });

    it("treats an empty live log as a legacy clear and keeps later appends durable", async () => {
      const config = createTestConfig({ sessionsDir });
      const logPath = getDevtoolsLogPath(sessionsDir, "ws-1");
      const rotatedPath = getRotatedLogPath(sessionsDir, "ws-1");
      await fs.mkdir(path.dirname(logPath), { recursive: true });

      // Marker writes are atomic, so an empty live file next to a committed
      // snapshot can only be a legacy binary's truncating clear; the
      // snapshot must stay dropped and later appends must survive restarts.
      await fs.writeFile(
        rotatedPath,
        [
          JSON.stringify({ type: "snapshot-meta", generation: 1 }),
          JSON.stringify({ type: "run", run: makeRun("run-keep", "2025-06-01T00:00:00Z") }),
        ]
          .map((line) => `${line}\n`)
          .join(""),
        "utf-8"
      );
      await fs.writeFile(logPath, "", "utf-8");

      const service = new DevToolsService(config, 700);
      await service.createRun("ws-1", makeRun("run-after", "2025-06-01T00:01:00Z"));

      const reloaded = new DevToolsService(config, 700);
      const runs = await reloaded.getRuns("ws-1");
      expect(runs.map((run) => run.id)).toEqual(["run-after"]);
    });

    it("keeps appends durable when the live log is missing next to a snapshot", async () => {
      const config = createTestConfig({ sessionsDir });
      const logPath = getDevtoolsLogPath(sessionsDir, "ws-1");
      const rotatedPath = getRotatedLogPath(sessionsDir, "ws-1");
      await fs.mkdir(path.dirname(logPath), { recursive: true });

      // Only a legacy binary's removal path deletes the live file while
      // leaving the rotated snapshot; commits always create the live file
      // (retire sentinel) before renaming the snapshot.
      await fs.writeFile(
        rotatedPath,
        `${JSON.stringify({ type: "snapshot-meta", generation: 1 })}\n`,
        "utf-8"
      );

      const service = new DevToolsService(config, 700);
      await service.createRun("ws-1", makeRun("run-after", "2025-06-01T00:01:00Z"));

      const reloaded = new DevToolsService(config, 700);
      const runs = await reloaded.getRuns("ws-1");
      expect(runs.map((run) => run.id)).toEqual(["run-after"]);
    });

    it("evicts compacted-away runs from memory and notifies subscribers", async () => {
      const config = createTestConfig({ sessionsDir });
      const service = new DevToolsService(config, 700);
      const events: DevToolsEvent[] = [];
      service.on("update:ws-1", (event: DevToolsEvent) => {
        events.push(event);
      });

      await service.createRun("ws-1", makeRun("run-1", "2025-06-01T00:00:00Z"));
      await service.createStep("ws-1", makeStep({ id: "step-1", runId: "run-1" }));
      await service.createRun("ws-1", makeRun("run-2", "2025-06-01T00:01:00Z"));
      await service.createStep(
        "ws-1",
        makeStep({ id: "step-2", runId: "run-2", rawResponse: "y".repeat(400) })
      );

      // The completed run-1 was dropped by compaction; memory agrees with disk.
      const runs = await service.getRuns("ws-1");
      expect(runs.map((run) => run.id)).toEqual(["run-2"]);
      // Open panels were told to drop the evicted card.
      expect(events.filter((event) => event.type === "runs-evicted")).toEqual([
        { type: "runs-evicted", runIds: ["run-1"] },
      ]);
    });

    it("ignores a malformed snapshot generation instead of poisoning workspace state", async () => {
      const config = createTestConfig({ sessionsDir });
      const logPath = getDevtoolsLogPath(sessionsDir, "ws-1");
      const rotatedPath = getRotatedLogPath(sessionsDir, "ws-1");
      await fs.mkdir(path.dirname(logPath), { recursive: true });

      // A malformed metadata line must not set logGeneration to NaN, where
      // the stale check would flag the live log but the repair branch
      // (logGeneration > 0) would be skipped, discarding appends forever.
      await fs.writeFile(
        rotatedPath,
        [
          JSON.stringify({ type: "snapshot-meta", generation: "bad" }),
          JSON.stringify({ type: "run", run: makeRun("run-keep", "2025-06-01T00:00:00Z") }),
        ]
          .map((line) => `${line}\n`)
          .join(""),
        "utf-8"
      );

      const service = new DevToolsService(config, 700);
      await service.createRun("ws-1", makeRun("run-after", "2025-06-01T00:01:00Z"));

      const reloaded = new DevToolsService(config, 700);
      const runs = await reloaded.getRuns("ws-1");
      expect(runs.map((run) => run.id).sort()).toEqual(["run-after", "run-keep"]);
    });

    it("repairs the live marker on the next append when the post-snapshot marker write fails", async () => {
      const config = createTestConfig({ sessionsDir });
      const service = new DevToolsService(config, 700);
      const markerFailure = installMarkerWriteFailure(service);

      await service.createRun("ws-1", makeRun("run-1", "2025-06-01T00:00:00Z"));
      await service.createStep("ws-1", makeStep({ id: "step-1", runId: "run-1" }));
      // This append crosses the cap; the snapshot rename lands but the
      // live-marker write fails (transient ENOSPC).
      markerFailure.failNext();
      let thrownMessage = "";
      try {
        await service.createStep(
          "ws-1",
          makeStep({ id: "step-2", runId: "run-1", rawResponse: "y".repeat(700) })
        );
      } catch (error) {
        thrownMessage = error instanceof Error ? error.message : String(error);
      }
      expect(thrownMessage).toContain("ENOSPC");

      // The next append must repair the marker first; otherwise this run
      // lands in a pre-snapshot live file and is discarded on restart.
      await service.createRun("ws-1", makeRun("run-2", "2025-06-01T00:01:00Z"));

      const reloaded = new DevToolsService(config, 700);
      const runs = await reloaded.getRuns("ws-1");
      expect(runs.map((run) => run.id).sort()).toEqual(["run-1", "run-2"]);
    });

    it("completes eviction and notifies subscribers when the live-marker write fails", async () => {
      const config = createTestConfig({ sessionsDir });
      const service = new DevToolsService(config, 1000);
      const markerFailure = installMarkerWriteFailure(service);
      const events: DevToolsEvent[] = [];
      service.on("update:ws-1", (event: DevToolsEvent) => {
        events.push(event);
      });

      await service.createRun("ws-1", makeRun("run-1", "2025-06-01T00:00:00Z"));
      await service.createStep(
        "ws-1",
        makeStep({ id: "step-1", runId: "run-1", durationMs: null })
      );
      await service.createRun("ws-1", makeRun("run-2", "2025-06-01T00:01:00Z"));
      await service.createStep(
        "ws-1",
        makeStep({ id: "step-2", runId: "run-2", durationMs: null })
      );

      // Completing run-1 crosses the cap: the snapshot rename lands
      // (dropping run-1) but the live-marker write fails.
      markerFailure.failNext();
      let thrownMessage = "";
      try {
        await service.updateStep("ws-1", "step-1", {
          durationMs: 100,
          rawResponse: "z".repeat(800),
        });
      } catch (error) {
        thrownMessage = error instanceof Error ? error.message : String(error);
      }
      expect(thrownMessage).toContain("ENOSPC");

      // The rename committed the retention decision, so the failed rotation
      // must still evict run-1 from memory and notify subscribers; otherwise
      // later appends can target a run whose records exist nowhere durable.
      expect(events.filter((event) => event.type === "runs-evicted")).toEqual([
        { type: "runs-evicted", runIds: ["run-1"] },
      ]);
      const runs = await service.getRuns("ws-1");
      expect(runs.map((run) => run.id)).toEqual(["run-2"]);
    });

    it("rejects an unsafe snapshot generation so a reused generation cannot resurrect dropped runs", async () => {
      const config = createTestConfig({ sessionsDir });
      const logPath = getDevtoolsLogPath(sessionsDir, "ws-1");
      const rotatedPath = getRotatedLogPath(sessionsDir, "ws-1");
      await fs.mkdir(path.dirname(logPath), { recursive: true });

      // Corruption Number.isInteger accepts but that cannot be incremented
      // (1e100 + 1 === 1e100): every later rotation would reuse the
      // generation, so a crash between the snapshot rename and the live
      // rewrite leaves an old marker that still compares as current.
      await fs.writeFile(
        rotatedPath,
        `${JSON.stringify({ type: "snapshot-meta", generation: 1e100 })}\n`,
        "utf-8"
      );

      const service = new DevToolsService(config, 1000);
      const markerFailure = installMarkerWriteFailure(service);
      await service.createRun("ws-1", makeRun("run-1", "2025-06-01T00:00:00Z"));
      await service.createStep(
        "ws-1",
        makeStep({ id: "step-1", runId: "run-1", durationMs: null })
      );
      await service.createRun("ws-1", makeRun("run-2", "2025-06-01T00:01:00Z"));
      await service.createStep(
        "ws-1",
        makeStep({ id: "step-2", runId: "run-2", durationMs: null })
      );
      // Rotation drops the completed run-1; the marker failure leaves the
      // pre-rotation live file (which still holds run-1's records) in place.
      markerFailure.failNext();
      let thrownMessage = "";
      try {
        await service.updateStep("ws-1", "step-1", {
          durationMs: 100,
          rawResponse: "z".repeat(800),
        });
      } catch (error) {
        thrownMessage = error instanceof Error ? error.message : String(error);
      }
      expect(thrownMessage).toContain("ENOSPC");

      // Restart in that crash window: with the poisoned generation reused,
      // the stale live file would pass as current and resurrect run-1. The
      // large cap keeps load-time stale-step finalization from triggering
      // another rotation that would re-evict it and mask the resurrection.
      const reloaded = new DevToolsService(config, 1_000_000);
      const runs = await reloaded.getRuns("ws-1");
      expect(runs.map((run) => run.id)).toEqual(["run-2"]);
    });

    it("ignores an unsafe snapshot generation so later appends are not repeatedly discarded", async () => {
      const config = createTestConfig({ sessionsDir });
      const logPath = getDevtoolsLogPath(sessionsDir, "ws-1");
      const rotatedPath = getRotatedLogPath(sessionsDir, "ws-1");
      await fs.mkdir(path.dirname(logPath), { recursive: true });

      // If load accepted 1e100 into logGeneration, the marker repair would
      // write a marker the stale check can never trust, so every restart
      // would discard all appends since the corruption.
      await fs.writeFile(
        rotatedPath,
        [
          JSON.stringify({ type: "snapshot-meta", generation: 1e100 }),
          JSON.stringify({ type: "run", run: makeRun("run-keep", "2025-06-01T00:00:00Z") }),
        ]
          .map((line) => `${line}\n`)
          .join(""),
        "utf-8"
      );

      const service = new DevToolsService(config, 700);
      await service.createRun("ws-1", makeRun("run-after", "2025-06-01T00:01:00Z"));

      const reloaded = new DevToolsService(config, 700);
      const runs = await reloaded.getRuns("ws-1");
      expect(runs.map((run) => run.id).sort()).toEqual(["run-after", "run-keep"]);
    });

    it("treats a live log with an unsafe marker generation as stale", async () => {
      const config = createTestConfig({ sessionsDir });
      const logPath = getDevtoolsLogPath(sessionsDir, "ws-1");
      const rotatedPath = getRotatedLogPath(sessionsDir, "ws-1");
      await fs.mkdir(path.dirname(logPath), { recursive: true });

      await fs.writeFile(
        rotatedPath,
        [
          JSON.stringify({ type: "snapshot-meta", generation: 1 }),
          JSON.stringify({ type: "run", run: makeRun("run-keep", "2025-06-01T00:00:00Z") }),
        ]
          .map((line) => `${line}\n`)
          .join(""),
        "utf-8"
      );
      // A corrupt out-of-range marker generation must not vouch for the live
      // file's currency: its dropped-run records would be resurrected.
      await fs.writeFile(
        logPath,
        [
          JSON.stringify({ type: "log-meta", generation: 1e100 }),
          JSON.stringify({ type: "run", run: makeRun("run-dropped", "2025-06-01T00:01:00Z") }),
        ]
          .map((line) => `${line}\n`)
          .join(""),
        "utf-8"
      );

      const service = new DevToolsService(config, 700);
      const runs = await service.getRuns("ws-1");
      expect(runs.map((run) => run.id)).toEqual(["run-keep"]);
    });

    it("treats a live log whose marker generation exceeds the snapshot generation as stale", async () => {
      const config = createTestConfig({ sessionsDir });
      const logPath = getDevtoolsLogPath(sessionsDir, "ws-1");
      const rotatedPath = getRotatedLogPath(sessionsDir, "ws-1");
      await fs.mkdir(path.dirname(logPath), { recursive: true });

      await fs.writeFile(
        rotatedPath,
        [
          JSON.stringify({ type: "snapshot-meta", generation: 1 }),
          JSON.stringify({ type: "run", run: makeRun("run-keep", "2025-06-01T00:00:00Z") }),
        ]
          .map((line) => `${line}\n`)
          .join(""),
        "utf-8"
      );
      // The protocol only creates matching pairs, so a finite higher marker
      // means the live log belongs to a snapshot that is no longer on disk;
      // replaying it beside the older snapshot could resurrect runs its own
      // rotation had evicted.
      await fs.writeFile(
        logPath,
        [
          JSON.stringify({ type: "log-meta", generation: 2 }),
          JSON.stringify({ type: "run", run: makeRun("run-dropped", "2025-06-01T00:01:00Z") }),
        ]
          .map((line) => `${line}\n`)
          .join(""),
        "utf-8"
      );

      const service = new DevToolsService(config, 700);
      const runs = await service.getRuns("ws-1");
      expect(runs.map((run) => run.id)).toEqual(["run-keep"]);
    });

    it("still loads the snapshot when the live-marker repair write fails, then repairs on the next append", async () => {
      const config = createTestConfig({ sessionsDir });
      const logPath = getDevtoolsLogPath(sessionsDir, "ws-1");
      const rotatedPath = getRotatedLogPath(sessionsDir, "ws-1");
      await fs.mkdir(path.dirname(logPath), { recursive: true });

      // A first rotation interrupted after the snapshot rename leaves the
      // markerless pre-rotation live file ending in the retire sentinel:
      // load must repair the marker, but a failing repair write must not
      // block reading the already-replayed snapshot.
      await fs.writeFile(
        rotatedPath,
        [
          JSON.stringify({ type: "snapshot-meta", generation: 1 }),
          JSON.stringify({ type: "run", run: makeRun("run-keep", "2025-06-01T00:00:00Z") }),
        ]
          .map((line) => `${line}\n`)
          .join(""),
        "utf-8"
      );
      await fs.writeFile(
        logPath,
        [
          JSON.stringify({ type: "run", run: makeRun("run-keep", "2025-06-01T00:00:00Z") }),
          JSON.stringify({ type: "log-retire", generation: 1 }),
        ]
          .map((line) => `${line}\n`)
          .join(""),
        "utf-8"
      );

      const service = new DevToolsService(config, 700);
      const markerFailure = installMarkerWriteFailure(service);
      markerFailure.failNext();
      const runs = await service.getRuns("ws-1");
      expect(runs.map((run) => run.id)).toEqual(["run-keep"]);

      // The marker generation was left lagging, so the next append rewrites
      // the marker first and the appended run survives a restart.
      await service.createRun("ws-1", makeRun("run-after", "2025-06-01T00:01:00Z"));
      const reloaded = new DevToolsService(config, 700);
      const reloadedRuns = await reloaded.getRuns("ws-1");
      expect(reloadedRuns.map((run) => run.id).sort()).toEqual(["run-after", "run-keep"]);
    });

    it("rejects a snapshot generation with no safe increment so rotation cannot resurrect dropped runs", async () => {
      const config = createTestConfig({ sessionsDir });
      const logPath = getDevtoolsLogPath(sessionsDir, "ws-1");
      const rotatedPath = getRotatedLogPath(sessionsDir, "ws-1");
      await fs.mkdir(path.dirname(logPath), { recursive: true });

      // A corrupt MAX_SAFE_INTEGER generation passes Number.isSafeInteger,
      // but the next rotation writes generation + 1 = 2^53 (unsafe): if a
      // crash then leaves the old live log in place, a load that rejects the
      // unsafe snapshot generation would treat the snapshot as absent and
      // replay the stale live log, resurrecting the run it just evicted.
      await fs.writeFile(
        rotatedPath,
        `${JSON.stringify({ type: "snapshot-meta", generation: Number.MAX_SAFE_INTEGER })}\n`,
        "utf-8"
      );
      const evictable = makeRun("run-old", "2025-06-01T00:00:00Z");
      const evictableStep = makeStep({ id: "step-old", runId: "run-old" });
      await fs.writeFile(
        logPath,
        [
          JSON.stringify({ type: "log-meta", generation: Number.MAX_SAFE_INTEGER }),
          JSON.stringify({ type: "run", run: evictable }),
          JSON.stringify({ type: "step", step: evictableStep }),
        ]
          .map((line) => `${line}\n`)
          .join(""),
        "utf-8"
      );

      const service = new DevToolsService(config, 700);
      await service.createRun("ws-1", makeRun("run-new", "2025-06-01T00:01:00Z"));
      // Crash window: rotation commits the snapshot (evicting run-old) but
      // dies before rewriting the live file.
      const markerFailure = installMarkerWriteFailure(service);
      markerFailure.failNext();
      await service
        .createStep(
          "ws-1",
          makeStep({ id: "step-new", runId: "run-new", rawResponse: "y".repeat(400) })
        )
        .catch(() => undefined);

      const reloaded = new DevToolsService(config, 700);
      const runs = await reloaded.getRuns("ws-1");
      expect(runs.map((run) => run.id)).toEqual(["run-new"]);
    });

    it("honors a clear performed by a downgraded pre-rotation binary", async () => {
      const config = createTestConfig({ sessionsDir });
      const logPath = getDevtoolsLogPath(sessionsDir, "ws-1");
      const service = new DevToolsService(config, 1500);
      await service.createRun("ws-1", makeRun("run-old"));
      await service.createStep(
        "ws-1",
        makeStep({ id: "step-old", runId: "run-old", rawResponse: "y".repeat(2000) })
      );
      expect(await pathExists(getRotatedLogPath(sessionsDir, "ws-1"))).toBe(true);

      // A pre-rotation binary clears by truncating only the live file; it
      // does not know the rotated snapshot exists.
      await fs.writeFile(logPath, "", "utf-8");

      const reloaded = new DevToolsService(config, 1500);
      expect(await reloaded.getRuns("ws-1")).toEqual([]);
    });

    it("replays a downgraded binary's post-clear runs instead of the rotated snapshot", async () => {
      const config = createTestConfig({ sessionsDir });
      const logPath = getDevtoolsLogPath(sessionsDir, "ws-1");
      const service = new DevToolsService(config, 1500);
      await service.createRun("ws-1", makeRun("run-old"));
      await service.createStep(
        "ws-1",
        makeStep({ id: "step-old", runId: "run-old", rawResponse: "y".repeat(2000) })
      );
      expect(await pathExists(getRotatedLogPath(sessionsDir, "ws-1"))).toBe(true);

      // After a legacy clear, the pre-rotation binary keeps appending
      // markerless entries to the truncated live file.
      const legacyRun = makeRun("run-legacy", "2025-06-02T00:00:00Z");
      await fs.writeFile(logPath, `${JSON.stringify({ type: "run", run: legacyRun })}\n`, "utf-8");

      const reloaded = new DevToolsService(config, 1500);
      const runs = await reloaded.getRuns("ws-1");
      expect(runs.map((run) => run.id)).toEqual(["run-legacy"]);
    });

    it("preserves a downgraded binary's writes appended after an interrupted snapshot commit", async () => {
      const config = createTestConfig({ sessionsDir });
      const logPath = getDevtoolsLogPath(sessionsDir, "ws-1");
      const rotatedPath = getRotatedLogPath(sessionsDir, "ws-1");
      await fs.mkdir(path.dirname(logPath), { recursive: true });

      // Crash after the gen-2 snapshot rename but before the live rewrite
      // left the gen-1 live file ending in the retire sentinel; a downgraded
      // binary then recorded run-legacy after it. Only a legacy writer
      // appends entries after a sentinel, so the live history must win.
      await fs.writeFile(
        rotatedPath,
        [
          JSON.stringify({ type: "snapshot-meta", generation: 2 }),
          JSON.stringify({ type: "run", run: makeRun("run-snap", "2025-06-01T00:00:00Z") }),
        ]
          .map((line) => `${line}\n`)
          .join(""),
        "utf-8"
      );
      await fs.writeFile(
        logPath,
        [
          JSON.stringify({ type: "log-meta", generation: 1 }),
          JSON.stringify({ type: "run", run: makeRun("run-live", "2025-06-01T00:01:00Z") }),
          JSON.stringify({ type: "log-retire", generation: 2 }),
          JSON.stringify({ type: "run", run: makeRun("run-legacy", "2025-06-02T00:00:00Z") }),
        ]
          .map((line) => `${line}\n`)
          .join(""),
        "utf-8"
      );

      const service = new DevToolsService(config, 1500);
      const runs = await service.getRuns("ws-1");
      expect(runs.map((run) => run.id).sort()).toEqual(["run-legacy", "run-live"]);
    });

    it("seals a partially written retire sentinel so the next append stays replayable", async () => {
      const config = createTestConfig({ sessionsDir });
      const service = new DevToolsService(config, 1500);

      await service.createRun("ws-1", makeRun("run-1", "2025-06-01T00:00:00Z"));

      // Disk fills while rotation appends the retire sentinel: the first
      // attempt lands only a fragment before rejecting (the live file's
      // unterminated tail), and every retried rotation keeps failing, so
      // the live file stays the only durable copy of later appends.
      const realAppendFile = fs.appendFile;
      let sentinelFailures = 0;
      const appendSpy = spyOn(fs, "appendFile").mockImplementation(
        async (file, content, options) => {
          if (typeof content === "string" && content.includes('"log-retire"')) {
            sentinelFailures += 1;
            if (sentinelFailures === 1) {
              await realAppendFile(file, content.slice(0, 12), options);
            }
            throw new Error("ENOSPC: simulated sentinel write failure");
          }
          return realAppendFile(file, content, options);
        }
      );
      try {
        await service
          .createStep(
            "ws-1",
            makeStep({ id: "step-1", runId: "run-1", rawResponse: "y".repeat(2000) })
          )
          .catch(() => undefined);
        expect(sentinelFailures).toBe(1);
        // The next ordinary append must not merge with the fragment into one
        // malformed line, or this run would be lost on the next load. Its
        // rotation retry fails too (still over the cap), so the sealed live
        // file is what the next load reads.
        await service
          .createRun("ws-1", makeRun("run-2", "2025-06-01T00:01:00Z"))
          .catch(() => undefined);
        expect(sentinelFailures).toBe(2);
      } finally {
        appendSpy.mockRestore();
      }

      const reloaded = new DevToolsService(config, 1500);
      const runs = await reloaded.getRuns("ws-1");
      expect(runs.map((run) => run.id).sort()).toEqual(["run-1", "run-2"]);
    });

    it("emits the mutation event when a rotation commits but the marker write fails", async () => {
      const config = createTestConfig({ sessionsDir });
      const service = new DevToolsService(config, 700);
      const events: DevToolsEvent[] = [];
      service.on("update:ws-1", (event: DevToolsEvent) => {
        events.push(event);
      });
      const markerFailure = installMarkerWriteFailure(service);

      await service.createRun("ws-1", makeRun("run-1", "2025-06-01T00:00:00Z"));

      // The step's own append crosses the cap; the rotation's snapshot rename
      // commits the step durably before the live-marker write fails, so the
      // rejected createStep must still tell open panels about the step.
      markerFailure.failNext();
      let rejected = false;
      await service
        .createStep(
          "ws-1",
          makeStep({ id: "step-1", runId: "run-1", rawResponse: "y".repeat(800) })
        )
        .catch(() => {
          rejected = true;
        });
      expect(rejected).toBe(true);

      const stepCreated = events.filter((event) => event.type === "step-created");
      expect(stepCreated).toHaveLength(1);
      expect(events.some((event) => event.type === "run-updated")).toBe(true);
    });

    it("notifies subscribers of a committed clear even when the live-marker write fails", async () => {
      const config = createTestConfig({ sessionsDir });
      const service = new DevToolsService(config, 50_000);
      const events: DevToolsEvent[] = [];
      service.on("update:ws-1", (event: DevToolsEvent) => {
        events.push(event);
      });

      await service.createRun("ws-1", makeRun("run-1"));

      // The empty snapshot rename commits the clear before the marker write
      // fails, so panels must drop their run cards even though clear rejects.
      const markerFailure = installMarkerWriteFailure(service);
      markerFailure.failNext();
      let clearError: Error | undefined;
      try {
        await service.clear("ws-1");
      } catch (error) {
        clearError = error instanceof Error ? error : new Error(String(error));
      }
      expect(clearError?.message).toContain("ENOSPC");
      expect(events.filter((event) => event.type === "cleared")).toHaveLength(1);

      // Restarts agree with the notification: the workspace is empty.
      const reloaded = new DevToolsService(config, 50_000);
      expect(await reloaded.getRuns("ws-1")).toEqual([]);
    });

    it("keeps a clear committed at the generation ceiling cleared across restarts", async () => {
      const config = createTestConfig({ sessionsDir });
      const logPath = getDevtoolsLogPath(sessionsDir, "ws-1");
      const rotatedPath = getRotatedLogPath(sessionsDir, "ws-1");
      await fs.mkdir(path.dirname(logPath), { recursive: true });

      // The highest generation the load guard accepts: its own increment is
      // still a safe integer, but the increment's increment is not, so a
      // commit that blindly writes generation + 1 produces a snapshot the
      // next load rejects.
      const ceiling = Number.MAX_SAFE_INTEGER - 1;
      await fs.writeFile(
        rotatedPath,
        `${JSON.stringify({ type: "snapshot-meta", generation: ceiling })}\n`,
        "utf-8"
      );
      await fs.writeFile(
        logPath,
        [
          JSON.stringify({ type: "log-meta", generation: ceiling }),
          JSON.stringify({ type: "run", run: makeRun("run-stale", "2025-06-01T00:00:00Z") }),
        ]
          .map((line) => `${line}\n`)
          .join(""),
        "utf-8"
      );

      const service = new DevToolsService(config, 700);
      expect((await service.getRuns("ws-1")).map((run) => run.id)).toEqual(["run-stale"]);

      // Interrupt the clear's commit after the snapshot rename: the written
      // generation must still pass the next load's guard, or the stale live
      // log would be treated as current and resurrect run-stale.
      const markerFailure = installMarkerWriteFailure(service);
      markerFailure.failNext();
      await service.clear("ws-1").catch(() => undefined);

      const reloaded = new DevToolsService(config, 700);
      expect(await reloaded.getRuns("ws-1")).toEqual([]);
    });

    it("does not let a malformed post-sentinel line discard the snapshot as legacy", async () => {
      const config = createTestConfig({ sessionsDir });
      const logPath = getDevtoolsLogPath(sessionsDir, "ws-1");
      const rotatedPath = getRotatedLogPath(sessionsDir, "ws-1");
      await fs.mkdir(path.dirname(logPath), { recursive: true });

      await fs.writeFile(
        rotatedPath,
        [
          JSON.stringify({ type: "snapshot-meta", generation: 2 }),
          JSON.stringify({ type: "run", run: makeRun("run-kept", "2025-06-01T00:01:00Z") }),
        ]
          .map((line) => `${line}\n`)
          .join(""),
        "utf-8"
      );
      // An interrupted commit's live file: previous pair's marker, stale
      // history, the new commit's retire sentinel, then torn lines that
      // parse as JSON with a recognized type but a missing or gutted
      // payload. Counting either as legacy evidence would clear the
      // snapshot and replay lines that replay into nothing usable.
      await fs.writeFile(
        logPath,
        [
          JSON.stringify({ type: "log-meta", generation: 1 }),
          JSON.stringify({ type: "run", run: makeRun("run-stale", "2025-06-01T00:00:00Z") }),
          JSON.stringify({ type: "log-retire", generation: 2 }),
          JSON.stringify({ type: "step-update" }),
          JSON.stringify({ type: "run", run: { id: "x" } }),
        ]
          .map((line) => `${line}\n`)
          .join(""),
        "utf-8"
      );

      const service = new DevToolsService(config, 50_000);
      expect((await service.getRuns("ws-1")).map((run) => run.id)).toEqual(["run-kept"]);
    });

    it("persists pending base records through the next append when the mid-I/O repair write fails", async () => {
      const config = createTestConfig({ sessionsDir });
      // Cap sized so the oversized step triggers exactly one rotation and
      // run-old (completed) loses its snapshot spot to run-new.
      const service = new DevToolsService(config, 1500);
      type SnapshotFn = (...args: unknown[]) => Promise<void>;
      type RepairFn = (data: unknown, filePath: string, content: string) => Promise<void>;
      const priv = service as unknown as {
        commitSnapshotPair: SnapshotFn;
        appendWithMarkerRepair: RepairFn;
      };
      const originalCommit = priv.commitSnapshotPair.bind(service);
      const originalRepair = priv.appendWithMarkerRepair.bind(service);

      await service.createRun("ws-1", makeRun("run-old", "2025-06-01T00:00:00Z"));
      await service.createStep("ws-1", makeStep({ id: "step-old", runId: "run-old" }));
      await service.createRun("ws-1", makeRun("run-new", "2025-06-01T00:01:00Z"));

      // run-old gains a step while snapshot I/O is in flight, so rotation
      // must re-persist its base records into the fresh live file; that
      // repair write fails once (simulated EIO).
      let failedRepair = false;
      priv.appendWithMarkerRepair = (data, filePath, content) => {
        if (!failedRepair && content.startsWith('{"type":"run"') && content.includes("run-old")) {
          failedRepair = true;
          return Promise.reject(new Error("EIO: simulated repair append failure"));
        }
        return originalRepair(data, filePath, content);
      };
      let midIo: Promise<void> | undefined;
      priv.commitSnapshotPair = async (...args: unknown[]) => {
        priv.commitSnapshotPair = originalCommit;
        midIo = service
          .createStep("ws-1", makeStep({ id: "step-mid-old", runId: "run-old" }))
          .then(() => undefined);
        await originalCommit(...args);
      };
      await service
        .createStep(
          "ws-1",
          makeStep({ id: "step-new", runId: "run-new", rawResponse: "y".repeat(2000) })
        )
        .catch(() => undefined);
      expect(failedRepair).toBe(true);
      expect(midIo).toBeDefined();
      await midIo;

      // The queued step append completed the pending base repair first, so
      // run-old's records are durable and the run survives a restart.
      const reloaded = new DevToolsService(config, 1500);
      const runs = await reloaded.getRuns("ws-1");
      expect(runs.map((run) => run.id).sort()).toEqual(["run-new", "run-old"]);
      const runWithSteps = await reloaded.getRunWithSteps("ws-1", "run-old");
      expect(runWithSteps?.steps.map((step) => step.id).sort()).toEqual([
        "step-mid-old",
        "step-old",
      ]);
    });

    it("recovers a pending base repair whose first attempt wrote a partial fragment", async () => {
      const config = createTestConfig({ sessionsDir });
      const service = new DevToolsService(config, 1500);
      const logPath = getDevtoolsLogPath(sessionsDir, "ws-1");
      type SnapshotFn = (...args: unknown[]) => Promise<void>;
      type RepairFn = (data: unknown, filePath: string, content: string) => Promise<void>;
      const priv = service as unknown as {
        commitSnapshotPair: SnapshotFn;
        appendWithMarkerRepair: RepairFn;
      };
      const originalCommit = priv.commitSnapshotPair.bind(service);
      const originalRepair = priv.appendWithMarkerRepair.bind(service);

      await service.createRun("ws-1", makeRun("run-old", "2025-06-01T00:00:00Z"));
      await service.createStep("ws-1", makeStep({ id: "step-old", runId: "run-old" }));
      await service.createRun("ws-1", makeRun("run-new", "2025-06-01T00:01:00Z"));

      // The mid-I/O base repair writes only part of run-old's record before
      // rejecting (disk full mid-write): the retry must not merge with that
      // fragment into one malformed line, or the run stays lost after restart.
      let failedRepair = false;
      priv.appendWithMarkerRepair = async (data, filePath, content) => {
        if (!failedRepair && content.startsWith('{"type":"run"') && content.includes("run-old")) {
          failedRepair = true;
          await fs.appendFile(filePath, content.slice(0, 30), "utf-8");
          throw new Error("ENOSPC: simulated partial repair write");
        }
        return originalRepair(data, filePath, content);
      };
      let midIo: Promise<void> | undefined;
      priv.commitSnapshotPair = async (...args: unknown[]) => {
        priv.commitSnapshotPair = originalCommit;
        midIo = service
          .createStep("ws-1", makeStep({ id: "step-mid-old", runId: "run-old" }))
          .then(() => undefined);
        await originalCommit(...args);
      };
      await service
        .createStep(
          "ws-1",
          makeStep({ id: "step-new", runId: "run-new", rawResponse: "y".repeat(2000) })
        )
        .catch(() => undefined);
      expect(failedRepair).toBe(true);
      expect(midIo).toBeDefined();
      await midIo;
      // The fragment really is on disk (unterminated), so this exercises the
      // seal rather than a clean retry.
      expect((await fs.readFile(logPath, "utf-8")).includes('{"type":"run"')).toBe(true);

      const reloaded = new DevToolsService(config, 1500);
      const runs = await reloaded.getRuns("ws-1");
      expect(runs.map((run) => run.id).sort()).toEqual(["run-new", "run-old"]);
      const runWithSteps = await reloaded.getRunWithSteps("ws-1", "run-old");
      expect(runWithSteps?.steps.map((step) => step.id).sort()).toEqual([
        "step-mid-old",
        "step-old",
      ]);
    });

    it("does not requeue pre-clear base records when a clear lands during the failed repair append", async () => {
      const config = createTestConfig({ sessionsDir });
      const service = new DevToolsService(config, 1500);
      type SnapshotFn = (...args: unknown[]) => Promise<void>;
      type RepairFn = (data: unknown, filePath: string, content: string) => Promise<void>;
      const priv = service as unknown as {
        commitSnapshotPair: SnapshotFn;
        appendWithMarkerRepair: RepairFn;
      };
      const originalCommit = priv.commitSnapshotPair.bind(service);
      const originalRepair = priv.appendWithMarkerRepair.bind(service);

      await service.createRun("ws-1", makeRun("run-old", "2025-06-01T00:00:00Z"));
      await service.createStep("ws-1", makeStep({ id: "step-old", runId: "run-old" }));
      await service.createRun("ws-1", makeRun("run-new", "2025-06-01T00:01:00Z"));

      // clear() lands while reconciliation awaits run-old's failing base
      // repair: the clear empties the repair queue, so the catch must not
      // repopulate it with pre-clear records that the next successful
      // append would flush into the post-clear live file.
      let clearPromise: Promise<void> | undefined;
      let failedRepair = false;
      priv.appendWithMarkerRepair = (data, filePath, content) => {
        if (!failedRepair && content.startsWith('{"type":"run"') && content.includes("run-old")) {
          failedRepair = true;
          clearPromise = service.clear("ws-1");
          return Promise.reject(new Error("EIO: simulated repair append failure"));
        }
        return originalRepair(data, filePath, content);
      };
      let midIo: Promise<void> | undefined;
      priv.commitSnapshotPair = async (...args: unknown[]) => {
        priv.commitSnapshotPair = originalCommit;
        midIo = service
          .createStep("ws-1", makeStep({ id: "step-mid-old", runId: "run-old" }))
          .catch(() => undefined);
        await originalCommit(...args);
      };
      await service
        .createStep(
          "ws-1",
          makeStep({ id: "step-new", runId: "run-new", rawResponse: "y".repeat(2000) })
        )
        .catch(() => undefined);
      expect(failedRepair).toBe(true);
      expect(clearPromise).toBeDefined();
      await clearPromise!.catch(() => undefined);
      await midIo;

      // The first post-clear append flushes any queued repairs; cleared
      // history must not ride along with it.
      await service.createRun("ws-1", makeRun("run-after", "2025-06-01T00:02:00Z"));

      const reloaded = new DevToolsService(config, 1500);
      const runs = await reloaded.getRuns("ws-1");
      expect(runs.map((run) => run.id)).toEqual(["run-after"]);
    });

    it("keeps a run recreated after a mid-rotation clear instead of evicting it", async () => {
      const config = createTestConfig({ sessionsDir });
      const service = new DevToolsService(config, 1500);
      type SnapshotFn = (...args: unknown[]) => Promise<void>;
      const priv = service as unknown as {
        commitSnapshotPair: SnapshotFn;
        workspaces: Map<string, { runs: Map<string, unknown> }>;
      };
      const originalCommit = priv.commitSnapshotPair.bind(service);

      await service.createRun("ws-1", makeRun("run-old", "2025-06-01T00:00:00Z"));
      await service.createStep("ws-1", makeStep({ id: "step-old", runId: "run-old" }));
      await service.createRun("ws-1", makeRun("run-new", "2025-06-01T00:01:00Z"));

      // clear() lands while rotation awaits snapshot I/O, then the active
      // middleware recreates run-old's frozen ID via createStep's self-heal.
      // The recreated run has no steps in the maps yet (createStep awaits the
      // queued run append first), so the frozen retention decision would
      // otherwise evict it, skip its queued base append, and throw on the
      // missing run when createStep resumes.
      let clearPromise: Promise<void> | undefined;
      let recreatePromise: Promise<void> | undefined;
      priv.commitSnapshotPair = async (...args: unknown[]) => {
        priv.commitSnapshotPair = originalCommit;
        clearPromise = service.clear("ws-1");
        recreatePromise = service.createStep(
          "ws-1",
          makeStep({ id: "step-post-clear", runId: "run-old", startedAt: "2025-06-01T00:02:00Z" })
        );
        while (!priv.workspaces.get("ws-1")?.runs.has("run-old")) {
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
        await originalCommit(...args);
      };
      await service.createStep(
        "ws-1",
        makeStep({ id: "step-new", runId: "run-new", rawResponse: "y".repeat(2000) })
      );
      expect(clearPromise).toBeDefined();
      expect(recreatePromise).toBeDefined();
      await clearPromise;
      await recreatePromise;

      // Post-clear state is exactly the recreated run and its step, durably.
      const reloaded = new DevToolsService(config, 1500);
      const runs = await reloaded.getRuns("ws-1");
      expect(runs.map((run) => run.id)).toEqual(["run-old"]);
      const runWithSteps = await reloaded.getRunWithSteps("ws-1", "run-old");
      expect(runWithSteps?.steps.map((step) => step.id)).toEqual(["step-post-clear"]);
    });

    it("does not emit a step update after its run was evicted by that append's rotation", async () => {
      const config = createTestConfig({ sessionsDir });
      const service = new DevToolsService(config, 1000);
      const events: DevToolsEvent[] = [];
      service.on("update:ws-1", (event: DevToolsEvent) => {
        events.push(event);
      });

      await service.createRun("ws-1", makeRun("run-1", "2025-06-01T00:00:00Z"));
      await service.createStep(
        "ws-1",
        makeStep({ id: "step-1", runId: "run-1", durationMs: null })
      );
      await service.createRun("ws-1", makeRun("run-2", "2025-06-01T00:01:00Z"));
      await service.createStep(
        "ws-1",
        makeStep({ id: "step-2", runId: "run-2", durationMs: null })
      );

      // The final step-update completes run-1 and crosses the cap, so the
      // rotation inside this very append evicts run-1 (run-2 stays active).
      await service.updateStep("ws-1", "step-1", {
        durationMs: 100,
        rawResponse: "z".repeat(800),
      });

      expect(events.filter((event) => event.type === "runs-evicted")).toEqual([
        { type: "runs-evicted", runIds: ["run-1"] },
      ]);
      // No step-updated may follow the eviction: subscribers would re-add
      // the step that backend and disk no longer contain.
      expect(events.filter((event) => event.type === "step-updated")).toEqual([]);
    });

    it("clear() leaves no replayable entries in either log file", async () => {
      const config = createTestConfig({ sessionsDir });
      const service = new DevToolsService(config, 1);
      const rotatedPath = getRotatedLogPath(sessionsDir, "ws-1");

      await service.createRun("ws-1", makeRun("run-1"));
      expect(await pathExists(rotatedPath)).toBe(true);

      await service.clear("ws-1");
      const entryTypes = async (filePath: string) =>
        (await fs.readFile(filePath, "utf-8"))
          .split("\n")
          .filter(Boolean)
          .map((line) => (JSON.parse(line) as { type: string }).type);
      // Both files hold only generation markers (disk reclaimed, nothing replayable).
      expect(await entryTypes(rotatedPath)).toEqual(["snapshot-meta"]);
      expect(await entryTypes(getDevtoolsLogPath(sessionsDir, "ws-1"))).toEqual(["log-meta"]);
      expect((await new DevToolsService(config, 1).getRuns("ws-1")).length).toBe(0);
    });

    it("an interrupted clear stays cleared after restart", async () => {
      const config = createTestConfig({ sessionsDir });
      const service = new DevToolsService(config, 1);
      const logPath = getDevtoolsLogPath(sessionsDir, "ws-1");
      const rotatedPath = getRotatedLogPath(sessionsDir, "ws-1");

      await service.createRun("ws-1", makeRun("run-1"));
      const liveBeforeClear = await fs.readFile(logPath, "utf-8");
      await service.clear("ws-1");
      // Simulate a crash between clear's snapshot commit and its live-log
      // rewrite: the pre-clear live content is still on disk.
      await fs.writeFile(logPath, liveBeforeClear, "utf-8");

      const reloaded = new DevToolsService(config, 1);
      expect((await reloaded.getRuns("ws-1")).length).toBe(0);
      expect(await pathExists(rotatedPath)).toBe(true);
    });

    it("removeWorkspaceData also removes the rotated file", async () => {
      const config = createTestConfig({ sessionsDir });
      const service = new DevToolsService(config, 1);
      const rotatedPath = getRotatedLogPath(sessionsDir, "ws-1");

      await service.createRun("ws-1", makeRun("run-1"));
      expect(await pathExists(rotatedPath)).toBe(true);

      await service.removeWorkspaceData("ws-1");
      expect(await pathExists(rotatedPath)).toBe(false);
      expect(await pathExists(getDevtoolsLogPath(sessionsDir, "ws-1"))).toBe(false);
    });
  });
});
