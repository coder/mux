import React, {
  cloneElement,
  createContext,
  isValidElement,
  useContext,
  type ReactNode,
} from "react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";
import type { APIClient } from "@/browser/contexts/API";

interface ExecuteBashInput {
  workspaceId: string;
  script: string;
  command?: string;
  args?: string[];
  options?: {
    timeout_secs?: number;
    cwdMode?: "default" | "repo-root";
  };
}

type ExecuteBashResult =
  | {
      success: true;
      data: {
        success: boolean;
        output?: string;
        exitCode: number;
        wall_duration_ms: number;
        error?: string;
      };
    }
  | { success: false; error: string };

interface MockApiClient {
  workspace: {
    executeBash: (input: ExecuteBashInput) => Promise<ExecuteBashResult>;
  };
}

let mockApi: MockApiClient;
let mockGitStatus: { branch: string } | null = null;
const invalidateGitStatusMock = mock(() => undefined);
const copyToClipboardMock = mock(() => Promise.resolve());

const PopoverContext = createContext<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
}>({
  open: false,
  onOpenChange: () => undefined,
});

void mock.module("@/browser/contexts/API", () => ({
  useAPI: () => ({
    api: mockApi as unknown as APIClient,
    status: "connected" as const,
    error: null,
    authenticate: () => undefined,
    retry: () => undefined,
  }),
}));

void mock.module("@/browser/stores/GitStatusStore", () => ({
  useGitStatus: () => mockGitStatus,
  invalidateGitStatus: invalidateGitStatusMock,
}));

void mock.module("@/browser/hooks/useCopyToClipboard", () => ({
  useCopyToClipboard: () => ({
    copied: false,
    copyToClipboard: copyToClipboardMock,
  }),
}));

void mock.module("../Popover/Popover", () => ({
  Popover: (props: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    children: ReactNode;
  }) => (
    <PopoverContext.Provider value={{ open: props.open, onOpenChange: props.onOpenChange }}>
      {props.children}
    </PopoverContext.Provider>
  ),
  PopoverTrigger: (props: { asChild?: boolean; children: ReactNode }) => {
    const popover = useContext(PopoverContext);
    if (
      props.asChild &&
      isValidElement<{ onClick?: (event: React.MouseEvent) => void }>(props.children)
    ) {
      const child = props.children;
      return cloneElement(child, {
        onClick: (event: React.MouseEvent) => {
          child.props.onClick?.(event);
          popover.onOpenChange(!popover.open);
        },
      });
    }
    return <button onClick={() => popover.onOpenChange(!popover.open)}>{props.children}</button>;
  },
  PopoverContent: (props: { children: ReactNode }) => {
    const popover = useContext(PopoverContext);
    return popover.open ? <div>{props.children}</div> : null;
  },
}));

void mock.module("../Tooltip/Tooltip", () => ({
  Tooltip: (props: { children: ReactNode }) => <>{props.children}</>,
  TooltipTrigger: (props: { children: ReactNode; asChild?: boolean }) => <>{props.children}</>,
  TooltipContent: (props: { children: ReactNode; side?: string }) => <>{props.children}</>,
}));

import { BranchSelector } from "./BranchSelector";

function bashSuccess(output: string): ExecuteBashResult {
  return {
    success: true,
    data: {
      success: true,
      output,
      exitCode: 0,
      wall_duration_ms: 0,
    },
  };
}

describe("BranchSelector", () => {
  let originalWindow: typeof globalThis.window;
  let originalDocument: typeof globalThis.document;
  let originalLocalStorage: typeof globalThis.localStorage;
  let originalLocation: typeof globalThis.location;

  beforeEach(() => {
    originalWindow = globalThis.window;
    originalDocument = globalThis.document;
    originalLocalStorage = globalThis.localStorage;
    originalLocation = globalThis.location;

    const dom = new GlobalWindow({ url: "https://mux.example.com/" });
    globalThis.window = dom as unknown as Window & typeof globalThis;
    globalThis.document = dom.document as unknown as Document;
    globalThis.localStorage = dom.localStorage;
    globalThis.location = dom.location as unknown as Location;

    mockGitStatus = null;
    invalidateGitStatusMock.mockClear();
    copyToClipboardMock.mockClear();
    mockApi = {
      workspace: {
        executeBash: mock(() => Promise.resolve(bashSuccess(""))),
      },
    };
  });

  afterEach(() => {
    cleanup();
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
    globalThis.localStorage = originalLocalStorage;
    globalThis.location = originalLocation;
  });

  test("uses the workspace name as an interactive fallback until an explicit open resolves the branch", async () => {
    const executeBash = mock((input: ExecuteBashInput) => {
      if (input.script.includes("%(HEAD)")) {
        return Promise.resolve(bashSuccess("*feature/lazy-start\nmain"));
      }
      if (input.script.includes("git remote")) {
        return Promise.resolve(bashSuccess("origin"));
      }
      throw new Error(`Unexpected script: ${input.script}`);
    });
    mockApi = {
      workspace: {
        executeBash,
      },
    };

    const view = render(<BranchSelector workspaceId="ws-1" workspaceName="scratch-workspace" />);

    expect(view.getByRole("button", { name: "scratch-workspace" })).toBeDefined();
    expect(view.queryByLabelText("Copy branch name")).toBeNull();

    fireEvent.click(view.getByRole("button", { name: "scratch-workspace" }));

    await waitFor(() => {
      expect(executeBash.mock.calls).toHaveLength(2);
    });
    await waitFor(() => {
      expect(view.getByLabelText("Copy branch name")).toBeDefined();
    });
    expect(view.getAllByText("feature/lazy-start").length).toBeGreaterThan(0);
    expect(executeBash.mock.calls[0]?.[0].script).toContain("%(HEAD)");
  });
});
