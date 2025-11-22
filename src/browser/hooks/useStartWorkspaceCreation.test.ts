import { describe, expect, test } from "bun:test";
import {
  getFirstProjectPath,
  normalizeRuntimePreference,
  persistWorkspaceCreationPrefill,
  type StartWorkspaceCreationDetail,
} from "./useStartWorkspaceCreation";
import {
  getInputKey,
  getModelKey,
  getPendingScopeId,
  getProjectScopeId,
  getRuntimeKey,
  getTrunkBranchKey,
} from "@/common/constants/storage";
import type { ProjectConfig } from "@/node/config";

import type { updatePersistedState } from "@/browser/hooks/usePersistedState";

type PersistFn = typeof updatePersistedState;
type PersistCall = [string, unknown, unknown?];

describe("normalizeRuntimePreference", () => {
  test("returns undefined for empty or worktree runtime", () => {
    expect(normalizeRuntimePreference(undefined)).toBeUndefined();
    expect(normalizeRuntimePreference(" ")).toBeUndefined();
    expect(normalizeRuntimePreference("worktree")).toBeUndefined();
    expect(normalizeRuntimePreference("WORKTREE")).toBeUndefined();
  });

  test("normalizes local runtime tokens", () => {
    expect(normalizeRuntimePreference("local")).toBe("local");
    expect(normalizeRuntimePreference("LOCAL")).toBe("local");
    expect(normalizeRuntimePreference(" local-in-place ")).toBe("local");
  });

  test("normalizes ssh runtimes", () => {
    expect(normalizeRuntimePreference("ssh")).toBe("ssh");
    expect(normalizeRuntimePreference("ssh host")).toBe("ssh host");
    expect(normalizeRuntimePreference("SSH user@host")).toBe("ssh user@host");
  });

  test("returns trimmed custom runtime", () => {
    expect(normalizeRuntimePreference(" custom-runtime ")).toBe("custom-runtime");
  });
});

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
      runtime: " ssh dev ",
    };
    const { persist, calls } = createPersistSpy();

    persistWorkspaceCreationPrefill(projectPath, detail, persist);

    const callMap = new Map<string, unknown>();
    for (const [key, value] of calls) {
      callMap.set(key, value);
    }

    expect(callMap.get(getInputKey(getPendingScopeId(projectPath)))).toBe("Ship it");
    expect(callMap.get(getModelKey(getProjectScopeId(projectPath)))).toBe("provider/model");
    expect(callMap.get(getTrunkBranchKey(projectPath))).toBe("main");
    expect(callMap.get(getRuntimeKey(projectPath))).toBe("ssh dev");
  });

  test("clears persisted values when empty strings are provided", () => {
    const detail: StartWorkspaceCreationDetail = {
      projectPath,
      trunkBranch: "   ",
      runtime: "  ",
    };
    const { persist, calls } = createPersistSpy();

    persistWorkspaceCreationPrefill(projectPath, detail, persist);

    const callMap = new Map<string, unknown>();
    for (const [key, value] of calls) {
      callMap.set(key, value);
    }

    expect(callMap.get(getTrunkBranchKey(projectPath))).toBeUndefined();
    expect(callMap.get(getRuntimeKey(projectPath))).toBeUndefined();
  });

  test("no-op when detail is undefined", () => {
    const { persist, calls } = createPersistSpy();
    persistWorkspaceCreationPrefill(projectPath, undefined, persist);
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
