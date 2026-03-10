import React, { type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import { cleanup, render, waitFor } from "@testing-library/react";
import * as APIModule from "@/browser/contexts/API";
import * as PersistedStateModule from "@/browser/hooks/usePersistedState";
import * as WorkspaceStoreModule from "@/browser/stores/WorkspaceStore";
import * as TooltipModule from "@/browser/components/Tooltip/Tooltip";
import * as FileIconModule from "@/browser/components/FileIcon/FileIcon";
import * as FileExplorerModule from "@/browser/utils/fileExplorer";

import { ExplorerTab } from "./ExplorerTab";

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

function installExplorerTabTestDoubles() {
  spyOn(APIModule, "useAPI").mockImplementation(() => ({
    api: mockApi,
    status: mockApi ? ("connected" as const) : ("error" as const),
    error: mockApi ? null : "API unavailable",
    authenticate: () => undefined,
    retry: () => undefined,
  }));

  spyOn(PersistedStateModule, "readPersistedState").mockImplementation(
    (<T,>(_key: string, defaultValue: T) =>
      defaultValue) as typeof PersistedStateModule.readPersistedState
  );
  spyOn(PersistedStateModule, "updatePersistedState").mockImplementation(
    ((_: string, __: unknown, ___?: unknown) =>
      undefined) as typeof PersistedStateModule.updatePersistedState
  );
  spyOn(PersistedStateModule, "usePersistedState").mockImplementation((<T,>(
    _key: string,
    initialValue: T
  ) => React.useState(initialValue)) as typeof PersistedStateModule.usePersistedState);

  spyOn(WorkspaceStoreModule.workspaceStore, "subscribeFileModifyingTool").mockImplementation(
    () => () => undefined
  );

  spyOn(TooltipModule, "Tooltip").mockImplementation(((props: { children: ReactNode }) => (
    <>{props.children}</>
  )) as unknown as typeof TooltipModule.Tooltip);
  spyOn(TooltipModule, "TooltipTrigger").mockImplementation(((props: {
    children: ReactNode;
    asChild?: boolean;
  }) => <>{props.children}</>) as unknown as typeof TooltipModule.TooltipTrigger);
  spyOn(TooltipModule, "TooltipContent").mockImplementation(((props: {
    children: ReactNode;
    side?: string;
  }) => <>{props.children}</>) as unknown as typeof TooltipModule.TooltipContent);

  spyOn(FileIconModule, "FileIcon").mockImplementation(((_props: {
    fileName: string;
    style?: React.CSSProperties;
    className?: string;
  }) => <div data-testid="file-icon" />) as unknown as typeof FileIconModule.FileIcon);

  spyOn(FileExplorerModule, "validateRelativePath").mockImplementation(() => undefined);
  spyOn(FileExplorerModule, "buildListDirScript").mockImplementation((relativePath: string) =>
    relativePath ? `LIST ${relativePath}` : "LIST ROOT"
  );
  spyOn(FileExplorerModule, "buildGitIgnoredScript").mockImplementation(() => "GIT IGNORED ROOT");
  spyOn(FileExplorerModule, "buildGitCheckIgnoreScript").mockImplementation(
    (paths: string[]) => `GIT CHECK ${paths.join(",")}`
  );
  spyOn(FileExplorerModule, "parseLsOutput").mockImplementation(
    (_output: string, relativePath: string) =>
      relativePath === ""
        ? [
            {
              name: "ignored-dir",
              path: "ignored-dir",
              isDirectory: true,
              children: [],
            },
          ]
        : []
  );
  spyOn(FileExplorerModule, "parseGitStatus").mockImplementation(() => ({
    ignored: new Set<string>(),
    modified: new Set<string>(),
    untracked: new Set<string>(),
  }));
  spyOn(FileExplorerModule, "parseGitCheckIgnoreOutput").mockImplementation(
    () => new Set(["ignored-dir"])
  );
}

describe("ExplorerTab", () => {
  let originalWindow: typeof globalThis.window;
  let originalDocument: typeof globalThis.document;

  beforeEach(() => {
    originalWindow = globalThis.window;
    originalDocument = globalThis.document;
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
    installExplorerTabTestDoubles();
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
