import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { ProjectsConfig, ProjectConfig, Workspace } from "@/common/types/project";
import { Ok } from "@/common/types/result";
import { createMuxMessage } from "@/common/types/message";
import type { Config } from "@/node/config";
import type { AIService } from "./aiService";
import { ExtensionMetadataService } from "./ExtensionMetadataService";
import type { WindowService } from "./windowService";
import type { WorkspaceService } from "./workspaceService";
import type { TokenizerService } from "./tokenizerService";
import { AgentStatusService } from "./agentStatusService";
import * as workspaceStatusGenerator from "./workspaceStatusGenerator";
import { createTestHistoryService } from "./testHistoryService";

interface AgentStatusServiceInternals {
  runTick(): Promise<void>;
  runForWorkspace(workspaceId: string): Promise<void>;
}

describe("AgentStatusService", () => {
  const workspaceId = "ws-test";
  const projectPath = "/test/project";

  let historyHandle: Awaited<ReturnType<typeof createTestHistoryService>>;
  let projectsConfig: ProjectsConfig;
  let mockConfig: Config;
  let mockExtensionMetadata: ExtensionMetadataService;
  let mockWorkspaceService: WorkspaceService;
  let mockTokenizer: TokenizerService;
  let mockAiService: AIService;
  let windowService: WindowService;
  let isFocused = true;
  let setSidebarStatusMock: ReturnType<
    typeof mock<(workspaceId: string, status: unknown) => Promise<{ recency: number }>>
  >;
  let emitWorkspaceActivityMock: ReturnType<
    typeof mock<(workspaceId: string, snapshot: unknown) => void>
  >;
  let getCandidatesMock: ReturnType<typeof mock<(workspaceId: string) => Promise<string[]>>>;
  let generateSpy: ReturnType<
    typeof spyOn<typeof workspaceStatusGenerator, "generateWorkspaceStatus">
  >;

  function makeWorkspaceEntry(overrides: Partial<Workspace> = {}): Workspace {
    return {
      id: workspaceId,
      name: workspaceId,
      path: "/test/path",
      ...overrides,
    } as unknown as Workspace;
  }

  function makeProjectsConfig(workspaces: Workspace[]): ProjectsConfig {
    return {
      projects: new Map<string, ProjectConfig>([
        [projectPath, { workspaces } as unknown as ProjectConfig],
      ]),
    };
  }

  // Bypass the scheduler timers so each test step is deterministic.
  function createService(options?: { clock?: () => number }): AgentStatusService {
    return new AgentStatusService(
      mockConfig,
      historyHandle.historyService,
      mockTokenizer,
      mockExtensionMetadata,
      mockWorkspaceService,
      windowService,
      mockAiService,
      {
        clock: options?.clock,
        tickIntervalMs: 60 * 60 * 1000,
      }
    );
  }

  function getInternals(service: AgentStatusService): AgentStatusServiceInternals {
    return service as unknown as AgentStatusServiceInternals;
  }

  beforeEach(async () => {
    historyHandle = await createTestHistoryService();
    projectsConfig = makeProjectsConfig([makeWorkspaceEntry()]);

    mockConfig = {
      loadConfigOrDefault: mock(() => projectsConfig),
      getSessionDir: historyHandle.config.getSessionDir.bind(historyHandle.config),
    } as unknown as Config;

    emitWorkspaceActivityMock = mock(() => undefined);
    getCandidatesMock = mock((_id: string) => Promise.resolve(["anthropic:claude-haiku-4-5"]));
    mockWorkspaceService = {
      getWorkspaceTitleModelCandidates: getCandidatesMock,
      emitWorkspaceActivity: emitWorkspaceActivityMock,
    } as unknown as WorkspaceService;

    setSidebarStatusMock = mock((_workspaceId: string, _status: unknown) =>
      Promise.resolve({ recency: 0 })
    );
    mockExtensionMetadata = {
      setSidebarStatus: setSidebarStatusMock,
    } as unknown as ExtensionMetadataService;

    mockTokenizer = {
      // Cheap deterministic tokenizer (~1 token per 4 chars).
      countTokensBatch: mock((_model: string, texts: string[]) =>
        Promise.resolve(texts.map((t) => Math.ceil(t.length / 4)))
      ),
    } as unknown as TokenizerService;

    mockAiService = {} as unknown as AIService;

    isFocused = true;
    windowService = { isFocused: () => isFocused } as unknown as WindowService;

    generateSpy = spyOn(workspaceStatusGenerator, "generateWorkspaceStatus").mockResolvedValue(
      Ok({
        status: { emoji: "🛠️", message: "Editing source" },
        modelUsed: "anthropic:claude-haiku-4-5",
      })
    );
  });

  afterEach(async () => {
    generateSpy.mockRestore();
    await historyHandle.cleanup();
  });

  test("generates and persists a fresh AI status when chat history exists", async () => {
    await historyHandle.historyService.appendToHistory(
      workspaceId,
      createMuxMessage("u1", "user", "Please run the test suite")
    );
    await historyHandle.historyService.appendToHistory(
      workspaceId,
      createMuxMessage("a1", "assistant", "Running tests now")
    );

    const service = createService();
    await getInternals(service).runForWorkspace(workspaceId);

    expect(generateSpy).toHaveBeenCalledTimes(1);
    const generationCall = generateSpy.mock.calls[0];
    expect(generationCall[0]).toContain("User: Please run the test suite");
    expect(generationCall[0]).toContain("Assistant: Running tests now");
    expect(generationCall[1]).toEqual(["anthropic:claude-haiku-4-5"]);

    expect(setSidebarStatusMock).toHaveBeenCalledTimes(1);
    const [persistedWorkspaceId, persistedStatus] = setSidebarStatusMock.mock.calls[0];
    expect(persistedWorkspaceId).toBe(workspaceId);
    expect(persistedStatus).toEqual({ emoji: "🛠️", message: "Editing source" });
  });

  test("skips regeneration when the trailing transcript is unchanged (dedup)", async () => {
    // "Frozen chat" behavior: identical hash → no further LLM calls.
    await historyHandle.historyService.appendToHistory(
      workspaceId,
      createMuxMessage("u1", "user", "Idle workspace")
    );

    const service = createService();
    await getInternals(service).runForWorkspace(workspaceId);
    expect(generateSpy).toHaveBeenCalledTimes(1);
    expect(setSidebarStatusMock).toHaveBeenCalledTimes(1);

    await getInternals(service).runForWorkspace(workspaceId);
    expect(generateSpy).toHaveBeenCalledTimes(1);
    expect(setSidebarStatusMock).toHaveBeenCalledTimes(1);
  });

  test("includes the in-flight partial assistant message so the hash refreshes mid-stream", async () => {
    // The assistant's mid-stream output lives in partial.json before being
    // committed to chat.jsonl. If buildTrailingTranscript ignored partials,
    // the hash would stay constant during long streams and dedup would
    // suppress the very updates the feature exists to surface.
    await historyHandle.historyService.appendToHistory(
      workspaceId,
      createMuxMessage("u1", "user", "kick off a long task")
    );

    const service = createService();
    await getInternals(service).runForWorkspace(workspaceId);
    expect(generateSpy).toHaveBeenCalledTimes(1);

    const partial = createMuxMessage("a-partial", "assistant", "Reading config files");
    await historyHandle.historyService.writePartial(workspaceId, partial);

    // Dedup would have suppressed this second call if the partial was missing
    // from the trailing window.
    await getInternals(service).runForWorkspace(workspaceId);
    expect(generateSpy).toHaveBeenCalledTimes(2);
    expect(generateSpy.mock.calls[1][0]).toContain("Assistant: Reading config files");
  });

  test("re-generates after the trailing transcript changes", async () => {
    await historyHandle.historyService.appendToHistory(
      workspaceId,
      createMuxMessage("u1", "user", "Initial request")
    );
    const service = createService();
    await getInternals(service).runForWorkspace(workspaceId);
    expect(generateSpy).toHaveBeenCalledTimes(1);

    await historyHandle.historyService.appendToHistory(
      workspaceId,
      createMuxMessage("u2", "user", "Second request")
    );
    await getInternals(service).runForWorkspace(workspaceId);
    expect(generateSpy).toHaveBeenCalledTimes(2);
    expect(setSidebarStatusMock).toHaveBeenCalledTimes(2);
  });

  test("skips regeneration when there is no chat history yet", async () => {
    // Empty workspaces have nothing to summarize. Don't pay for a
    // hallucinated status, and don't blank an existing todoStatus on disk.
    const service = createService();
    await getInternals(service).runForWorkspace(workspaceId);
    expect(generateSpy).not.toHaveBeenCalled();
    expect(setSidebarStatusMock).not.toHaveBeenCalled();
  });

  test("focused windows regenerate at the focused interval; unfocused windows wait longer", async () => {
    await historyHandle.historyService.appendToHistory(
      workspaceId,
      createMuxMessage("u1", "user", "Hello")
    );
    await historyHandle.historyService.appendToHistory(
      workspaceId,
      createMuxMessage("a1", "assistant", "Hi")
    );

    let now = 1_000_000;
    const service = createService({ clock: () => now });
    const internals = getInternals(service);

    // First focused tick generates. We mutate history between ticks so the
    // dedup hash differs — otherwise this test would pass for the wrong
    // reason.
    isFocused = true;
    await internals.runTick();
    await historyHandle.historyService.appendToHistory(
      workspaceId,
      createMuxMessage("u2", "user", "follow-up A")
    );
    expect(generateSpy).toHaveBeenCalledTimes(1);

    // Inside the focused interval: skipped.
    now += 5_000;
    await internals.runTick();
    expect(generateSpy).toHaveBeenCalledTimes(1);

    // Past the focused interval: regenerates.
    now += 30_000;
    await internals.runTick();
    expect(generateSpy).toHaveBeenCalledTimes(2);

    // Unfocused: 60s elapsed is past focused but short of the unfocused
    // interval (2 minutes), so the scheduler must wait.
    isFocused = false;
    await historyHandle.historyService.appendToHistory(
      workspaceId,
      createMuxMessage("u3", "user", "follow-up B")
    );
    now += 60_000;
    await internals.runTick();
    expect(generateSpy).toHaveBeenCalledTimes(2);

    // Past the unfocused interval: regenerates.
    now += 120_000;
    await internals.runTick();
    expect(generateSpy).toHaveBeenCalledTimes(3);
  });

  test("round-robins across multiple workspaces so none starve under MAX_CONCURRENT=1", async () => {
    // With MAX_CONCURRENT=1 and a fixed iteration order, the first workspace
    // would always become re-eligible before later ones got a turn. The
    // scheduler must prioritize least-recently-run workspaces.
    const projectPathLocal = "/test/round-robin-project";
    const ids = ["ws-a", "ws-b", "ws-c"];
    const workspaces = ids.map(
      (id) => ({ id, name: id, path: `/test/path/${id}` }) as unknown as Workspace
    );
    projectsConfig = {
      projects: new Map<string, ProjectConfig>([
        [projectPathLocal, { workspaces } as unknown as ProjectConfig],
      ]),
    };
    for (const id of ids) {
      await historyHandle.historyService.appendToHistory(
        id,
        createMuxMessage(`u1-${id}`, "user", `prompt for ${id}`)
      );
    }

    let now = 1_000_000;
    const service = createService({ clock: () => now });
    const internals = getInternals(service);

    // Tick 1 covers one workspace; ticks 2 and 3 each cover a distinct
    // never-run workspace before any repeat (least-recently-run wins).
    await internals.runTick();
    expect(generateSpy).toHaveBeenCalledTimes(1);
    now += 31_000;
    await internals.runTick();
    expect(generateSpy).toHaveBeenCalledTimes(2);
    now += 31_000;
    await internals.runTick();
    expect(generateSpy).toHaveBeenCalledTimes(3);
    const persistedIds = setSidebarStatusMock.mock.calls.map((call) => call[0]);
    expect(new Set(persistedIds)).toEqual(new Set(ids));
  });

  test("does not invoke the generator if stopped during transcript build or candidates fetch", async () => {
    // Earlier awaits (history read, candidates fetch) are also yield points.
    // If stop() fires during one of them, kicking off the multi-second
    // provider call afterwards would leak LLM work past the service's
    // declared lifecycle.
    await historyHandle.historyService.appendToHistory(
      workspaceId,
      createMuxMessage("u1", "user", "long-running task")
    );

    let releaseCandidates!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseCandidates = resolve;
    });
    getCandidatesMock.mockImplementationOnce(async () => {
      await gate;
      return ["anthropic:claude-haiku-4-5"];
    });

    const service = createService();
    const inFlight = getInternals(service).runForWorkspace(workspaceId);
    service.stop();
    releaseCandidates();
    await inFlight;

    expect(generateSpy).not.toHaveBeenCalled();
    expect(setSidebarStatusMock).not.toHaveBeenCalled();
    expect(emitWorkspaceActivityMock).not.toHaveBeenCalled();
  });

  test("does not persist or emit if the service is stopped while a generation is in flight", async () => {
    // Real provider calls can take seconds to minutes. If stop() fires
    // mid-generation (app shutdown), persisting afterwards would leak writes
    // past the declared lifecycle.
    await historyHandle.historyService.appendToHistory(
      workspaceId,
      createMuxMessage("u1", "user", "long-running task")
    );

    // Two-stage gate: signal when the generator actually starts (so the
    // test can fire stop() after the pre-generator guard has passed) and
    // a release the test holds until it's ready for the generator to
    // resolve.
    let signalStarted!: () => void;
    const startedSignal = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    let releaseGenerate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGenerate = resolve;
    });
    generateSpy.mockImplementationOnce(async () => {
      signalStarted();
      await gate;
      return Ok({
        status: { emoji: "🛠️", message: "Doing work" },
        modelUsed: "anthropic:claude-haiku-4-5",
      });
    });

    const service = createService();
    const inFlight = getInternals(service).runForWorkspace(workspaceId);
    await startedSignal;
    service.stop();
    releaseGenerate();
    await inFlight;

    expect(generateSpy).toHaveBeenCalledTimes(1);
    expect(setSidebarStatusMock).not.toHaveBeenCalled();
    expect(emitWorkspaceActivityMock).not.toHaveBeenCalled();
  });

  test("a failed persistence write does not update the dedup hash, so the next tick retries", async () => {
    // Only update lastInputHash AFTER a successful persist. Otherwise a
    // transient I/O failure would leave us dedup'ing against a hash that
    // never made it to disk, silently dropping subsequent retries.
    await historyHandle.historyService.appendToHistory(
      workspaceId,
      createMuxMessage("u1", "user", "kick off a task")
    );

    setSidebarStatusMock.mockImplementationOnce(() => Promise.reject(new Error("disk full")));

    const service = createService();
    await getInternals(service).runForWorkspace(workspaceId);

    expect(generateSpy).toHaveBeenCalledTimes(1);
    expect(setSidebarStatusMock).toHaveBeenCalledTimes(1);
    // Activity must not emit on persist failure.
    expect(emitWorkspaceActivityMock).not.toHaveBeenCalled();

    // Same transcript, second pass: retries because the previous failure
    // left lastInputHash unchanged.
    setSidebarStatusMock.mockImplementation((_w, _s) => Promise.resolve({ recency: 0 }));
    await getInternals(service).runForWorkspace(workspaceId);
    expect(generateSpy).toHaveBeenCalledTimes(2);
    expect(setSidebarStatusMock).toHaveBeenCalledTimes(2);
    expect(emitWorkspaceActivityMock).toHaveBeenCalledTimes(1);
  });

  test("setSidebarStatus must not bump workspace recency (would re-sort idle workspaces)", async () => {
    // AgentStatusService is a background scheduler with no causal
    // connection to user activity, so its writes must not bump recency —
    // that would promote idle workspaces in the sidebar and mark them
    // unread every tick. Test ExtensionMetadataService directly to pin the
    // contract for any future caller of setSidebarStatus.
    const dir = mkdtempSync(join(tmpdir(), "mux-recency-"));
    try {
      const svc = new ExtensionMetadataService(join(dir, "metadata.json"));
      await svc.updateRecency("ws", 100);
      await svc.setSidebarStatus("ws", { emoji: "🛠️", message: "Doing work" });
      const after = await svc.getSnapshot("ws");
      expect(after?.recency).toBe(100);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("archived workspaces are not regenerated", async () => {
    projectsConfig = makeProjectsConfig([
      makeWorkspaceEntry({ archivedAt: new Date().toISOString() } as Partial<Workspace>),
    ]);
    await historyHandle.historyService.appendToHistory(
      workspaceId,
      createMuxMessage("u1", "user", "Archived chat")
    );

    const service = createService();
    await getInternals(service).runTick();

    expect(generateSpy).not.toHaveBeenCalled();
    expect(setSidebarStatusMock).not.toHaveBeenCalled();
  });
});
