import { describe, expect, test } from "bun:test";

import {
  createUserPreferenceSaveQueue,
  hydrateUserPreferencesLocalCache,
  mergeMissingLocalPreferences,
  overlayDirtyLocalValues,
  prunePreferenceScopes,
} from "./UserPreferencesContext";
import {
  LAUNCH_BEHAVIOR_KEY,
  PROJECT_ORDER_KEY,
  UI_THEME_KEY,
  VIM_ENABLED_KEY,
} from "@/common/constants/storage";
import type { UserPreferences } from "@/common/config/schemas/userPreferences";

class MemoryStorage implements Storage {
  private values = new Map<string, string>();

  get length() {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return Array.from(this.values.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  setJSON(key: string, value: unknown): void {
    this.setItem(key, JSON.stringify(value));
  }
}

async function waitUntil(assertion: () => void): Promise<void> {
  const deadline = Date.now() + 1000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  throw lastError;
}

describe("UserPreferencesProvider bridge helpers", () => {
  test("hydrates backend preferences into the local startup cache", async () => {
    const storage = new MemoryStorage();

    await hydrateUserPreferencesLocalCache({
      storage,
      configClient: {
        getConfig: () =>
          Promise.resolve({
            userPreferences: { navigation: { launchBehavior: "last-workspace" } },
          }),
        saveConfig: () => Promise.resolve(),
      },
    });

    expect(JSON.parse(storage.getItem(LAUNCH_BEHAVIOR_KEY) ?? "null")).toBe("last-workspace");
  });

  test("backfills only local preferences that are missing from backend config", () => {
    const storage = new MemoryStorage();
    storage.setJSON(UI_THEME_KEY, "light");
    storage.setJSON(PROJECT_ORDER_KEY, ["/repo/a", "/repo/b"]);

    expect(
      mergeMissingLocalPreferences(
        {
          appearance: { theme: "dark" },
        },
        storage
      )
    ).toEqual({
      appearance: { theme: "dark" },
      navigation: { projectOrder: ["/repo/a", "/repo/b"] },
    });
  });

  test("overlays dirty local values over a backend refresh", () => {
    const storage = new MemoryStorage();
    storage.setJSON(UI_THEME_KEY, "flexoki-dark");

    expect(
      overlayDirtyLocalValues(
        {
          appearance: { theme: "light", vimEnabled: true },
        },
        [UI_THEME_KEY, VIM_ENABLED_KEY],
        storage
      )
    ).toEqual({
      appearance: { theme: "flexoki-dark" },
    });
  });

  test("prunes project and workspace scoped preferences that no longer exist", () => {
    const projects = new Map([
      ["/repo/a", { workspaces: [] }],
      ["/repo/c", { workspaces: [] }],
    ]);

    expect(
      prunePreferenceScopes({
        preferences: {
          navigation: { projectOrder: ["/repo/b", "/repo/a"] },
          ai: {
            projectDefaults: {
              "/repo/a": { agentId: "exec" },
              "/repo/b": { agentId: "plan" },
            },
          },
          workspaceCreation: {
            byProject: {
              "/repo/b": { trunkBranch: "origin/main" },
            },
          },
          notifications: {
            notifyOnResponseByWorkspace: { "ws-keep": true, "ws-drop": true },
          },
          review: {
            defaultBaseByProject: { "/repo/b": "origin/main" },
          },
        },
        projectPaths: new Set(["/repo/a", "/repo/c"]),
        workspaceIds: new Set(["ws-keep"]),
        userProjects: projects,
      })
    ).toEqual({
      navigation: { projectOrder: ["/repo/c", "/repo/a"] },
      ai: { projectDefaults: { "/repo/a": { agentId: "exec" } } },
      notifications: { notifyOnResponseByWorkspace: { "ws-keep": true } },
    });
  });

  test("save queue serializes in-flight saves and persists the latest pending preferences", async () => {
    const controller = new AbortController();
    const saves: Array<UserPreferences | null | undefined> = [];
    const firstSave = { release: undefined as (() => void) | undefined };
    let saveCalls = 0;
    let currentPreferences: UserPreferences | undefined = { appearance: { theme: "dark" } };
    let dirtyClears = 0;

    const queue = createUserPreferenceSaveQueue({
      signal: controller.signal,
      configClient: {
        getConfig: () => Promise.resolve({}),
        saveConfig: async (input) => {
          saveCalls += 1;
          if (saveCalls === 1) {
            await new Promise<void>((resolve) => {
              firstSave.release = resolve;
            });
          }
          saves.push(input.userPreferences);
        },
      },
      getCurrentPreferences: () => currentPreferences,
      clearDirtyKeys: () => {
        dirtyClears += 1;
      },
      onError: (message, error) => {
        throw new Error(`${message} ${String(error)}`);
      },
    });

    queue({ appearance: { theme: "dark" } });
    currentPreferences = { appearance: { theme: "light" } };
    queue(currentPreferences);

    await waitUntil(() => expect(firstSave.release).toBeDefined());
    const releaseFirst = firstSave.release;
    if (!releaseFirst) {
      throw new Error("Expected first save release callback");
    }
    releaseFirst();

    await waitUntil(() => expect(saves).toHaveLength(2));
    expect(saves).toEqual([{ appearance: { theme: "dark" } }, { appearance: { theme: "light" } }]);
    expect(dirtyClears).toBe(1);
  });
});
