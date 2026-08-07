import { afterEach, beforeEach, describe, expect, mock, setSystemTime, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";
import { useEffect, type ReactElement } from "react";

import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import { ThemeProvider } from "@/browser/contexts/ThemeContext";
import { MessageListProvider } from "@/browser/features/Messages/MessageListContext";
import { ToolNameProvider } from "@/browser/features/Messages/ToolNameContext";
import { useWorkspaceStoreRaw } from "@/browser/stores/WorkspaceStore";
import {
  ProjectWorkspaceListToolCall,
  toProjectWorkspaceListView,
} from "./ProjectWorkspaceListToolCall";

const TEST_WORKSPACE_ID = "project-workspace-list-test";

function renderWithProviders(
  ui: ReactElement,
  onNavigate: (workspaceId: string) => void = () => undefined
) {
  function NavigationInstaller() {
    const store = useWorkspaceStoreRaw();
    useEffect(() => {
      store.setNavigateToWorkspace(onNavigate);
      return () => store.setNavigateToWorkspace(() => undefined);
    }, [store]);
    return null;
  }

  return render(
    <ThemeProvider forcedTheme="dark">
      <MessageListProvider value={{ workspaceId: TEST_WORKSPACE_ID, latestMessageId: null }}>
        <ToolNameProvider toolName="project_workspace_list">
          <TooltipProvider>
            <NavigationInstaller />
            {ui}
          </TooltipProvider>
        </ToolNameProvider>
      </MessageListProvider>
    </ThemeProvider>
  );
}

describe("ProjectWorkspaceListToolCall", () => {
  beforeEach(() => {
    setSystemTime(new Date("2026-08-06T04:00:00.000Z"));
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
  });

  afterEach(() => {
    cleanup();
    setSystemTime();
    globalThis.window = undefined as unknown as Window & typeof globalThis;
    globalThis.document = undefined as unknown as Document;
  });

  test("unwraps valid results and self-heals malformed output", () => {
    const result = {
      projectPath: "/projects/demo",
      availableProjects: [
        { projectPath: "/projects/demo", displayName: "Demo", kind: "parent" as const },
      ],
      workspaces: [
        {
          workspaceId: "ws-active",
          name: "feature-a",
          projectPath: "/projects/demo",
          projectDisplayName: "Demo",
          subProjectPath: null,
          archived: false,
        },
      ],
    };

    expect(toProjectWorkspaceListView({ type: "json", value: result })).toEqual({
      kind: "workspaces",
      result,
    });
    expect(toProjectWorkspaceListView({ malformed: true })).toEqual({ kind: "none" });
    expect(toProjectWorkspaceListView({ success: false, error: "Forbidden" })).toEqual({
      kind: "error",
      error: "Forbidden",
    });
  });

  test("renders lifecycle and turn state while only active workspaces drill down", () => {
    const onNavigate = mock((_workspaceId: string) => undefined);
    const view = renderWithProviders(
      <ProjectWorkspaceListToolCall
        args={{ include_archived: true }}
        status="completed"
        defaultExpanded
        result={{
          projectPath: "/projects/demo",
          availableProjects: [
            { projectPath: "/projects/demo", displayName: "Demo", kind: "parent" },
            {
              projectPath: "/projects/demo/packages/a-very-long-child-project-name",
              displayName: "A very long child project display name that must truncate",
              kind: "sub_project",
            },
          ],
          workspaces: [
            {
              workspaceId: "ws-active",
              name: "feature-a",
              projectPath: "/projects/demo",
              projectDisplayName: "Demo",
              subProjectPath: null,
              title: "Implement orchestration",
              archived: false,
              updatedAt: "2026-08-06T03:00:00.000Z",
              runtimeConfig: { type: "worktree", srcBaseDir: "/tmp/src" },
              execAiSettings: {
                model: "openai:gpt-5.6-sol",
                thinkingLevel: "high",
                reasoningMode: "pro",
              },
              workspaceTurn: {
                taskId: "wst_active",
                status: "running",
                prompt: "Continue the active implementation",
                updatedAt: "2026-08-06T02:00:00.000Z",
              },
            },
            {
              workspaceId: "ws-archived",
              name: "feature-b",
              projectPath: "/projects/demo/packages/a-very-long-child-project-name",
              projectDisplayName: "A very long child project display name that must truncate",
              subProjectPath: "/projects/demo/packages/a-very-long-child-project-name",
              archived: true,
              transcriptOnly: true,
              workspaceTurn: {
                taskId: "wst_done",
                status: "completed",
                updatedAt: "2026-08-06T02:00:00.000Z",
              },
            },
          ],
        }}
      />,
      onNavigate
    );

    expect(view.getByText("Implement orchestration")).toBeTruthy();
    expect(view.getByText("Demo")).toBeTruthy();
    expect(
      view.getByText("A very long child project display name that must truncate")
    ).toBeTruthy();
    expect(view.getByText("Running")).toBeTruthy();
    expect(view.getByText("worktree")).toBeTruthy();
    expect(view.getByText("Exec: openai:gpt-5.6-sol · high · pro")).toBeTruthy();
    expect(view.getByText("Continue the active implementation")).toBeTruthy();
    expect(view.getByText("Updated 1 hour ago")).toBeTruthy();
    expect(view.getByText("Archived")).toBeTruthy();
    expect(view.getByText("Transcript only")).toBeTruthy();

    fireEvent.click(
      view.getByRole("button", { name: "Open workspace Implement orchestration in Demo" })
    );
    expect(onNavigate).toHaveBeenCalledWith("ws-active");
    expect(
      view.queryByRole("button", {
        name: "Open workspace feature-b in A very long child project display name that must truncate",
      })
    ).toBeNull();
  });
});
