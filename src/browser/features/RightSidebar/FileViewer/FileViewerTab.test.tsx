import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import { cleanup, render, waitFor } from "@testing-library/react";

interface ExecuteBashInput {
  workspaceId: string;
  script: string;
  options?: {
    timeout_secs?: number;
    cwdMode?: "repo-root";
    repoRootProjectPath?: string;
  };
}

type ExecuteBashResult =
  | {
      success: true;
      data: {
        success: boolean;
        output?: string;
        exitCode: number;
        error?: string;
      };
    }
  | { success: false; error: string };

interface MockApiClient {
  workspace: {
    executeBash: (input: ExecuteBashInput) => Promise<ExecuteBashResult>;
  };
}

let mockApi: MockApiClient | null = null;

void mock.module("@/browser/contexts/API", () => ({
  useAPI: () => ({
    api: mockApi,
    status: mockApi ? ("connected" as const) : ("error" as const),
    error: mockApi ? null : "API unavailable",
    authenticate: () => undefined,
    retry: () => undefined,
  }),
}));

void mock.module("@/browser/contexts/WorkspaceContext", () => ({
  useWorkspaceMetadata: () => ({
    workspaceMetadata: new Map([
      [
        "workspace-1",
        {
          projects: [
            { projectName: "project-a", projectPath: "/tmp/project-a" },
            { projectName: "project-b", projectPath: "/tmp/project-b" },
          ],
        },
      ],
    ]),
    loading: false,
  }),
}));

void mock.module("@/browser/stores/WorkspaceStore", () => ({
  workspaceStore: {
    subscribeFileModifyingTool: () => () => undefined,
  },
}));

void mock.module("@/browser/utils/fileExplorer", () => ({
  validateRelativePath: () => null,
  buildReadFileScript: (relativePath: string) => `READ ${relativePath}`,
  buildFileDiffScript: (relativePath: string) => `DIFF ${relativePath}`,
  processFileContents: () => ({ type: "text" as const, content: "file contents", size: 13 }),
  EXIT_CODE_TOO_LARGE: 66,
}));

void mock.module("@/browser/utils/fileContentCache", () => ({
  getCachedFileContent: () => null,
  setCachedFileContent: () => undefined,
  removeCachedFileContent: () => undefined,
  cacheToResult: () => ({ type: "text" as const, content: "cached contents", size: 15 }),
}));

void mock.module("./TextFileViewer", () => ({
  TextFileViewer: (props: { content: string }) => (
    <div data-testid="text-file-viewer">{props.content}</div>
  ),
}));

void mock.module("./ImageFileViewer", () => ({
  ImageFileViewer: (_props: { dataUrl: string }) => <div data-testid="image-file-viewer" />,
}));

import { FileViewerTab } from "./FileViewerTab";

describe("FileViewerTab", () => {
  let originalWindow: typeof globalThis.window;
  let originalDocument: typeof globalThis.document;

  beforeEach(() => {
    originalWindow = globalThis.window;
    originalDocument = globalThis.document;
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
    mockApi = null;
  });

  afterEach(() => {
    cleanup();
    mock.restore();
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
  });

  test("reads sibling-project files from the shared container cwd while using repo-relative diff paths", async () => {
    const executeBash = mock(() =>
      Promise.resolve({
        success: true,
        data: {
          success: true,
          output: "ok",
          exitCode: 0,
        },
      } satisfies ExecuteBashResult)
    );

    mockApi = {
      workspace: {
        executeBash,
      },
    };

    const view = render(
      <FileViewerTab workspaceId="workspace-1" relativePath="project-b/src/example.ts" />
    );

    await waitFor(() => {
      expect(executeBash).toHaveBeenCalledTimes(2);
    });

    expect(executeBash).toHaveBeenNthCalledWith(1, {
      workspaceId: "workspace-1",
      script: "READ project-b/src/example.ts",
    });
    expect(executeBash).toHaveBeenNthCalledWith(2, {
      workspaceId: "workspace-1",
      script: "DIFF src/example.ts",
      options: { cwdMode: "repo-root", repoRootProjectPath: "/tmp/project-b" },
    });

    await waitFor(() => {
      expect(view.getByTestId("text-file-viewer").textContent).toBe("file contents");
    });
  });
});
