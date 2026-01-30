import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";
import {
  getFirstProjectPath,
  persistWorkspaceCreationPrefill,
  type StartWorkspaceCreationDetail,
  useStartWorkspaceCreation,
} from "./useStartWorkspaceCreation";
import {
  getDraftScopeId,
  getInputKey,
  getModelKey,
  getPendingScopeId,
  getProjectScopeId,
  getTrunkBranchKey,
} from "@/common/constants/storage";
import type { ProjectConfig } from "@/node/config";

import { readPersistedState, type updatePersistedState } from "@/browser/hooks/usePersistedState";

type PersistFn = typeof updatePersistedState;
type PersistCall = [string, unknown, unknown?];

describe("persistWorkspaceCreationPrefill", () => {
  const projectPath = "/tmp/project";

  function createPersistSpy() {
    const calls: PersistCall[] = [];
    const persist: PersistFn = ((...args: PersistCall) => {
      calls.push(args);
    }) as PersistFn;

    return { persist, calls };
  }

  test("writes provided values and normalizes whitespace", () => {
    const detail: StartWorkspaceCreationDetail = {
      projectPath,
      startMessage: "Ship it",
      model: "provider/model",
      trunkBranch: " main ",
      runtime: " ssh dev ", // runtime is NOT persisted - it's a one-time override
    };
    const { persist, calls } = createPersistSpy();

    persistWorkspaceCreationPrefill(projectPath, detail, { persist });

    const callMap = new Map<string, unknown>();
    for (const [key, value] of calls) {
      callMap.set(key, value);
    }

    expect(callMap.get(getInputKey(getPendingScopeId(projectPath)))).toBe("Ship it");
    expect(callMap.get(getModelKey(getProjectScopeId(projectPath)))).toBe("provider/model");
    expect(callMap.get(getTrunkBranchKey(projectPath))).toBe("main");
    // runtime is intentionally not persisted - default can only be changed via icon selector
    expect(calls.length).toBe(3);
  });

  test("writes startMessage to draft scope when draftId is provided", () => {
    const detail: StartWorkspaceCreationDetail = {
      projectPath,
      startMessage: "Ship it",
      model: "provider/model",
    };
    const { persist, calls } = createPersistSpy();
    const draftId = "draft_123";

    persistWorkspaceCreationPrefill(projectPath, detail, { persist, draftId });

    const callMap = new Map<string, unknown>();
    for (const [key, value] of calls) {
      callMap.set(key, value);
    }

    expect(callMap.get(getInputKey(getDraftScopeId(projectPath, draftId)))).toBe("Ship it");
    expect(callMap.has(getInputKey(getPendingScopeId(projectPath)))).toBe(false);
  });

  test("clears persisted values when empty strings are provided", () => {
    const detail: StartWorkspaceCreationDetail = {
      projectPath,
      trunkBranch: "   ",
    };
    const { persist, calls } = createPersistSpy();

    persistWorkspaceCreationPrefill(projectPath, detail, { persist });

    const callMap = new Map<string, unknown>();
    for (const [key, value] of calls) {
      callMap.set(key, value);
    }

    expect(callMap.get(getTrunkBranchKey(projectPath))).toBeUndefined();
  });

  test("no-op when detail is undefined", () => {
    const { persist, calls } = createPersistSpy();
    persistWorkspaceCreationPrefill(projectPath, undefined, { persist });
    expect(calls).toHaveLength(0);
  });
});

describe("getFirstProjectPath", () => {
  test("returns first project path or null", () => {
    const emptyProjects = new Map<string, ProjectConfig>();
    expect(getFirstProjectPath(emptyProjects)).toBeNull();

    const projects = new Map<string, ProjectConfig>();
    projects.set("/tmp/a", { path: "/tmp/a", workspaces: [] } as ProjectConfig);
    projects.set("/tmp/b", { path: "/tmp/b", workspaces: [] } as ProjectConfig);

    expect(getFirstProjectPath(projects)).toBe("/tmp/a");
  });
});

describe("useStartWorkspaceCreation", () => {
  beforeEach(() => {
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
  });

  afterEach(() => {
    cleanup();
    globalThis.window = undefined as unknown as Window & typeof globalThis;
    globalThis.document = undefined as unknown as Document;
  });

  test("persists startMessage under the draft scope returned by createWorkspaceDraft", () => {
    const projectPath = "/tmp/project";
    const draftId = "draft_123";

    const projects = new Map<string, ProjectConfig>();
    projects.set(projectPath, { path: projectPath, workspaces: [] } as ProjectConfig);

    const createWorkspaceDraft = mock(() => draftId);

    const { result } = renderHook(() =>
      useStartWorkspaceCreation({ projects, createWorkspaceDraft })
    );

    act(() => {
      result.current(projectPath, { projectPath, startMessage: "Ship it" });
    });

    expect(createWorkspaceDraft).toHaveBeenCalledTimes(1);
    expect(createWorkspaceDraft).toHaveBeenCalledWith(projectPath);

    expect(readPersistedState(getInputKey(getDraftScopeId(projectPath, draftId)), "")).toBe(
      "Ship it"
    );
    expect(readPersistedState(getInputKey(getPendingScopeId(projectPath)), "")).toBe("");
  });
});
