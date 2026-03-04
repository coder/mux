import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { EventEmitter } from "events";

import type {
  FrontendWorkspaceMetadata,
  WorkspaceActivitySnapshot,
} from "@/common/types/workspace";
import { Ok } from "@/common/types/result";
import type { StreamEndEvent } from "@/common/types/stream";

import type { AIService } from "./aiService";
import type { ProjectService } from "./projectService";
import { SectionAssignmentService } from "./sectionAssignmentService";
import type { WorkspaceService } from "./workspaceService";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function makeMetadata(
  overrides: Partial<FrontendWorkspaceMetadata> = {}
): FrontendWorkspaceMetadata {
  return {
    id: "ws-1",
    name: "ws-1",
    projectName: "demo",
    projectPath: "/project/demo",
    runtimeConfig: { type: "local" },
    namedWorkspacePath: "/project/demo/.mux/ws-1",
    ...overrides,
  };
}

function makeActivity(
  overrides: Partial<WorkspaceActivitySnapshot> = {}
): WorkspaceActivitySnapshot {
  return {
    recency: Date.now(),
    streaming: false,
    lastModel: null,
    lastThinkingLevel: null,
    ...overrides,
  };
}

describe("SectionAssignmentService", () => {
  let getInfoMock: ReturnType<typeof mock>;
  let getActivityListMock: ReturnType<typeof mock>;
  let refreshAndEmitMetadataMock: ReturnType<typeof mock>;
  let listWorkspacesMock: ReturnType<typeof mock>;
  let listSectionsMock: ReturnType<typeof mock>;
  let assignWorkspaceToSectionMock: ReturnType<typeof mock>;

  let aiService: AIService;
  let workspaceService: WorkspaceService;
  let projectService: ProjectService;
  let service: SectionAssignmentService;

  beforeEach(() => {
    getInfoMock = mock(() => makeMetadata());
    getActivityListMock = mock(() => ({ "ws-1": makeActivity() }));
    refreshAndEmitMetadataMock = mock(() => undefined);
    listWorkspacesMock = mock(() => [makeMetadata()]);

    listSectionsMock = mock(() => []);
    assignWorkspaceToSectionMock = mock(() => Ok(undefined));

    const aiEmitter = new EventEmitter() as AIService;
    aiService = aiEmitter;

    const workspaceEmitter = new EventEmitter() as WorkspaceService;
    workspaceEmitter.getInfo = getInfoMock as WorkspaceService["getInfo"];
    workspaceEmitter.getActivityList = getActivityListMock as WorkspaceService["getActivityList"];
    workspaceEmitter.refreshAndEmitMetadata =
      refreshAndEmitMetadataMock as WorkspaceService["refreshAndEmitMetadata"];
    workspaceEmitter.list = listWorkspacesMock as WorkspaceService["list"];
    workspaceService = workspaceEmitter;

    projectService = {
      listSections: listSectionsMock,
      assignWorkspaceToSection: assignWorkspaceToSectionMock,
    } as unknown as ProjectService;

    service = new SectionAssignmentService(projectService, workspaceService, aiService);
  });

  afterEach(async () => {
    // Allow any pending debounce timers to flush and avoid cross-test leakage.
    await sleep(350);
  });

  it("auto-assigns an unpinned workspace to the first matching rule", async () => {
    listSectionsMock.mockReturnValueOnce([
      {
        id: "open-pr",
        name: "Open PR",
        rules: [
          {
            conditions: [{ field: "prState", op: "eq", value: "OPEN" }],
          },
        ],
      },
    ]);

    await service.evaluateWorkspace("ws-1", { prState: "OPEN" });

    expect(assignWorkspaceToSectionMock).toHaveBeenCalledTimes(1);
    expect(assignWorkspaceToSectionMock).toHaveBeenCalledWith(
      "/project/demo",
      "ws-1",
      "open-pr",
      false
    );
    expect(refreshAndEmitMetadataMock).toHaveBeenCalledTimes(1);
    expect(refreshAndEmitMetadataMock).toHaveBeenCalledWith("ws-1");
  });

  it("does not move workspaces pinned to their section", async () => {
    getInfoMock.mockResolvedValueOnce(makeMetadata({ sectionId: "manual", pinnedToSection: true }));

    listSectionsMock.mockReturnValueOnce([
      {
        id: "open-pr",
        name: "Open PR",
        rules: [
          {
            conditions: [{ field: "prState", op: "eq", value: "OPEN" }],
          },
        ],
      },
    ]);

    await service.evaluateWorkspace("ws-1", { prState: "OPEN" });

    expect(listSectionsMock).not.toHaveBeenCalled();
    expect(assignWorkspaceToSectionMock).not.toHaveBeenCalled();
    expect(refreshAndEmitMetadataMock).not.toHaveBeenCalled();
  });

  it("preserves current frontend-only section when reevaluating without frontend context", async () => {
    getInfoMock.mockResolvedValueOnce(makeMetadata({ sectionId: "open-pr" }));

    listSectionsMock.mockReturnValueOnce([
      {
        id: "open-pr",
        name: "Open PR",
        rules: [
          {
            conditions: [{ field: "prState", op: "eq", value: "OPEN" }],
          },
        ],
      },
      {
        id: "streaming",
        name: "Streaming",
        rules: [
          {
            conditions: [{ field: "streaming", op: "eq", value: true }],
          },
        ],
      },
    ]);

    await service.evaluateWorkspace("ws-1");

    expect(getActivityListMock).not.toHaveBeenCalled();
    expect(assignWorkspaceToSectionMock).not.toHaveBeenCalled();
    expect(refreshAndEmitMetadataMock).not.toHaveBeenCalled();
  });

  it("skips frontend-only sections when frontend context is unavailable", async () => {
    listSectionsMock.mockReturnValueOnce([
      {
        id: "not-open-pr",
        name: "Not Open PR",
        rules: [
          {
            conditions: [{ field: "prState", op: "neq", value: "OPEN" }],
          },
        ],
      },
      {
        id: "non-streaming",
        name: "Non-streaming",
        rules: [
          {
            conditions: [{ field: "streaming", op: "eq", value: false }],
          },
        ],
      },
    ]);

    await service.evaluateWorkspace("ws-1");

    expect(assignWorkspaceToSectionMock).toHaveBeenCalledTimes(1);
    expect(assignWorkspaceToSectionMock).toHaveBeenCalledWith(
      "/project/demo",
      "ws-1",
      "non-streaming",
      false
    );
    expect(refreshAndEmitMetadataMock).toHaveBeenCalledTimes(1);
  });

  it("re-evaluates only workspaces from the requested project", async () => {
    listWorkspacesMock.mockResolvedValueOnce([
      makeMetadata({ id: "ws-1", projectPath: "/project/demo" }),
      makeMetadata({ id: "ws-2", projectPath: "/project/other" }),
      makeMetadata({ id: "ws-3", projectPath: "/project/demo" }),
    ]);

    const evaluateWorkspaceSpy = spyOn(service, "evaluateWorkspace").mockResolvedValue(undefined);

    await service.evaluateProject("/project/demo");

    expect(evaluateWorkspaceSpy).toHaveBeenCalledTimes(2);
    expect(evaluateWorkspaceSpy).toHaveBeenNthCalledWith(1, "ws-1");
    expect(evaluateWorkspaceSpy).toHaveBeenNthCalledWith(2, "ws-3");
  });

  it("debounces rapid stream/activity events into a single evaluation", async () => {
    const evaluateWorkspaceSpy = spyOn(service, "evaluateWorkspace").mockResolvedValue(undefined);

    const streamEndEvent: StreamEndEvent = {
      type: "stream-end",
      workspaceId: "ws-1",
      messageId: "message-1",
      metadata: {
        model: "test-model",
      },
      parts: [],
    };
    aiService.emit("stream-end", streamEndEvent);
    aiService.emit("stream-end", streamEndEvent);
    workspaceService.emit("activity", { workspaceId: "ws-1", activity: makeActivity() });

    await sleep(100);
    expect(evaluateWorkspaceSpy).not.toHaveBeenCalled();

    await sleep(300);
    expect(evaluateWorkspaceSpy).toHaveBeenCalledTimes(1);
    expect(evaluateWorkspaceSpy).toHaveBeenCalledWith("ws-1");
  });
});
