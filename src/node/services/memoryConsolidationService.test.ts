import { describe, expect, it } from "bun:test";

import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import type { LanguageModelV3CallOptions, LanguageModelV3StreamPart } from "@ai-sdk/provider";

import type { MemoryConsolidationStatusChangeEventPayload } from "@/common/orpc/schemas/memory";
import { MULTI_PROJECT_CONFIG_KEY } from "@/common/constants/multiProject";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import {
  MEMORY_CONSOLIDATION_DEBOUNCE_MS,
  MEMORY_CONSOLIDATION_LAUNCH_SWEEP_CAP,
} from "@/common/constants/memory";
import { Ok } from "@/common/types/result";
import { Config } from "@/node/config";
import {
  MemoryConsolidationService,
  resolveDreamAgentBody,
  resolveDreamModelString,
} from "./memoryConsolidationService";
import { memoryLogicalKey, MemoryMetaService } from "./memoryMeta";
import { MemoryService } from "./memoryService";
import { TestTempDir } from "./tools/testHelpers";

/**
 * Behavior under test: the orchestration rails around the runner —
 * experiment gating, per-workspace debounce (manual bypass), journal
 * persistence, and launch-sweep selection. The model is a scripted mock that
 * finishes without tool calls ("no changes needed" run).
 */

function userPromptText(options: LanguageModelV3CallOptions): string {
  const parts: string[] = [];
  for (const message of options.prompt) {
    if (message.role !== "user") continue;
    for (const part of message.content) {
      if (part.type === "text") parts.push(part.text);
    }
  }
  return parts.join("\n");
}

function scriptedModel(capturePrompt?: (prompt: string) => void): MockLanguageModelV3 {
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
    doStream: (options) => {
      capturePrompt?.(userPromptText(options));
      return Promise.resolve({ stream: simulateReadableStream({ chunks }) });
    },
  });
}

/**
 * Simulates a provider failure or timeout abort: the stream itself errors
 * mid-flight (an `error` chunk part alone would not reach consumeStream's
 * onError — real connection failures reject the stream).
 */
function failingScriptedModel(capturePrompt?: (prompt: string) => void): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doStream: (options) => {
      capturePrompt?.(userPromptText(options));
      return Promise.resolve({
        stream: new ReadableStream<LanguageModelV3StreamPart>({
          pull(controller) {
            controller.error(new Error("provider exploded"));
          },
        }),
      });
    },
  });
}

function projectMutationModel(): MockLanguageModelV3 {
  let streamCount = 0;
  return new MockLanguageModelV3({
    doStream: () => {
      streamCount++;
      const chunks: LanguageModelV3StreamPart[] =
        streamCount === 1
          ? [
              {
                type: "tool-call",
                toolCallId: "project-write",
                toolName: "memory",
                input: JSON.stringify({
                  command: "create",
                  path: "/memories/project/should-not-exist.md",
                  file_text: "must not be written\n",
                }),
              },
              {
                type: "finish",
                finishReason: { unified: "tool-calls", raw: "tool-calls" },
                usage: {
                  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                  outputTokens: { total: 1, text: 0, reasoning: 0 },
                },
              },
            ]
          : [
              { type: "text-start", id: "t1" },
              { type: "text-delta", id: "t1", delta: "project write attempted" },
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
      return Promise.resolve({ stream: simulateReadableStream({ chunks }) });
    },
  });
}

interface Fixture extends Disposable {
  muxHome: string;
  config: Config;
  service: MemoryConsolidationService;
  metaService: MemoryMetaService;
  modelCalls: number[];
  modelPrompts: string[];
  setEnabled: (enabled: boolean) => void;
  /** When true, scripted runs emit a fatal stream error instead of finishing. */
  setStreamFailing: (failing: boolean) => void;
  addWorkspace: (id: string, opts?: { archivedAt?: string }) => Promise<void>;
  addMultiProjectWorkspace: (id: string, opts?: { bucket?: string }) => Promise<void>;
}

async function createFixture(options?: {
  /** Holds every model run open until resolved (for in-flight race tests). */
  modelGate?: Promise<void>;
  modelFactory?: () => MockLanguageModelV3;
}): Promise<Fixture> {
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
  let streamFailing = false;
  const modelCalls: number[] = [];
  const modelPrompts: string[] = [];
  const capturePrompt = (prompt: string) => modelPrompts.push(prompt);
  const service = new MemoryConsolidationService(
    config,
    memoryService,
    metaService,
    {
      createModel: async () => {
        modelCalls.push(Date.now());
        if (options?.modelGate) await options.modelGate;
        return Ok(
          options?.modelFactory?.() ??
            (streamFailing ? failingScriptedModel(capturePrompt) : scriptedModel(capturePrompt))
        );
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
    modelPrompts,
    setEnabled: (value) => {
      enabled = value;
    },
    setStreamFailing: (value) => {
      streamFailing = value;
    },
    addWorkspace: async (id, opts) => {
      await config.editConfig((cfg) => {
        cfg.projects.get("/projects/demo")?.workspaces.push({
          id,
          name: id,
          path: `/projects/demo/${id}`,
          archivedAt: opts?.archivedAt,
        });
        return cfg;
      });
    },
    addMultiProjectWorkspace: async (id, opts) => {
      await config.editConfig((cfg) => {
        const bucket = opts?.bucket ?? MULTI_PROJECT_CONFIG_KEY;
        let project = cfg.projects.get(bucket);
        if (project === undefined) {
          project = { workspaces: [] };
          cfg.projects.set(bucket, project);
        }
        project.workspaces.push({
          id,
          name: id,
          path: `/projects/multi/${id}`,
          projects: [
            { projectName: "demo", projectPath: "/projects/demo" },
            { projectName: "other", projectPath: "/projects/other" },
          ],
        });
        return cfg;
      });
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

  it("emits status invalidation for successful no-op runs", async () => {
    using fixture = await createFixture();
    const events: MemoryConsolidationStatusChangeEventPayload[] = [];
    fixture.service.on("statusChange", (event: MemoryConsolidationStatusChangeEventPayload) => {
      events.push(event);
    });

    const result = await fixture.service.maybeRun("ws-dream", "manual");

    expect(result.success).toBe(true);
    if (result.success) expect(result.data.ops).toHaveLength(0);
    expect(events).toEqual([
      {
        kind: "consolidation_status",
        workspaceId: "ws-dream",
        projectPath: "/projects/demo",
      },
    ]);
  });

  it("records project coverage for single-project workspace runs", async () => {
    using fixture = await createFixture();

    const result = await fixture.service.maybeRun("ws-dream", "manual");
    expect(result.success).toBe(true);

    const raw = JSON.parse(
      await fsPromises.readFile(path.join(fixture.muxHome, "memory-consolidation.json"), "utf-8")
    ) as { projects?: Record<string, unknown> };
    expect(raw.projects?.["/projects/demo"]).toBeDefined();
  });

  it("does not record project coverage for multi-project workspace runs", async () => {
    using fixture = await createFixture();
    await fixture.addMultiProjectWorkspace("ws-multi");

    const result = await fixture.service.maybeRun("ws-multi", "manual");
    expect(result.success).toBe(true);

    const raw = JSON.parse(
      await fsPromises.readFile(path.join(fixture.muxHome, "memory-consolidation.json"), "utf-8")
    ) as { projects?: Record<string, unknown>; workspaces?: Record<string, unknown> };
    expect(raw.workspaces?.["ws-multi"]).toBeDefined();
    expect(raw.projects?.["/projects/demo"]).toBeUndefined();
    expect(raw.projects?.["/projects/other"]).toBeUndefined();
  });

  it("disables project memory for multi-project workspace runs stored under a project bucket", async () => {
    using fixture = await createFixture({ modelFactory: projectMutationModel });
    await fixture.addMultiProjectWorkspace("ws-task", { bucket: "/projects/demo" });

    const result = await fixture.service.maybeRun("ws-task", "manual");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.ops).toHaveLength(1);
      expect(result.data.ops[0]?.applied).toBe(false);
      expect(result.data.ops[0]?.note).toContain("single-project");
    }

    const raw = JSON.parse(
      await fsPromises.readFile(path.join(fixture.muxHome, "memory-consolidation.json"), "utf-8")
    ) as { projects?: Record<string, unknown>; workspaces?: Record<string, unknown> };
    expect(raw.workspaces?.["ws-task"]).toBeDefined();
    expect(raw.projects?.["/projects/demo"]).toBeUndefined();

    const status = await fixture.service.getStatus("ws-task");
    expect(status.projectAvailable).toBe(false);
    expect(status.projectRecord).toBeNull();
  });

  it("reports workspace, project, and global coverage separately", async () => {
    using fixture = await createFixture();
    await fixture.addWorkspace("ws-sibling");
    expect((await fixture.service.maybeRun("ws-dream", "manual")).success).toBe(true);

    const siblingStatus = await fixture.service.getStatus("ws-sibling");
    expect(siblingStatus.workspaceRecord).toBeNull();
    expect(siblingStatus.projectAvailable).toBe(true);
    expect(siblingStatus.projectRecord?.trigger).toBe("manual");
    expect(siblingStatus.globalRecord?.trigger).toBe("manual");
  });

  it("does not treat older workspace-only records as project coverage", async () => {
    using fixture = await createFixture();
    await fsPromises.writeFile(
      path.join(fixture.muxHome, "memory-consolidation.json"),
      JSON.stringify({
        workspaces: {
          "ws-dream": {
            lastRunAt: Date.now(),
            trigger: "manual",
            summary: "old record",
            ops: [],
          },
        },
      })
    );

    const status = await fixture.service.getStatus("ws-dream");
    expect(status.workspaceRecord?.summary).toBe("old record");
    expect(status.projectAvailable).toBe(true);
    expect(status.projectRecord).toBeNull();
    expect(status.globalRecord?.summary).toBe("old record");
  });

  it("debounces automatic triggers but lets manual and archive runs through", async () => {
    using fixture = await createFixture();
    expect((await fixture.service.maybeRun("ws-dream", "compaction")).success).toBe(true);

    const debounced = await fixture.service.maybeRun("ws-dream", "compaction");
    expect(debounced.success).toBe(false);
    if (!debounced.success) expect(debounced.error).toContain("debounced");

    // Archive bypasses debounce: it is the workspace's one-shot final pass
    // for promoting durable lessons to the narrowest available scope and
    // typically lands right after a compaction-triggered run anchored the debounce window.
    const archive = await fixture.service.maybeRun("ws-dream", "archive");
    expect(archive.success).toBe(true);

    const manual = await fixture.service.maybeRun("ws-dream", "manual");
    expect(manual.success).toBe(true);
    expect(fixture.modelCalls).toHaveLength(3);
  });

  it("routes project-specific archive final-pass promotions to project memory when available", async () => {
    using fixture = await createFixture();

    const result = await fixture.service.maybeRun("ws-dream", "archive");
    expect(result.success).toBe(true);

    const prompt = fixture.modelPrompts.at(-1) ?? "";
    expect(prompt).toMatch(/repo-specific[\s\S]*\/memories\/project\//);
    expect(prompt).toMatch(/cross-project[\s\S]*\/memories\/global\//);
    expect(prompt).not.toMatch(
      /durable lessons from \/memories\/workspace\/\.\.\. to \/memories\/global\//
    );
  });

  it("does not advertise project-scope promotion in archive final-pass prompts when unavailable", async () => {
    using fixture = await createFixture();
    await fixture.addMultiProjectWorkspace("ws-multi");

    const result = await fixture.service.maybeRun("ws-multi", "archive");
    expect(result.success).toBe(true);

    const prompt = fixture.modelPrompts.at(-1) ?? "";
    expect(prompt).not.toContain("/memories/project/");
    expect(prompt).toMatch(/cross-project[\s\S]*\/memories\/global\//);
    expect(prompt).toMatch(/not promote[\s\S]*project-specific[\s\S]*global/);
  });

  it("rejects a second trigger while a run is still in flight", async () => {
    let releaseModel!: () => void;
    const modelGate = new Promise<void>((resolve) => {
      releaseModel = resolve;
    });
    using fixture = await createFixture({ modelGate });

    // Run lock must be reserved synchronously: the model-creation await keeps
    // the first run open while the second trigger arrives.
    const first = fixture.service.maybeRun("ws-dream", "manual");
    const second = await fixture.service.maybeRun("ws-dream", "compaction");
    expect(second.success).toBe(false);
    if (!second.success) expect(second.error).toContain("in flight");

    releaseModel();
    expect((await first).success).toBe(true);
    expect(fixture.modelCalls).toHaveLength(1);
  });

  it("queues an archive trigger behind an in-flight run instead of dropping it", async () => {
    let releaseModel!: () => void;
    const modelGate = new Promise<void>((resolve) => {
      releaseModel = resolve;
    });
    using fixture = await createFixture({ modelGate });

    const first = fixture.service.maybeRun("ws-dream", "compaction");
    // The archive caller never retries and only archive sets finalPass, so
    // dropping it here would silently skip final-scope promotion.
    const archive = fixture.service.maybeRun("ws-dream", "archive");
    const dropped = await fixture.service.maybeRun("ws-dream", "manual");
    expect(dropped.success).toBe(false);

    releaseModel();
    expect((await first).success).toBe(true);
    const archiveResult = await archive;
    expect(archiveResult.success).toBe(true);
    if (archiveResult.success) expect(archiveResult.data.trigger).toBe("archive");
    expect(fixture.modelCalls).toHaveLength(2);
  });

  it("does not journal or debounce a run whose stream failed", async () => {
    using fixture = await createFixture();
    fixture.setStreamFailing(true);
    const failed = await fixture.service.maybeRun("ws-dream", "compaction");
    expect(failed.success).toBe(false);
    if (!failed.success) expect(failed.error).toContain("stream failed");
    // No record: the Memory tab must not report a consolidation that never
    // completed.
    expect(await fixture.service.getRecord("ws-dream")).toBeNull();

    // And no debounce anchor: the next automatic trigger retries immediately.
    fixture.setStreamFailing(false);
    const retry = await fixture.service.maybeRun("ws-dream", "compaction");
    expect(retry.success).toBe(true);
    expect(fixture.modelCalls).toHaveLength(2);
  });

  it("self-heals a corrupt sidecar instead of failing every later read", async () => {
    using fixture = await createFixture();
    const sidecarPath = path.join(fixture.muxHome, "memory-consolidation.json");
    // typeof null === "object": this once passed a hand-rolled validity check
    // and then blew up getRecord/saveRecord with a TypeError forever.
    await fsPromises.writeFile(sidecarPath, JSON.stringify({ workspaces: null }));
    expect(await fixture.service.getRecord("ws-dream")).toBeNull();

    // The next completed run repairs the file.
    expect((await fixture.service.maybeRun("ws-dream", "manual")).success).toBe(true);
    const record = await fixture.service.getRecord("ws-dream");
    expect(record?.trigger).toBe("manual");
  });

  it("dream override shadows the built-in; malformed overrides fall back", async () => {
    using fixture = await createFixture();
    // Resolution is rooted at the provided mux root (Config.rootDir), never a
    // hardcoded ~/.mux — the fixture root proves the isolation.
    const builtIn = await resolveDreamAgentBody(fixture.muxHome);
    expect(builtIn).not.toBeNull();

    const agentsDir = path.join(fixture.muxHome, "agents");
    await fsPromises.mkdir(agentsDir, { recursive: true });
    await fsPromises.writeFile(
      path.join(agentsDir, "dream.md"),
      "---\nname: Dream\n---\n\nCustom dream body\n"
    );
    expect(await resolveDreamAgentBody(fixture.muxHome)).toBe("Custom dream body");

    // Malformed override (missing frontmatter) falls back to the built-in.
    await fsPromises.writeFile(path.join(agentsDir, "dream.md"), "body without frontmatter\n");
    expect(await resolveDreamAgentBody(fixture.muxHome)).toBe(builtIn);
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

  it("launch sweep skips archived workspaces and caps runs per launch", async () => {
    using fixture = await createFixture();
    const dayAgo = Date.now() - 25 * 60 * 60 * 1000;
    const writeFor = (workspaceId: string) =>
      fixture.metaService.recordAccess(
        memoryLogicalKey("workspace", "lesson.md", { projectPath: "", workspaceId }),
        { write: true }
      );
    await fixture.addWorkspace("ws-archived", { archivedAt: new Date().toISOString() });
    await writeFor("ws-archived");
    const extraIds: string[] = [];
    for (let i = 0; i < MEMORY_CONSOLIDATION_LAUNCH_SWEEP_CAP + 1; i++) {
      const id = `ws-extra-${i}`;
      extraIds.push(id);
      await fixture.addWorkspace(id);
      // Each workspace qualifies via its own workspace-scope write.
      await writeFor(id);
    }

    const recency = new Map<string, number>([
      ["ws-archived", dayAgo],
      ...extraIds.map((id): [string, number] => [id, dayAgo]),
    ]);
    await fixture.service.runLaunchSweep(recency);

    // Archived workspaces never run (they got their final pass at archive
    // time) and the cap bounds the rest.
    expect(fixture.modelCalls).toHaveLength(MEMORY_CONSOLIDATION_LAUNCH_SWEEP_CAP);
    expect(await fixture.service.getRecord("ws-archived")).toBeNull();
    expect(
      await fixture.service.getRecord(`ws-extra-${MEMORY_CONSOLIDATION_LAUNCH_SWEEP_CAP}`)
    ).toBeNull();
  });

  it("a project-only write qualifies one sibling workspace per sweep", async () => {
    using fixture = await createFixture();
    await fixture.addWorkspace("ws-other");
    const dayAgo = Date.now() - 25 * 60 * 60 * 1000;
    await fixture.metaService.recordAccess(
      memoryLogicalKey("project", "lesson.md", {
        projectPath: "/projects/demo",
        workspaceId: "ws-dream",
      }),
      { write: true }
    );

    await fixture.service.runLaunchSweep(
      new Map([
        ["ws-dream", dayAgo],
        ["ws-other", dayAgo],
      ])
    );

    expect(fixture.modelCalls).toHaveLength(1);
  });

  it("debounces project-only launch writes against recent project coverage", async () => {
    using fixture = await createFixture();
    await fixture.addWorkspace("ws-other");
    const dayAgo = Date.now() - 25 * 60 * 60 * 1000;
    const recentProjectRunAt = Date.now() - 60_000;
    await fsPromises.writeFile(
      path.join(fixture.muxHome, "memory-consolidation.json"),
      JSON.stringify({
        workspaces: {},
        projects: {
          "/projects/demo": {
            lastRunAt: recentProjectRunAt,
            trigger: "launch",
            summary: "recent project coverage",
            ops: [],
          },
        },
      })
    );
    await fixture.metaService.recordAccess(
      memoryLogicalKey("project", "new.md", {
        projectPath: "/projects/demo",
        workspaceId: "ws-dream",
      }),
      { write: true }
    );

    await fixture.service.runLaunchSweep(new Map([["ws-other", dayAgo]]));

    expect(fixture.modelCalls).toHaveLength(0);
  });

  it("does not qualify real-bucket multi-project workspaces from project-only writes", async () => {
    using fixture = await createFixture();
    await fixture.addMultiProjectWorkspace("ws-task", { bucket: "/projects/demo" });
    const dayAgo = Date.now() - 25 * 60 * 60 * 1000;
    await fixture.metaService.recordAccess(
      memoryLogicalKey("project", "lesson.md", {
        projectPath: "/projects/demo",
        workspaceId: "ws-task",
      }),
      { write: true }
    );

    await fixture.service.runLaunchSweep(new Map([["ws-task", dayAgo]]));

    expect(fixture.modelCalls).toHaveLength(0);
  });

  it("recent legacy workspace-only records do not suppress first project launch coverage", async () => {
    using fixture = await createFixture();
    const recentWorkspaceRunAt = Date.now() - 60_000;
    // Pre-project-memory sidecars only proved workspace/global coverage. Even a
    // project write older than that legacy run still needs one project pass.
    const projectWriteAt = recentWorkspaceRunAt - 1_000;
    await fsPromises.writeFile(
      path.join(fixture.muxHome, "memory-consolidation.json"),
      JSON.stringify({
        workspaces: {
          "ws-dream": {
            lastRunAt: recentWorkspaceRunAt,
            trigger: "manual",
            summary: "pre-project-memory record",
            ops: [],
          },
        },
      })
    );
    const logicalKey = memoryLogicalKey("project", "lesson.md", {
      projectPath: "/projects/demo",
      workspaceId: "ws-dream",
    });
    await fsPromises.writeFile(
      path.join(fixture.muxHome, "memory-meta.json"),
      JSON.stringify({
        entries: {
          [logicalKey]: {
            pinned: false,
            accessCount: 1,
            lastAccessedAt: projectWriteAt,
            lastWriteAt: projectWriteAt,
          },
        },
      })
    );

    await fixture.service.runLaunchSweep(new Map([["ws-dream", Date.now() - 25 * 60 * 60 * 1000]]));

    expect(fixture.modelCalls).toHaveLength(1);
    const raw = JSON.parse(
      await fsPromises.readFile(path.join(fixture.muxHome, "memory-consolidation.json"), "utf-8")
    ) as { projects?: Record<string, unknown> };
    expect(raw.projects?.["/projects/demo"]).toBeDefined();
  });

  it("does not spend the launch cap on candidates skipped by workspace debounce", async () => {
    using fixture = await createFixture();
    const dayAgo = Date.now() - 25 * 60 * 60 * 1000;
    const recentRunAt = Date.now() - MEMORY_CONSOLIDATION_DEBOUNCE_MS + 60_000;
    const debouncedIds = Array.from(
      { length: MEMORY_CONSOLIDATION_LAUNCH_SWEEP_CAP },
      (_, index) => `ws-debounced-${index}`
    );
    const sidecarWorkspaces: Record<string, unknown> = {};
    const recency = new Map<string, number>();

    for (const id of debouncedIds) {
      await fixture.addWorkspace(id);
      sidecarWorkspaces[id] = {
        lastRunAt: recentRunAt,
        trigger: "manual",
        summary: "recent run",
        ops: [],
      };
      await fixture.metaService.recordAccess(
        memoryLogicalKey("workspace", "lesson.md", { projectPath: "", workspaceId: id }),
        { write: true }
      );
      recency.set(id, dayAgo);
    }
    await fixture.addWorkspace("ws-eligible");
    await fixture.metaService.recordAccess(
      memoryLogicalKey("workspace", "lesson.md", { projectPath: "", workspaceId: "ws-eligible" }),
      { write: true }
    );
    recency.set("ws-eligible", dayAgo);
    await fsPromises.writeFile(
      path.join(fixture.muxHome, "memory-consolidation.json"),
      JSON.stringify({ workspaces: sidecarWorkspaces })
    );

    await fixture.service.runLaunchSweep(recency);

    expect(fixture.modelCalls).toHaveLength(1);
    expect((await fixture.service.getRecord("ws-eligible"))?.trigger).toBe("launch");
  });

  it("a global-only write qualifies a single covering run per sweep, not one per workspace", async () => {
    using fixture = await createFixture();
    await fixture.addWorkspace("ws-other");
    const dayAgo = Date.now() - 25 * 60 * 60 * 1000;
    await fixture.metaService.recordAccess("global:lesson.md", { write: true });

    // Both workspaces are idle with no workspace-scope writes; the shared
    // global write needs exactly one covering pass, not duplicate provider
    // calls up to the sweep cap.
    await fixture.service.runLaunchSweep(
      new Map([
        ["ws-dream", dayAgo],
        ["ws-other", dayAgo],
      ])
    );
    expect(fixture.modelCalls).toHaveLength(1);
  });

  it("launch sweep does not re-qualify other workspaces from a global write already covered by a newer run", async () => {
    using fixture = await createFixture();
    await fixture.addWorkspace("ws-other");
    const dayAgo = Date.now() - 25 * 60 * 60 * 1000;
    await fixture.metaService.recordAccess("global:lesson.md", { write: true });

    // First sweep consolidates ws-dream — every run covers global scope.
    await fixture.service.runLaunchSweep(new Map([["ws-dream", dayAgo]]));
    expect(fixture.modelCalls).toHaveLength(1);

    // The same (now covered) global write must not qualify ws-other later;
    // otherwise each run's own global writes re-qualify every other idle
    // workspace in an endless multi-launch feedback loop.
    await fixture.service.runLaunchSweep(new Map([["ws-other", dayAgo]]));
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
