import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";
import type { ComponentProps } from "react";

import type { FileTreeNode } from "@/common/utils/git/numstatParser";
import type { DiffHunk } from "@/common/types/review";

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

import { ImmersiveReviewView } from "./ImmersiveReviewView";

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
  const segments = filePath.split("/");
  const root: FileTreeNode = {
    name: "",
    path: "",
    isDirectory: true,
    children: [],
  };

  let current = root;
  for (const [index, segment] of segments.entries()) {
    const isLastSegment = index === segments.length - 1;
    const path = segments.slice(0, index + 1).join("/");
    const nextNode: FileTreeNode = {
      name: segment,
      path,
      isDirectory: !isLastSegment,
      children: [],
    };
    current.children.push(nextNode);
    current = nextNode;
  }

  return root;
}

function renderImmersiveReview(
  overrides: Partial<ComponentProps<typeof ImmersiveReviewView>> = {}
) {
  const hunk = createHunk();

  return render(
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
  );
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
});
