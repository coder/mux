import { beforeEach, describe, expect, test } from "bun:test";
import type { DiffHunk } from "@/common/types/review";
import type { FileTreeNode } from "@/common/utils/git/numstatParser";
import {
  clearReviewPanelCaches,
  getCachedReviewDiff,
  getCachedReviewFileTree,
  getInFlightReviewDiff,
  getInFlightReviewFileTree,
  makeReviewDiffCacheKey,
  makeReviewFileTreeCacheKey,
  setCachedReviewDiff,
  setCachedReviewFileTree,
  setInFlightReviewDiff,
  setInFlightReviewFileTree,
} from "./reviewPanelCache";

describe("reviewPanelCache", () => {
  beforeEach(() => {
    clearReviewPanelCaches();
  });

  test("makeReviewDiffCacheKey is sensitive to selectedFilePath", () => {
    const base = {
      workspaceId: "ws",
      workspacePath: "/tmp/ws",
      diffBase: "HEAD",
      includeUncommitted: false,
    };

    const keyA = makeReviewDiffCacheKey({ ...base, selectedFilePath: null });
    const keyB = makeReviewDiffCacheKey({ ...base, selectedFilePath: "src/a.ts" });

    expect(keyA).not.toEqual(keyB);
  });

  test("makeReviewFileTreeCacheKey does not include selectedFilePath", () => {
    const key = makeReviewFileTreeCacheKey({
      workspaceId: "ws",
      workspacePath: "/tmp/ws",
      diffBase: "HEAD",
      includeUncommitted: true,
    });

    expect(key).toContain("review-panel-tree");
  });

  test("diff cache round-trips", () => {
    const key = makeReviewDiffCacheKey({
      workspaceId: "ws",
      workspacePath: "/tmp/ws",
      diffBase: "HEAD",
      includeUncommitted: false,
      selectedFilePath: null,
    });

    const hunk: DiffHunk = {
      id: "h1",
      filePath: "src/a.ts",
      oldStart: 1,
      oldLines: 1,
      newStart: 1,
      newLines: 1,
      content: "+console.log('hi')",
      header: "@@ -1 +1 @@",
      changeType: "modified",
    };

    setCachedReviewDiff(key, {
      hunks: [hunk],
      truncationWarning: null,
      diagnosticInfo: {
        command: "git diff",
        outputLength: 123,
        fileDiffCount: 1,
        hunkCount: 1,
      },
    });

    expect(getCachedReviewDiff(key)?.hunks[0].id).toEqual("h1");
  });

  test("file tree cache round-trips", () => {
    const key = makeReviewFileTreeCacheKey({
      workspaceId: "ws",
      workspacePath: "/tmp/ws",
      diffBase: "HEAD",
      includeUncommitted: false,
    });

    const tree: FileTreeNode = {
      name: "",
      path: "",
      isDirectory: true,
      children: [],
      totalStats: { filePath: "", additions: 0, deletions: 0 },
    };

    setCachedReviewFileTree(key, { fileTree: tree });

    expect(getCachedReviewFileTree(key)?.fileTree.isDirectory).toEqual(true);
  });

  test("inFlight diff is cleared after settle", async () => {
    const key = makeReviewDiffCacheKey({
      workspaceId: "ws",
      workspacePath: "/tmp/ws",
      diffBase: "HEAD",
      includeUncommitted: false,
      selectedFilePath: null,
    });

    let resolve!: (value: {
      hunks: DiffHunk[];
      truncationWarning: string | null;
      diagnosticInfo: null;
    }) => void;

    const promise = new Promise<{
      hunks: DiffHunk[];
      truncationWarning: string | null;
      diagnosticInfo: null;
    }>((r) => {
      resolve = r;
    });

    setInFlightReviewDiff(key, promise);
    expect(getInFlightReviewDiff(key)).toBe(promise);

    resolve({ hunks: [], truncationWarning: null, diagnosticInfo: null });
    await promise;

    expect(getInFlightReviewDiff(key)).toBeNull();
  });

  test("inFlight file tree is cleared after settle", async () => {
    const key = makeReviewFileTreeCacheKey({
      workspaceId: "ws",
      workspacePath: "/tmp/ws",
      diffBase: "HEAD",
      includeUncommitted: false,
    });

    let resolve!: (value: { fileTree: FileTreeNode }) => void;

    const tree: FileTreeNode = {
      name: "",
      path: "",
      isDirectory: true,
      children: [],
      totalStats: { filePath: "", additions: 0, deletions: 0 },
    };

    const promise = new Promise<{ fileTree: FileTreeNode }>((r) => {
      resolve = r;
    });

    setInFlightReviewFileTree(key, promise);
    expect(getInFlightReviewFileTree(key)).toBe(promise);

    resolve({ fileTree: tree });
    await promise;

    expect(getInFlightReviewFileTree(key)).toBeNull();
  });
});
