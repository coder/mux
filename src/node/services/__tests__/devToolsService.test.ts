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
      expect(await fs.readFile(getDevtoolsLogPath(sessionsDir, "ws-1"), "utf-8")).toBe("");
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

    it("defaults missing raw fields to null when replaying legacy step entries", async () => {
      const config = createTestConfig({ sessionsDir, enabled: true });
      const run = makeRun("run-1");
      const legacyStep = {
        ...makeStep({ id: "step-1", runId: "run-1" }),
      };
      delete (legacyStep as Record<string, unknown>).rawChunks;
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

    it("clear truncates persisted file", async () => {
      const service = new DevToolsService(createTestConfig({ sessionsDir, enabled: true }));
      await service.createRun("ws-1", makeRun("run-1"));
      await service.clear("ws-1");

      expect(await fs.readFile(getDevtoolsLogPath(sessionsDir, "ws-1"), "utf-8")).toBe("");
    });
  });

  describe("event emission", () => {
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
});
