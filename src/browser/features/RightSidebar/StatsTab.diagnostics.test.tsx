import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import { cleanup, render } from "@testing-library/react";

import type { WorkspaceLspDiagnosticsViewState } from "@/browser/stores/WorkspaceStore";

let currentDiagnosticsViewState: WorkspaceLspDiagnosticsViewState = {
  snapshot: null,
  connection: {
    status: "loading",
    errorMessage: null,
  },
};

void mock.module("@/browser/stores/WorkspaceStore", () => ({
  useWorkspaceStatsSnapshot: () => null,
  useWorkspaceLspDiagnosticsViewState: () => currentDiagnosticsViewState,
}));

import { DiagnosticsPanel } from "./StatsTab";

describe("DiagnosticsPanel", () => {
  let originalWindow: typeof globalThis.window;
  let originalDocument: typeof globalThis.document;
  let originalConsoleError: typeof console.error;
  let consoleErrorCalls: unknown[][];

  beforeEach(() => {
    originalWindow = globalThis.window;
    originalDocument = globalThis.document;
    originalConsoleError = console.error;
    consoleErrorCalls = [];

    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
    currentDiagnosticsViewState = {
      snapshot: null,
      connection: {
        status: "loading",
        errorMessage: null,
      },
    };
    console.error = (...args: unknown[]) => {
      consoleErrorCalls.push(args);
    };
  });

  afterEach(() => {
    cleanup();
    currentDiagnosticsViewState = {
      snapshot: null,
      connection: {
        status: "loading",
        errorMessage: null,
      },
    };
    console.error = originalConsoleError;
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
  });

  test("shows a loading state before the first diagnostics snapshot arrives", () => {
    const view = render(<DiagnosticsPanel workspaceId="workspace-1" />);

    expect(view.getByText("Loading diagnostics...")).toBeTruthy();
  });

  test("shows an empty state when the diagnostics snapshot contains no entries", () => {
    currentDiagnosticsViewState = {
      snapshot: {
        workspaceId: "workspace-1",
        diagnostics: [],
      },
      connection: {
        status: "ready",
        errorMessage: null,
      },
    };

    const view = render(<DiagnosticsPanel workspaceId="workspace-1" />);

    expect(view.getByText("No diagnostics for this workspace.")).toBeTruthy();
  });

  test("renders multi-server diagnostics and includes unknown severities in the summary", () => {
    currentDiagnosticsViewState = {
      snapshot: {
        workspaceId: "workspace-1",
        diagnostics: [
          {
            uri: "file:///workspace/src/example.ts",
            path: "/workspace/src/example.ts",
            serverId: "typescript",
            rootUri: "file:///workspace",
            version: 3,
            diagnostics: [
              {
                range: {
                  start: { line: 1, character: 4 },
                  end: { line: 1, character: 10 },
                },
                severity: 1,
                source: "tsserver",
                code: 2322,
                message: "Type 'string' is not assignable to type 'number'.",
              },
              {
                range: {
                  start: { line: 4, character: 2 },
                  end: { line: 4, character: 8 },
                },
                severity: 2,
                source: "eslint",
                code: "no-console",
                message: "Unexpected console statement.",
              },
            ],
            receivedAtMs: 1,
          },
          {
            uri: "file:///workspace/src/example.ts",
            path: "/workspace/src/example.ts",
            serverId: "eslint",
            rootUri: "file:///workspace",
            version: 3,
            diagnostics: [
              {
                range: {
                  start: { line: 6, character: 1 },
                  end: { line: 6, character: 12 },
                },
                source: "eslint",
                code: "custom/rule",
                message: "Use the shared logger helper.",
              },
            ],
            receivedAtMs: 1,
          },
          {
            uri: "file:///workspace/src/utils.ts",
            path: "/workspace/src/utils.ts",
            serverId: "typescript",
            rootUri: "file:///workspace",
            version: 1,
            diagnostics: [
              {
                range: {
                  start: { line: 9, character: 0 },
                  end: { line: 9, character: 4 },
                },
                severity: 3,
                source: "tsserver",
                message: "'helper' is declared but its value is never read.",
              },
            ],
            receivedAtMs: 2,
          },
        ],
      },
      connection: {
        status: "ready",
        errorMessage: null,
      },
    };

    const view = render(<DiagnosticsPanel workspaceId="workspace-1" />);

    expect(view.getAllByText("/workspace/src/example.ts").length).toBe(2);
    expect(view.getByText("/workspace/src/utils.ts")).toBeTruthy();
    expect(view.getByText("Type 'string' is not assignable to type 'number'.")).toBeTruthy();
    expect(view.getByText("Unexpected console statement.")).toBeTruthy();
    expect(view.getByText("Use the shared logger helper.")).toBeTruthy();
    expect(view.getByText("'helper' is declared but its value is never read.")).toBeTruthy();

    expect(view.container.textContent).toContain(
      "4 diagnostics across 3 files · 1 error · 1 warning · 1 information · 1 unknown"
    );
    expect(view.container.textContent).toContain("Server: typescript");
    expect(view.container.textContent).toContain("Server: eslint");
    expect(view.container.textContent).toContain("Error · Line 2, Column 5 · tsserver · Code 2322");
    expect(view.container.textContent).toContain(
      "Warning · Line 5, Column 3 · eslint · Code no-console"
    );
    expect(view.container.textContent).toContain(
      "Unknown · Line 7, Column 2 · eslint · Code custom/rule"
    );
    expect(view.container.textContent).toContain("Information · Line 10, Column 1 · tsserver");
    expect(
      consoleErrorCalls.some((call) =>
        call.some(
          (value) =>
            typeof value === "string" &&
            value.includes("Encountered two children with the same key")
        )
      )
    ).toBe(false);
  });

  test("shows a retrying state when the diagnostics subscription has not produced a snapshot yet", () => {
    currentDiagnosticsViewState = {
      snapshot: null,
      connection: {
        status: "retrying",
        errorMessage: "socket dropped",
      },
    };

    const view = render(<DiagnosticsPanel workspaceId="workspace-1" />);

    expect(view.getByText("Retrying diagnostics subscription...")).toBeTruthy();
    expect(view.getByText("Last error: socket dropped")).toBeTruthy();
    expect(view.queryByText("Loading diagnostics...")).toBeNull();
  });

  test("renders a retry banner while continuing to show the last diagnostics snapshot", () => {
    currentDiagnosticsViewState = {
      snapshot: {
        workspaceId: "workspace-1",
        diagnostics: [
          {
            uri: "file:///workspace/src/example.ts",
            path: "/workspace/src/example.ts",
            serverId: "typescript",
            rootUri: "file:///workspace",
            version: 1,
            diagnostics: [
              {
                range: {
                  start: { line: 0, character: 0 },
                  end: { line: 0, character: 5 },
                },
                severity: 1,
                source: "tsserver",
                message: "stale diagnostic",
              },
            ],
            receivedAtMs: 1,
          },
        ],
      },
      connection: {
        status: "retrying",
        errorMessage: "stream closed unexpectedly",
      },
    };

    const view = render(<DiagnosticsPanel workspaceId="workspace-1" />);

    expect(view.getByText("Retrying diagnostics subscription...")).toBeTruthy();
    expect(view.getByText("Last error: stream closed unexpectedly")).toBeTruthy();
    expect(view.getByText("stale diagnostic")).toBeTruthy();
  });
});
