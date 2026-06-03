import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";
import { useEffect, useState, type ComponentProps } from "react";

import { ThemeProvider } from "@/browser/contexts/ThemeContext";
import type { FileTreeNode } from "@/common/utils/git/numstatParser";
import type { DiffHunk, Review } from "@/common/types/review";

interface MockApiClient {
  workspace: {
    executeBash: (...args: unknown[]) => Promise<{
      success: true;
      data: {
        success: boolean;
        output: string;
        exitCode: number;
      };
    }>;
  };
}

let mockApi: MockApiClient;

void mock.module("@/browser/contexts/API", () => ({
  useAPI: () => ({
    api: mockApi,
    status: "connected" as const,
    error: null,
    authenticate: () => undefined,
    retry: () => undefined,
  }),
}));

import { ImmersiveReviewView, shouldPreserveImmersiveContextCursor } from "./ImmersiveReviewView";

function createHunk(overrides: Partial<DiffHunk> = {}): DiffHunk {
  return {
    id: "hunk-1",
    filePath: "src/example.ts",
    oldStart: 1,
    oldLines: 1,
    newStart: 1,
    newLines: 1,
    header: "@@ -1 +1 @@",
    content: "-old line\n+new line",
    ...overrides,
  };
}

function createFileTree(filePath: string): FileTreeNode {
  return createFileTreeForPaths([filePath]);
}

function createFileTreeForPaths(filePaths: string[]): FileTreeNode {
  const root: FileTreeNode = {
    name: "",
    path: "",
    isDirectory: true,
    children: [],
  };

  for (const filePath of filePaths) {
    const segments = filePath.split("/");
    let current = root;
    for (const [index, segment] of segments.entries()) {
      const isLastSegment = index === segments.length - 1;
      const path = segments.slice(0, index + 1).join("/");
      let next = current.children.find((child) => child.path === path);
      if (!next) {
        next = {
          name: segment,
          path,
          isDirectory: !isLastSegment,
          children: [],
        };
        current.children.push(next);
      }
      current = next;
    }
  }

  return root;
}

function encodeFileReadOutput(content: string): string {
  return `${Buffer.byteLength(content, "utf8")}\n${Buffer.from(content, "utf8").toString("base64")}`;
}

function renderImmersiveReview(
  overrides: Partial<ComponentProps<typeof ImmersiveReviewView>> = {}
) {
  const hunk = createHunk();

  return render(
    <ThemeProvider forcedTheme="dark">
      <ImmersiveReviewView
        workspaceId="workspace-1"
        fileTree={createFileTree(hunk.filePath)}
        hunks={[hunk]}
        allHunks={[hunk]}
        isRead={() => false}
        onToggleRead={mock(() => undefined)}
        onMarkFileAsRead={mock(() => undefined)}
        selectedHunkId={hunk.id}
        onSelectHunk={mock(() => undefined)}
        onExit={mock(() => undefined)}
        isTouchImmersive={true}
        reviewsByFilePath={new Map()}
        firstSeenMap={{}}
        {...overrides}
      />
    </ThemeProvider>
  );
}

function installManualAnimationFrame() {
  let nextFrameId = 1;
  const callbacks = new Map<number, FrameRequestCallback>();

  const requestAnimationFrameMock = mock((callback: FrameRequestCallback) => {
    const frameId = nextFrameId;
    nextFrameId += 1;
    callbacks.set(frameId, callback);
    return frameId;
  }) as unknown as typeof globalThis.requestAnimationFrame;
  const cancelAnimationFrameMock = mock((frameId: number) => {
    callbacks.delete(frameId);
  }) as unknown as typeof globalThis.cancelAnimationFrame;

  globalThis.requestAnimationFrame = requestAnimationFrameMock;
  globalThis.cancelAnimationFrame = cancelAnimationFrameMock;
  globalThis.window.requestAnimationFrame = requestAnimationFrameMock;
  globalThis.window.cancelAnimationFrame = cancelAnimationFrameMock;

  return {
    flush() {
      const pendingCallbacks = Array.from(callbacks.values());
      callbacks.clear();
      for (const callback of pendingCallbacks) {
        callback(performance.now());
      }
    },
  };
}

describe("ImmersiveReviewView", () => {
  let originalWindow: typeof globalThis.window;
  let originalDocument: typeof globalThis.document;
  let originalNavigator: typeof globalThis.navigator;
  let originalRequestAnimationFrame: typeof globalThis.requestAnimationFrame;
  let originalCancelAnimationFrame: typeof globalThis.cancelAnimationFrame;

  beforeEach(() => {
    originalWindow = globalThis.window;
    originalDocument = globalThis.document;
    originalNavigator = globalThis.navigator;
    originalRequestAnimationFrame = globalThis.requestAnimationFrame;
    originalCancelAnimationFrame = globalThis.cancelAnimationFrame;

    const dom = new GlobalWindow({ url: "http://localhost" });
    globalThis.window = dom as unknown as Window & typeof globalThis;
    globalThis.document = dom.document as unknown as Document;
    globalThis.navigator = dom.navigator as unknown as Navigator;
    globalThis.requestAnimationFrame = dom.requestAnimationFrame.bind(
      dom
    ) as unknown as typeof globalThis.requestAnimationFrame;
    globalThis.cancelAnimationFrame = dom.cancelAnimationFrame.bind(
      dom
    ) as unknown as typeof globalThis.cancelAnimationFrame;

    globalThis.window.api = { platform: "linux", versions: {} };

    mockApi = {
      workspace: {
        executeBash: mock(() =>
          Promise.resolve({
            success: true as const,
            data: {
              success: true,
              output: "",
              exitCode: 0,
            },
          })
        ),
      },
    };
  });

  afterEach(() => {
    cleanup();
    mock.restore();
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
    globalThis.navigator = originalNavigator;
    globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
  });

  test("renders the hunk overlay while full-file context is still pending", async () => {
    type ExecuteBashValue = Awaited<ReturnType<MockApiClient["workspace"]["executeBash"]>>;
    let resolveRead: ((value: ExecuteBashValue) => void) | undefined;
    const pendingRead = new Promise<ExecuteBashValue>((resolve) => {
      resolveRead = resolve;
    });
    mockApi.workspace.executeBash = mock(() => pendingRead);

    const view = renderImmersiveReview();

    expect(view.container.textContent ?? "").toContain("new line");
    await waitFor(() => expect(mockApi.workspace.executeBash).toHaveBeenCalledTimes(1));

    if (!resolveRead) {
      throw new Error("Read promise resolver was not captured");
    }
    resolveRead({
      success: true,
      data: {
        success: true,
        output: "0",
        exitCode: 0,
      },
    });
  });

  test("keeps hydrated full-file context behind the reveal gate until positioned", async () => {
    type ExecuteBashValue = Awaited<ReturnType<MockApiClient["workspace"]["executeBash"]>>;
    let resolveRead: ((value: ExecuteBashValue) => void) | undefined;
    const pendingRead = new Promise<ExecuteBashValue>((resolve) => {
      resolveRead = resolve;
    });
    mockApi.workspace.executeBash = mock(() => pendingRead);
    const animationFrame = installManualAnimationFrame();

    const hunk = createHunk({
      newStart: 3,
      oldStart: 3,
      header: "@@ -3 +3 @@",
      content: "-old selected line\n+new selected line",
    });

    const view = renderImmersiveReview({
      fileTree: createFileTree(hunk.filePath),
      hunks: [hunk],
      allHunks: [hunk],
      selectedHunkId: hunk.id,
      isTouchImmersive: false,
    });

    await waitFor(() => expect(mockApi.workspace.executeBash).toHaveBeenCalledTimes(1));
    expect(view.getByTestId("immersive-diff-reveal-overlay").textContent ?? "").toContain(
      "Loading file"
    );
    expect(view.getByTestId("immersive-diff-reveal-stage").className).toContain("invisible");

    act(() => animationFrame.flush());
    await waitFor(() => expect(view.queryByTestId("immersive-diff-reveal-overlay")).toBeNull());
    expect(view.getByTestId("immersive-diff-reveal-stage").className).not.toContain("invisible");

    const resolveLoadedContent = resolveRead;
    if (!resolveLoadedContent) {
      throw new Error("Read promise resolver was not captured");
    }

    act(() => {
      resolveLoadedContent({
        success: true,
        data: {
          success: true,
          output: encodeFileReadOutput(
            ["context before selected 1", "context before selected 2", "new selected line"].join(
              "\n"
            )
          ),
          exitCode: 0,
        },
      });
    });

    await waitFor(() =>
      expect(view.getByTestId("immersive-diff-reveal-overlay").textContent ?? "").toContain(
        "Preparing diff"
      )
    );
    expect(view.container.textContent ?? "").toContain("context before selected 1");
    expect(view.getByTestId("immersive-diff-reveal-stage").className).toContain("invisible");
    expect(view.getByTestId("immersive-minimap-reveal-stage").className).toContain("h-full");
    expect(view.getByTestId("immersive-minimap-reveal-stage").className).toContain("invisible");

    act(() => animationFrame.flush());
    await waitFor(() => expect(view.queryByTestId("immersive-diff-reveal-overlay")).toBeNull());
    expect(view.getByTestId("immersive-diff-reveal-stage").className).not.toContain("invisible");
    expect(view.getByTestId("immersive-minimap-reveal-stage").className).not.toContain("invisible");
  });

  test("only preserves context cursors while overlay content is unchanged", () => {
    const previousRange = { startIndex: 0, endIndex: 1 };

    expect(
      shouldPreserveImmersiveContextCursor({
        cursorLineIndex: 2,
        previousRange,
        previousHunkId: "hunk-selected",
        currentHunkId: "hunk-selected",
        previousOverlayContent: "compact overlay",
        currentOverlayContent: "compact overlay",
      })
    ).toBe(true);

    // Compact hunk overlays and hydrated full-file overlays use different
    // numeric row indices. Do not carry an out-of-hunk compact cursor across
    // hydration, or the reveal can replay a stale context/separator row.
    expect(
      shouldPreserveImmersiveContextCursor({
        cursorLineIndex: 2,
        previousRange,
        previousHunkId: "hunk-selected",
        currentHunkId: "hunk-selected",
        previousOverlayContent: "compact overlay",
        currentOverlayContent: "hydrated full-file overlay",
      })
    ).toBe(false);

    expect(
      shouldPreserveImmersiveContextCursor({
        cursorLineIndex: 1,
        previousRange,
        previousHunkId: "hunk-selected",
        currentHunkId: "hunk-selected",
        previousOverlayContent: "compact overlay",
        currentOverlayContent: "compact overlay",
      })
    ).toBe(false);
  });

  test("skips full-file reads when the selected hunk starts beyond the render budget", () => {
    const farHunk = createHunk({
      id: "hunk-far",
      oldStart: 5000,
      newStart: 5000,
      header: "@@ -5000 +5000 @@",
      content: "-old far line\n+new far line",
    });

    const view = renderImmersiveReview({
      fileTree: createFileTree(farHunk.filePath),
      hunks: [farHunk],
      allHunks: [farHunk],
      selectedHunkId: farHunk.id,
    });

    expect(view.container.textContent ?? "").toContain("new far line");
    expect(mockApi.workspace.executeBash).not.toHaveBeenCalled();
  });

  test("shows the assisted-mode badge only while the Assisted filter is active", () => {
    // Off by default: the badge must not appear when not filtering.
    const off = renderImmersiveReview();
    expect(off.queryByTestId("immersive-assisted-mode-badge")).toBeNull();
    cleanup();

    // On: the header surfaces the badge with the unread/total counts so the
    // active filter mode is visible even though the control bar is hidden
    // behind the immersive overlay.
    const on = renderImmersiveReview({
      assistedOnly: true,
      assistedCount: 3,
      assistedUnreadCount: 2,
    });
    const badge = on.getByTestId("immersive-assisted-mode-badge");
    expect(badge.textContent ?? "").toContain("Assisted");
    expect(badge.textContent ?? "").toContain("2/3");
  });

  test("reserves the assisted banner slot while iterating through hunks in one file", () => {
    const assistedHunk = createHunk({
      id: "hunk-assisted",
      filePath: "src/example.ts",
      oldStart: 1,
      oldLines: 1,
      newStart: 1,
      newLines: 1,
      header: "@@ -1 +1 @@",
      content: "-old assisted\n+new assisted",
    });
    const regularHunk = createHunk({
      id: "hunk-regular",
      filePath: assistedHunk.filePath,
      oldStart: 12,
      oldLines: 1,
      newStart: 12,
      newLines: 1,
      header: "@@ -12 +12 @@",
      content: "-old regular\n+new regular",
    });
    const hunks = [assistedHunk, regularHunk];
    const assistedComment = "Inspect this change\nThe full rationale should remain available.";
    const assistedHunkIds = new Set([assistedHunk.id]);
    const assistedCommentByHunkId = new Map([[assistedHunk.id, assistedComment]]);

    const renderView = (selectedHunkId: string, visibleHunks: DiffHunk[] = hunks) => (
      <ThemeProvider forcedTheme="dark">
        <ImmersiveReviewView
          workspaceId="workspace-1"
          fileTree={createFileTree(assistedHunk.filePath)}
          hunks={visibleHunks}
          allHunks={hunks}
          isRead={() => false}
          onToggleRead={mock(() => undefined)}
          onMarkFileAsRead={mock(() => undefined)}
          selectedHunkId={selectedHunkId}
          onSelectHunk={mock(() => undefined)}
          onExit={mock(() => undefined)}
          isTouchImmersive={true}
          reviewsByFilePath={new Map()}
          firstSeenMap={{}}
          assistedHunkIds={assistedHunkIds}
          assistedCommentByHunkId={assistedCommentByHunkId}
        />
      </ThemeProvider>
    );

    const view = render(renderView(assistedHunk.id));

    expect(view.container.querySelector('[data-assisted-banner-slot="true"]')).toBeTruthy();
    const banner = view.getByTestId("immersive-assisted-banner");
    expect(banner.textContent ?? "").toContain("Inspect this change");
    expect(banner.getAttribute("title")).toBe(assistedComment);

    view.rerender(renderView(regularHunk.id));

    // The fixed slot remains mounted for same-file hunk iteration, but the
    // selected-hunk callout content disappears when the plain hunk is selected.
    expect(view.getByTestId("immersive-assisted-banner-slot")).toBeTruthy();
    expect(view.queryByTestId("immersive-assisted-banner")).toBeNull();

    // Filters can hide the assisted hunk while the file remains active; reserve
    // from allHunks so hide-read/search does not collapse the layout mid-file.
    view.rerender(renderView(regularHunk.id, [regularHunk]));
    expect(view.getByTestId("immersive-assisted-banner-slot")).toBeTruthy();
    expect(view.queryByTestId("immersive-assisted-banner")).toBeNull();
  });

  test("loads full-file context for an in-budget selected hunk even when another hunk is far away", async () => {
    const nearHunk = createHunk({
      id: "hunk-near",
      newStart: 40,
      newLines: 1,
      header: "@@ -40 +40 @@",
      content: "-old near line\n+new near line",
    });
    const farHunk = createHunk({
      id: "hunk-far",
      newStart: 5000,
      newLines: 1,
      header: "@@ -5000 +5000 @@",
      content: "-old far line\n+new far line",
    });

    renderImmersiveReview({
      fileTree: createFileTree(nearHunk.filePath),
      hunks: [nearHunk, farHunk],
      allHunks: [nearHunk, farHunk],
      selectedHunkId: nearHunk.id,
    });

    await waitFor(() => expect(mockApi.workspace.executeBash).toHaveBeenCalledTimes(1));
  });

  test("accepts full-file context at the line budget when the file ends with a newline", async () => {
    const lineBudget = 1500;
    const fileContent = `${[
      "new line",
      "context after selected hunk",
      ...Array.from({ length: lineBudget - 2 }, (_, index) => `filler ${index}`),
    ].join("\n")}\n`;
    mockApi.workspace.executeBash = mock(() =>
      Promise.resolve({
        success: true as const,
        data: {
          success: true,
          output: encodeFileReadOutput(fileContent),
          exitCode: 0,
        },
      })
    );

    const view = renderImmersiveReview();

    await waitFor(() =>
      expect(view.container.textContent ?? "").toContain("context after selected hunk")
    );
  });

  test("retries full-file context after a transient read failure", async () => {
    const firstHunk = createHunk({ id: "hunk-first", filePath: "src/first.ts" });
    const secondHunk = createHunk({ id: "hunk-second", filePath: "src/second.ts" });
    const allHunks = [firstHunk, secondHunk];
    const fileTree = createFileTreeForPaths(allHunks.map((hunk) => hunk.filePath));
    const onSelectHunk = mock((_hunkId: string | null) => undefined);
    mockApi.workspace.executeBash = mock(() =>
      Promise.resolve({
        success: true as const,
        data: {
          success: false,
          output: "",
          exitCode: 1,
        },
      })
    );

    const renderView = (selectedHunkId: string) => (
      <ThemeProvider forcedTheme="dark">
        <ImmersiveReviewView
          workspaceId="workspace-1"
          fileTree={fileTree}
          hunks={allHunks}
          allHunks={allHunks}
          isRead={() => false}
          onToggleRead={mock(() => undefined)}
          onMarkFileAsRead={mock(() => undefined)}
          selectedHunkId={selectedHunkId}
          onSelectHunk={onSelectHunk}
          onExit={mock(() => undefined)}
          isTouchImmersive={true}
          reviewsByFilePath={new Map()}
          firstSeenMap={{}}
        />
      </ThemeProvider>
    );

    const view = render(renderView(firstHunk.id));
    await waitFor(() => expect(mockApi.workspace.executeBash).toHaveBeenCalledTimes(1));

    view.rerender(renderView(secondHunk.id));
    await waitFor(() => expect(mockApi.workspace.executeBash).toHaveBeenCalledTimes(2));

    view.rerender(renderView(firstHunk.id));
    await waitFor(() => expect(mockApi.workspace.executeBash).toHaveBeenCalledTimes(3));
  });

  test("weights completion by changed lines instead of hunk count", () => {
    const smallHunk = createHunk({
      id: "hunk-small",
      header: "@@ -1,0 +1,1 @@",
      oldLines: 0,
      newLines: 1,
      content: "+single added line",
    });
    const largeHunk = createHunk({
      id: "hunk-large",
      header: "@@ -3,0 +3,3 @@",
      oldLines: 0,
      newLines: 3,
      content: "+first added line\n+second added line\n+third added line",
    });
    const view = renderImmersiveReview({
      hunks: [smallHunk, largeHunk],
      allHunks: [smallHunk, largeHunk],
      selectedHunkId: smallHunk.id,
      isRead: (hunkId) => hunkId === largeHunk.id,
    });

    const progressBar = view.getByRole("progressbar", {
      name: "Review completion by changed lines",
    });
    expect(progressBar.getAttribute("aria-valuenow")).toBe("75");
    expect(progressBar.getAttribute("aria-valuetext")).toContain("3/4");
  });

  test("shows a completion state when all hunks are reviewed and hidden", () => {
    const hunk = createHunk();
    const onExit = mock(() => undefined);
    const view = renderImmersiveReview({
      hunks: [],
      allHunks: [hunk],
      isRead: (hunkId) => hunkId === hunk.id,
      selectedHunkId: null,
      onExit,
    });

    expect(view.getByTestId("immersive-review-complete")).toBeTruthy();
    expect(view.queryByText("No hunks for this file")).toBeNull();

    const progressBar = view.getByRole("progressbar", {
      name: "Review completion by changed lines",
    });
    expect(progressBar.getAttribute("aria-valuenow")).toBe("100");

    fireEvent.click(view.getByRole("button", { name: "Return to chat" }));
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  test("keeps the regular empty-file state when hunks are hidden for some other reason", () => {
    const hunk = createHunk();
    const view = renderImmersiveReview({
      hunks: [],
      allHunks: [hunk],
      isRead: () => false,
      selectedHunkId: null,
    });

    expect(view.queryByTestId("immersive-review-complete")).toBeNull();
    expect(view.getByText("No hunks for this file")).toBeTruthy();
  });

  test("clicking a sidebar review selects its hunk even when hidden by the active filter", () => {
    // Repro for: clicking a pending review in the immersive sidebar should
    // jump back to the hunk the review was attached to. Previously, when
    // hide-read (or any other frontend filter) had removed the review's hunk
    // from the visible list, the navigation handler still computed the right
    // target hunk id from `allHunks` — but the parent panel reset the
    // selection on the next render because it validated against the filtered
    // hunks. Lock in the immersive contract by asserting the explicit target
    // hunk id propagates out of `onSelectHunk`.
    const visibleHunk = createHunk({
      id: "hunk-visible",
      filePath: "src/visible.ts",
      newStart: 1,
      newLines: 1,
      oldStart: 1,
      oldLines: 1,
      header: "@@ -1 +1 @@",
      content: "-old visible\n+new visible",
    });
    const reviewedHunk = createHunk({
      id: "hunk-reviewed",
      filePath: "src/reviewed.ts",
      newStart: 1,
      newLines: 1,
      oldStart: 1,
      oldLines: 1,
      header: "@@ -1 +1 @@",
      content: "-old reviewed\n+new reviewed",
    });
    const pendingReview: Review = {
      id: "review-1",
      data: {
        filePath: reviewedHunk.filePath,
        lineRange: "+1",
        selectedCode: "// sample",
        userNote: "Take another look here",
      },
      status: "pending",
      createdAt: 1000,
    };
    const reviewsByFilePath = new Map<string, Review[]>([[reviewedHunk.filePath, [pendingReview]]]);
    const onSelectHunk = mock((_hunkId: string | null) => undefined);

    const view = renderImmersiveReview({
      fileTree: createFileTreeForPaths([visibleHunk.filePath, reviewedHunk.filePath]),
      // visibleHunk is the only currently-visible hunk (hide-read or search has
      // removed reviewedHunk), but reviewedHunk still exists in the diff.
      hunks: [visibleHunk],
      allHunks: [visibleHunk, reviewedHunk],
      isRead: (hunkId) => hunkId === reviewedHunk.id,
      selectedHunkId: visibleHunk.id,
      onSelectHunk,
      reviewsByFilePath,
      isTouchImmersive: false,
    });

    const noteCard = view.container.querySelector<HTMLElement>('[data-note-index="0"]');
    expect(noteCard).toBeTruthy();

    onSelectHunk.mockClear();
    fireEvent.click(noteCard!);

    const selectedIds = onSelectHunk.mock.calls.map(([hunkId]) => hunkId);
    expect(selectedIds).toContain(reviewedHunk.id);
    // The view must not silently fall back to the first visible hunk.
    expect(selectedIds).not.toEqual([visibleHunk.id]);
  });

  test("parent panel keeps the explicit sidebar selection in immersive mode after click", () => {
    // End-to-end repro that mirrors how ReviewPanel hosts ImmersiveReviewView:
    // selectedHunkId lives in the parent and a useEffect re-validates it
    // whenever filtered hunks change. With the immersive-aware fix the parent
    // only resets when the hunk vanishes from the diff entirely, so clicking a
    // pending review for a hidden hunk keeps the immersive view on that hunk's
    // file (instead of bouncing back to the first visible hunk).
    const visibleHunk = createHunk({
      id: "hunk-visible",
      filePath: "src/visible.ts",
      newStart: 1,
      newLines: 1,
      oldStart: 1,
      oldLines: 1,
      header: "@@ -1 +1 @@",
      content: "-old visible\n+new visible",
    });
    const reviewedHunk = createHunk({
      id: "hunk-reviewed",
      filePath: "src/reviewed.ts",
      newStart: 1,
      newLines: 1,
      oldStart: 1,
      oldLines: 1,
      header: "@@ -1 +1 @@",
      content: "-old reviewed\n+new reviewed",
    });
    const pendingReview: Review = {
      id: "review-1",
      data: {
        filePath: reviewedHunk.filePath,
        lineRange: "+1",
        selectedCode: "// sample",
        userNote: "Take another look here",
      },
      status: "pending",
      createdAt: 1000,
    };
    const reviewsByFilePath = new Map<string, Review[]>([[reviewedHunk.filePath, [pendingReview]]]);

    const filteredHunks = [visibleHunk];
    const allHunks = [visibleHunk, reviewedHunk];

    function ParentPanelHarness() {
      const [selectedHunkId, setSelectedHunkId] = useState<string | null>(visibleHunk.id);

      // Mirrors ReviewPanel's selection-validity effect with the immersive
      // branch. Keep the explicit selection even when it's been hidden by an
      // active filter, since the immersive view supports rendering it from
      // `allHunks`. Switching `allHunks.some` back to `filteredHunks.some`
      // here reproduces the original bug and makes this test fail.
      useEffect(() => {
        if (filteredHunks.length === 0) return;
        const selectionExists =
          selectedHunkId && allHunks.some((hunk) => hunk.id === selectedHunkId);
        if (!selectionExists) {
          setSelectedHunkId(filteredHunks[0].id);
        }
      }, [selectedHunkId]);

      return (
        <ImmersiveReviewView
          workspaceId="workspace-1"
          fileTree={createFileTreeForPaths([visibleHunk.filePath, reviewedHunk.filePath])}
          hunks={filteredHunks}
          allHunks={allHunks}
          isRead={(hunkId) => hunkId === reviewedHunk.id}
          onToggleRead={mock(() => undefined)}
          onMarkFileAsRead={mock(() => undefined)}
          selectedHunkId={selectedHunkId}
          onSelectHunk={setSelectedHunkId}
          onExit={mock(() => undefined)}
          isTouchImmersive={false}
          reviewsByFilePath={reviewsByFilePath}
          firstSeenMap={{}}
        />
      );
    }

    const view = render(
      <ThemeProvider forcedTheme="dark">
        <ParentPanelHarness />
      </ThemeProvider>
    );

    // Sanity-check the initial state: we start on the visible hunk's file.
    expect(view.container.textContent ?? "").toContain(visibleHunk.filePath);

    const noteCard = view.container.querySelector<HTMLElement>('[data-note-index="0"]');
    expect(noteCard).toBeTruthy();
    fireEvent.click(noteCard!);

    // After the click the immersive header switches to the reviewed file —
    // the parent panel must NOT have reset the selection back to the first
    // visible hunk.
    expect(view.container.textContent ?? "").toContain(reviewedHunk.filePath);
  });
});
