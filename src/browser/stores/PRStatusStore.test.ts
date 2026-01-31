import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import type { RouterClient } from "@orpc/server";

import type { AppRouter } from "@/node/orpc/router";
import { createLRUCache } from "@/browser/utils/lruCache";
import { PRStatusStore } from "./PRStatusStore";
import type { GitHubPRLink, GitHubPRStatus } from "@/common/types/links";

interface PersistedPRStatus {
  prLink: GitHubPRLink;
  status?: GitHubPRStatus;
}

describe("PRStatusStore", () => {
  let originalWindow: typeof globalThis.window;
  let originalDocument: typeof globalThis.document;

  beforeEach(() => {
    originalWindow = globalThis.window;
    originalDocument = globalThis.document;

    const domWindow = new GlobalWindow({ url: "http://localhost" }) as unknown as Window &
      typeof globalThis;
    globalThis.window = domWindow;
    globalThis.document = domWindow.document;

    window.localStorage.clear();
  });

  afterEach(() => {
    // Release Happy DOM resources.
    globalThis.window.close();

    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
  });

  test("hydrated cached entries still trigger refresh", async () => {
    const workspaceId = "workspace-1";

    const prLink: GitHubPRLink = {
      type: "github-pr",
      url: "https://github.com/o/r/pull/1",
      owner: "o",
      repo: "r",
      number: 1,
      detectedAt: Date.now(),
      occurrenceCount: 1,
    };

    const cache = createLRUCache<PersistedPRStatus>({
      entryPrefix: "prStatus:",
      indexKey: "prStatusIndex",
      maxEntries: 50,
    });

    cache.set(workspaceId, { prLink });

    const executeBash = mock(() => {
      return Promise.resolve({
        success: true,
        data: {
          success: true,
          output: JSON.stringify({ no_pr: true }),
          exitCode: 0,
          wall_duration_ms: 1,
        },
      });
    });

    const client = {
      workspace: {
        executeBash,
      },
    } as unknown as RouterClient<AppRouter>;

    const store = new PRStatusStore();
    store.setClient(client);

    const hydrated = store.getWorkspacePR(workspaceId);
    expect(hydrated?.loading).toBe(true);
    expect(hydrated?.fetchedAt).toBe(0);

    const unsubscribe = store.subscribeWorkspace(workspaceId, () => undefined);

    // subscribeWorkspace batches refresh requests into a microtask.
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    expect(executeBash).toHaveBeenCalled();

    unsubscribe();
    store.dispose();
  });
});
