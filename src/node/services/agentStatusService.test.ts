import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { EventEmitter } from "events";
import type { ProjectsConfig, ProjectConfig, Workspace } from "@/common/types/project";
import { Ok } from "@/common/types/result";
import { createMuxMessage } from "@/common/types/message";
import type { Config } from "@/node/config";
import type { AIService } from "./aiService";
import type { ExtensionMetadataService } from "./ExtensionMetadataService";
import type { WindowService } from "./windowService";
import type { WorkspaceService } from "./workspaceService";
import type { TokenizerService } from "./tokenizerService";
import { AgentStatusService } from "./agentStatusService";
import * as workspaceStatusGenerator from "./workspaceStatusGenerator";
import { createTestHistoryService } from "./testHistoryService";

interface AgentStatusServiceInternals {
  tick(): void;
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
  let setAiStatusMock: ReturnType<
    typeof mock<
      (workspaceId: string, status: unknown, hash: string | null) => Promise<{ recency: number }>
    >
  >;
  let emitWorkspaceActivityMock: ReturnType<
    typeof mock<(workspaceId: string, snapshot: unknown) => void>
  >;
  let getAiStatusInputHashMock: ReturnType<
    typeof mock<(workspaceId: string) => Promise<string | null>>
  >;
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

  // Driver: instantiate the service with a controllable clock and synchronously
  // run a tick. We intentionally bypass the scheduler timers so each test step
  // is deterministic.
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
        startupDelayMs: 0,
        // Use a very large tick interval so setInterval doesn't fire while
        // the test is running; we drive ticks manually via getInternals().
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
    mockWorkspaceService = {
      getWorkspaceTitleModelCandidates: mock(() => Promise.resolve(["anthropic:claude-haiku-4-5"])),
      emitWorkspaceActivity: emitWorkspaceActivityMock,
    } as unknown as WorkspaceService;

    setAiStatusMock = mock((_workspaceId: string, _status: unknown, _hash: string | null) =>
      Promise.resolve({ recency: 0 })
    );
    getAiStatusInputHashMock = mock(() => Promise.resolve(null));
    mockExtensionMetadata = {
      setAiStatus: setAiStatusMock,
      getAiStatusInputHash: getAiStatusInputHashMock,
    } as unknown as ExtensionMetadataService;

    mockTokenizer = {
      // Cheap deterministic tokenizer: 1 token per 4 chars. Avoids spinning up
      // the real worker pool for each test.
      countTokensBatch: mock((_model: string, texts: string[]) =>
        Promise.resolve(texts.map((t) => Math.ceil(t.length / 4)))
      ),
    } as unknown as TokenizerService;

    mockAiService = {} as unknown as AIService;

    windowService = new EventEmitter() as unknown as WindowService;
    (windowService as unknown as { isFocused: () => boolean }).isFocused = () => true;

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

  test("generates a fresh AI status when chat history exists and persists the input hash", async () => {
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

    expect(setAiStatusMock).toHaveBeenCalledTimes(1);
    const updateCall = setAiStatusMock.mock.calls[0];
    expect(updateCall[0]).toBe(workspaceId);
    expect(updateCall[1]).toEqual({ emoji: "🛠️", message: "Editing source" });
    // The hash is persisted so subsequent runs can dedup against it.
    expect(typeof updateCall[2]).toBe("string");
    expect(updateCall[2]!.length).toBeGreaterThan(0);
  });

  test("skips regeneration when the trailing transcript is unchanged (dedup)", async () => {
    await historyHandle.historyService.appendToHistory(
      workspaceId,
      createMuxMessage("u1", "user", "Idle workspace")
    );

    const service = createService();
    await getInternals(service).runForWorkspace(workspaceId);
    expect(generateSpy).toHaveBeenCalledTimes(1);
    expect(setAiStatusMock).toHaveBeenCalledTimes(1);

    // Second pass: history hasn't changed, so the input hash matches and we
    // must not call the model again. This is the "frozen chat" behavior the
    // user explicitly asked for.
    await getInternals(service).runForWorkspace(workspaceId);
    expect(generateSpy).toHaveBeenCalledTimes(1);
    expect(setAiStatusMock).toHaveBeenCalledTimes(1);
  });

  test("includes the in-flight partial assistant message so the hash refreshes mid-stream", async () => {
    // During an active stream the assistant's text/tool activity lives in
    // partial.json before being committed to chat.jsonl. If buildTrailing-
    // Transcript only saw committed messages, the hash would stay constant
    // for the entire stream, defeating the whole point of the feature
    // (showing what the agent is doing *right now*).
    await historyHandle.historyService.appendToHistory(
      workspaceId,
      createMuxMessage("u1", "user", "kick off a long task")
    );

    const service = createService();
    await getInternals(service).runForWorkspace(workspaceId);
    expect(generateSpy).toHaveBeenCalledTimes(1);
    const initialHash = setAiStatusMock.mock.calls[0][2];
    expect(typeof initialHash).toBe("string");

    // Stage a partial assistant message — same shape the streaming pipeline
    // writes via writePartial. The runForWorkspace tick should now see this
    // text in the transcript and regenerate.
    const partial = createMuxMessage("a-partial", "assistant", "Reading config files");
    await historyHandle.historyService.writePartial(workspaceId, partial);

    await getInternals(service).runForWorkspace(workspaceId);
    expect(generateSpy).toHaveBeenCalledTimes(2);
    const transcriptArg = generateSpy.mock.calls[1][0];
    expect(transcriptArg).toContain("Assistant: Reading config files");
    const newHash = setAiStatusMock.mock.calls[1][2];
    expect(newHash).not.toBe(initialHash);
  });

  test("re-generates after the trailing transcript changes", async () => {
    await historyHandle.historyService.appendToHistory(
      workspaceId,
      createMuxMessage("u1", "user", "Initial request")
    );
    const service = createService();
    await getInternals(service).runForWorkspace(workspaceId);
    expect(generateSpy).toHaveBeenCalledTimes(1);

    // New user turn changes the trailing window — hash must differ and we
    // must regenerate.
    await historyHandle.historyService.appendToHistory(
      workspaceId,
      createMuxMessage("u2", "user", "Second request")
    );
    await getInternals(service).runForWorkspace(workspaceId);
    expect(generateSpy).toHaveBeenCalledTimes(2);
    expect(setAiStatusMock).toHaveBeenCalledTimes(2);
  });

  test("skips regeneration when there is no chat history yet", async () => {
    const service = createService();
    await getInternals(service).runForWorkspace(workspaceId);

    // Empty workspaces have nothing to summarize. We must not pay for an LLM
    // call producing a hallucinated status, and we must not blank an
    // existing aiStatus on disk.
    expect(generateSpy).not.toHaveBeenCalled();
    expect(setAiStatusMock).not.toHaveBeenCalled();
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

    // First tick (focused) generates immediately. Mutate history afterwards
    // so the dedup hash differs on subsequent ticks — otherwise this test
    // would fail for the wrong reason.
    (windowService as unknown as { isFocused: () => boolean }).isFocused = () => true;
    await internals.runTick();
    await historyHandle.historyService.appendToHistory(
      workspaceId,
      createMuxMessage("u2", "user", "follow-up A")
    );

    expect(generateSpy).toHaveBeenCalledTimes(1);

    // Advance time by less than the focused interval. The scheduler must
    // skip this workspace.
    now += 5_000;
    await internals.runTick();
    expect(generateSpy).toHaveBeenCalledTimes(1);

    // Advance past the focused interval; another generation should fire.
    now += 30_000;
    await internals.runTick();
    expect(generateSpy).toHaveBeenCalledTimes(2);

    // Now go unfocused. Even after the focused interval elapses, the
    // unfocused interval is longer (2 minutes) and we should not regenerate
    // until that boundary. Advance another 60s (well past focused, well
    // short of unfocused).
    (windowService as unknown as { isFocused: () => boolean }).isFocused = () => false;
    await historyHandle.historyService.appendToHistory(
      workspaceId,
      createMuxMessage("u3", "user", "follow-up B")
    );
    now += 60_000;
    await internals.runTick();
    expect(generateSpy).toHaveBeenCalledTimes(2);

    // Past the unfocused interval — should regenerate.
    now += 120_000;
    await internals.runTick();
    expect(generateSpy).toHaveBeenCalledTimes(3);
  });

  test("round-robins across multiple workspaces so none starve under MAX_CONCURRENT=1", async () => {
    // With MAX_CONCURRENT=1 and a fixed iteration order, the first workspace
    // would always become re-eligible before later ones got their turn —
    // workspaces 4+ would never produce a status. The scheduler must
    // prioritize least-recently-run workspaces so each one gets fair
    // attention even when many are eligible at the same time.
    const projectPathLocal = "/test/round-robin-project";
    const wsA: Workspace = {
      id: "ws-a",
      name: "ws-a",
      path: "/test/path/a",
    } as unknown as Workspace;
    const wsB: Workspace = {
      id: "ws-b",
      name: "ws-b",
      path: "/test/path/b",
    } as unknown as Workspace;
    const wsC: Workspace = {
      id: "ws-c",
      name: "ws-c",
      path: "/test/path/c",
    } as unknown as Workspace;
    projectsConfig = {
      projects: new Map<string, ProjectConfig>([
        [projectPathLocal, { workspaces: [wsA, wsB, wsC] } as unknown as ProjectConfig],
      ]),
    };
    for (const id of ["ws-a", "ws-b", "ws-c"]) {
      await historyHandle.historyService.appendToHistory(
        id,
        createMuxMessage(`u1-${id}`, "user", `prompt for ${id}`)
      );
    }

    let now = 1_000_000;
    const service = createService({ clock: () => now });
    const internals = getInternals(service);

    // Tick 1 → first workspace runs.
    await internals.runTick();
    expect(generateSpy).toHaveBeenCalledTimes(1);
    const firstRunWorkspaceIds = setAiStatusMock.mock.calls.map((call) => call[0]);

    // Advance just past one focused interval so all three are eligible. The
    // scheduler must pick a workspace that hasn't run yet (lastRanAt=0)
    // before re-running the workspace that just ran.
    now += 31_000;
    await internals.runTick();
    expect(generateSpy).toHaveBeenCalledTimes(2);
    const idsAfterTick2 = setAiStatusMock.mock.calls.map((call) => call[0]);
    expect(new Set(idsAfterTick2).size).toBe(2);

    // One more tick should cover the third workspace before any repeats.
    now += 31_000;
    await internals.runTick();
    expect(generateSpy).toHaveBeenCalledTimes(3);
    const idsAfterTick3 = setAiStatusMock.mock.calls.map((call) => call[0]);
    expect(new Set(idsAfterTick3)).toEqual(new Set(["ws-a", "ws-b", "ws-c"]));

    // Use the variable to satisfy lint / show intent: every workspace was
    // covered at least once.
    expect(firstRunWorkspaceIds.length).toBeGreaterThan(0);
  });

  test("a failed persistence write does not update the dedup hash, so the next tick retries", async () => {
    // Codex review: emitWorkspaceActivityUpdate (the historical wrapper) used
    // to swallow disk errors, which meant a transient extensionMetadata.json
    // write failure could leave the in-memory hash advanced even though the
    // generated status never made it to disk or the frontend. After that,
    // the next tick would dedup against the new hash and never retry.
    // The fix is: only update lastInputHash AFTER a successful persist.
    await historyHandle.historyService.appendToHistory(
      workspaceId,
      createMuxMessage("u1", "user", "kick off a task")
    );

    setAiStatusMock.mockImplementationOnce(() => Promise.reject(new Error("disk full")));

    const service = createService();
    await getInternals(service).runForWorkspace(workspaceId);

    expect(generateSpy).toHaveBeenCalledTimes(1);
    // setAiStatus was attempted but failed.
    expect(setAiStatusMock).toHaveBeenCalledTimes(1);
    // Activity emit must NOT happen on persist failure — frontend must not
    // see a status the disk doesn't actually have.
    expect(emitWorkspaceActivityMock).not.toHaveBeenCalled();

    // The next runForWorkspace pass on the SAME transcript must retry,
    // because the previous failure should have left lastInputHash null.
    setAiStatusMock.mockImplementation((_w, _s, _h) => Promise.resolve({ recency: 0 }));
    await getInternals(service).runForWorkspace(workspaceId);
    expect(generateSpy).toHaveBeenCalledTimes(2);
    expect(setAiStatusMock).toHaveBeenCalledTimes(2);
    expect(emitWorkspaceActivityMock).toHaveBeenCalledTimes(1);
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
    expect(setAiStatusMock).not.toHaveBeenCalled();
  });
});
