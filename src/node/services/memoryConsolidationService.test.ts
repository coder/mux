import { describe, expect, it } from "bun:test";

import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";

import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import { Ok } from "@/common/types/result";
import { Config } from "@/node/config";
import { MemoryConsolidationService, resolveDreamModelString } from "./memoryConsolidationService";
import { MemoryMetaService } from "./memoryMeta";
import { MemoryService } from "./memoryService";
import { TestTempDir } from "./tools/testHelpers";

/**
 * Behavior under test: the orchestration rails around the runner —
 * experiment gating, per-workspace debounce (manual bypass), journal
 * persistence, and launch-sweep selection. The model is a scripted mock that
 * finishes without tool calls ("no changes needed" run).
 */

function scriptedModel(): MockLanguageModelV3 {
  // Chunk list typed explicitly: simulateReadableStream's inferred union
  // otherwise collapses optional fields and fails LanguageModelV3 assignment.
  const chunks: LanguageModelV3StreamPart[] = [
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: "no changes needed" },
    { type: "text-end", id: "t1" },
    {
      type: "finish",
      finishReason: { unified: "stop", raw: "stop" },
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 1, text: 1, reasoning: 0 },
      },
    },
  ];
  return new MockLanguageModelV3({
    doStream: () => Promise.resolve({ stream: simulateReadableStream({ chunks }) }),
  });
}

interface Fixture extends Disposable {
  muxHome: string;
  config: Config;
  service: MemoryConsolidationService;
  metaService: MemoryMetaService;
  modelCalls: number[];
  setEnabled: (enabled: boolean) => void;
}

async function createFixture(): Promise<Fixture> {
  const tempDir = new TestTempDir("test-memory-consolidation-service");
  const muxHome = path.join(tempDir.path, "mux-home");
  await fsPromises.mkdir(path.join(muxHome, "memory"), { recursive: true });

  const config = new Config(muxHome);
  // Register a workspace so config.findWorkspace resolves it.
  await config.editConfig((cfg) => {
    cfg.projects.set("/projects/demo", {
      workspaces: [{ id: "ws-dream", name: "ws-dream", path: "/projects/demo/ws-dream" }],
    });
    return cfg;
  });

  const metaService = new MemoryMetaService(muxHome);
  const memoryService = new MemoryService(config, metaService);

  let enabled = true;
  const modelCalls: number[] = [];
  const service = new MemoryConsolidationService(
    config,
    memoryService,
    metaService,
    {
      createModel: () => {
        modelCalls.push(Date.now());
        return Promise.resolve(Ok(scriptedModel()));
      },
    },
    {
      isExperimentEnabled: (id) =>
        enabled && (id === EXPERIMENT_IDS.MEMORY || id === EXPERIMENT_IDS.MEMORY_CONSOLIDATION),
    }
  );

  return {
    muxHome,
    config,
    service,
    metaService,
    modelCalls,
    setEnabled: (value) => {
      enabled = value;
    },
    [Symbol.dispose]() {
      tempDir[Symbol.dispose]();
    },
  };
}

describe("MemoryConsolidationService", () => {
  it("runs, persists the journal record, and reports it via getRecord", async () => {
    using fixture = await createFixture();
    const result = await fixture.service.maybeRun("ws-dream", "compaction");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.trigger).toBe("compaction");
      expect(result.data.summary).toContain("no changes needed");
    }

    const record = await fixture.service.getRecord("ws-dream");
    expect(record?.trigger).toBe("compaction");
    // Persisted to the sidecar, not just memory.
    const raw = await fsPromises.readFile(
      path.join(fixture.muxHome, "memory-consolidation.json"),
      "utf-8"
    );
    expect(raw).toContain("ws-dream");
  });

  it("debounces automatic triggers but lets manual runs through", async () => {
    using fixture = await createFixture();
    expect((await fixture.service.maybeRun("ws-dream", "compaction")).success).toBe(true);

    const debounced = await fixture.service.maybeRun("ws-dream", "archive");
    expect(debounced.success).toBe(false);
    if (!debounced.success) expect(debounced.error).toContain("debounced");

    const manual = await fixture.service.maybeRun("ws-dream", "manual");
    expect(manual.success).toBe(true);
    expect(fixture.modelCalls).toHaveLength(2);
  });

  it("does nothing when the experiment is disabled", async () => {
    using fixture = await createFixture();
    fixture.setEnabled(false);
    const result = await fixture.service.maybeRun("ws-dream", "manual");
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain("disabled");
    expect(fixture.modelCalls).toHaveLength(0);

    fixture.service.triggerInBackground("ws-dream", "compaction");
    expect(fixture.modelCalls).toHaveLength(0);
  });

  it("launch sweep selects only idle workspaces with memory writes since the last run", async () => {
    using fixture = await createFixture();
    const now = Date.now();
    const dayAgo = now - 25 * 60 * 60 * 1000;

    // No writes recorded => sweep skips even idle workspaces.
    await fixture.service.runLaunchSweep(new Map([["ws-dream", dayAgo]]));
    expect(fixture.modelCalls).toHaveLength(0);

    // A fresh global write qualifies the idle workspace.
    await fixture.metaService.recordAccess("global:lesson.md", { write: true });
    await fixture.service.runLaunchSweep(new Map([["ws-dream", dayAgo]]));
    expect(fixture.modelCalls).toHaveLength(1);

    // Recently-active workspaces are never swept regardless of writes.
    await fixture.metaService.recordAccess("global:lesson2.md", { write: true });
    await fixture.service.runLaunchSweep(new Map([["ws-dream", now]]));
    expect(fixture.modelCalls).toHaveLength(1);
  });

  it("resolves the dream model via the inherit cascade", async () => {
    using fixture = await createFixture();
    // No overrides anywhere => app default.
    const fallback = resolveDreamModelString(fixture.config, "ws-dream");
    expect(fallback.length).toBeGreaterThan(0);

    // Global dream default wins over the app default.
    await fixture.config.editConfig((cfg) => {
      cfg.agentAiDefaults = { dream: { modelString: "anthropic:claude-test-dream" } };
      return cfg;
    });
    expect(resolveDreamModelString(fixture.config, "ws-dream")).toBe("anthropic:claude-test-dream");
  });
});
