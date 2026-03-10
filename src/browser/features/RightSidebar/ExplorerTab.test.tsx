import React, { type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import { cleanup, render, waitFor } from "@testing-library/react";

interface ExecuteBashInput {
  workspaceId: string;
  script: string;
  options?: {
    cwdMode?: "repo-root";
  };
}

type ExecuteBashResult =
  | {
      success: true;
      data: {
        success: boolean;
        output: string;
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

void mock.module("@/browser/hooks/usePersistedState", () => ({
  readPersistedState: <T,>(_key: string, defaultValue: T) => defaultValue,
  updatePersistedState: () => undefined,
  usePersistedState: <T,>(_key: string, initialValue: T) => React.useState(initialValue),
}));

void mock.module("@/browser/stores/WorkspaceStore", () => ({
  workspaceStore: {
    subscribeFileModifyingTool: () => () => undefined,
  },
}));

void mock.module("@/browser/components/Tooltip/Tooltip", () => ({
  Tooltip: (props: { children: ReactNode }) => <>{props.children}</>,
  TooltipTrigger: (props: { children: ReactNode; asChild?: boolean }) => <>{props.children}</>,
  TooltipContent: (props: { children: ReactNode; side?: string }) => <>{props.children}</>,
}));

void mock.module("@/browser/components/FileIcon/FileIcon", () => ({
  FileIcon: (_props: { fileName: string; style?: React.CSSProperties; className?: string }) => (
    <div data-testid="file-icon" />
  ),
}));

void mock.module("@/browser/utils/fileExplorer", () => ({
  validateRelativePath: () => null,
  buildListDirScript: (relativePath: string) =>
    relativePath ? `LIST ${relativePath}` : "LIST ROOT",
  buildGitIgnoredScript: () => "GIT IGNORED ROOT",
  buildGitCheckIgnoreScript: (paths: string[]) => `GIT CHECK ${paths.join(",")}`,
  parseLsOutput: (_output: string, relativePath: string) =>
    relativePath === ""
      ? [
          {
            name: "ignored-dir",
            path: "ignored-dir",
            isDirectory: true,
            children: [],
          },
        ]
      : [],
  parseGitStatus: () => ({
    ignored: new Set<string>(),
    modified: new Set<string>(),
    untracked: new Set<string>(),
  }),
  parseGitCheckIgnoreOutput: () => new Set(["ignored-dir"]),
}));

import { ExplorerTab } from "./ExplorerTab";

describe("ExplorerTab", () => {
  let originalWindow: typeof globalThis.window;
  let originalDocument: typeof globalThis.document;

  beforeEach(() => {
    originalWindow = globalThis.window;
    originalDocument = globalThis.document;
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
    const realUseState = React.useState;
    const eagerUseState = ((...args: [unknown?]) => {
      const [value, setValue] = args.length === 0 ? realUseState<unknown>() : realUseState(args[0]);
      const eagerSetValue: typeof setValue = (nextValue) => {
        if (typeof nextValue === "function") {
          const updater = nextValue as (prev: unknown) => unknown;
          setValue(updater(value));
          return;
        }
        setValue(nextValue);
      };
      return [value, eagerSetValue];
    }) as typeof React.useState;
    spyOn(React, "useState").mockImplementation(eagerUseState);
    mockApi = null;
  });

  afterEach(() => {
    cleanup();
    mock.restore();
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
  });

  test("runs git ignore scripts from the repo root", async () => {
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

    render(<ExplorerTab workspaceId="workspace-1" workspacePath="/tmp/workspace-1" />);

    await waitFor(() => {
      expect(executeBash.mock.calls[2]).toBeDefined();
    });

    expect(executeBash).toHaveBeenNthCalledWith(1, {
      workspaceId: "workspace-1",
      script: "LIST ROOT",
    });
    expect(executeBash).toHaveBeenNthCalledWith(2, {
      workspaceId: "workspace-1",
      script: "GIT IGNORED ROOT",
      options: { cwdMode: "repo-root" },
    });
    expect(executeBash).toHaveBeenNthCalledWith(3, {
      workspaceId: "workspace-1",
      script: "GIT CHECK ignored-dir",
      options: { cwdMode: "repo-root" },
    });
  });
});
