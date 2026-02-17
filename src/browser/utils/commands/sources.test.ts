import { expect, test, mock } from "bun:test";
import { buildCoreSources } from "./sources";
import type { ProjectConfig } from "@/node/config";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { DEFAULT_RUNTIME_CONFIG } from "@/common/constants/workspace";
import { GlobalWindow } from "happy-dom";
import { CUSTOM_EVENTS } from "@/common/constants/events";
import { MUX_HELP_CHAT_WORKSPACE_ID } from "@/common/constants/muxChat";
import type { APIClient } from "@/browser/contexts/API";

const mk = (over: Partial<Parameters<typeof buildCoreSources>[0]> = {}) => {
  const projects = new Map<string, ProjectConfig>();
  projects.set("/repo/a", {
    workspaces: [{ path: "/repo/a/feat-x" }, { path: "/repo/a/feat-y" }],
  });
  const workspaceMetadata = new Map<string, FrontendWorkspaceMetadata>();
  workspaceMetadata.set("w1", {
    id: "w1",
    name: "feat-x",
    projectName: "a",
    projectPath: "/repo/a",
    namedWorkspacePath: "/repo/a/feat-x",
    runtimeConfig: DEFAULT_RUNTIME_CONFIG,
  });
  workspaceMetadata.set("w2", {
    id: "w2",
    name: "feat-y",
    projectName: "a",
    projectPath: "/repo/a",
    namedWorkspacePath: "/repo/a/feat-y",
    runtimeConfig: DEFAULT_RUNTIME_CONFIG,
  });
  const params: Parameters<typeof buildCoreSources>[0] = {
    projects,
    theme: "dark",
    workspaceMetadata,
    selectedWorkspace: {
      projectPath: "/repo/a",
      projectName: "a",
      namedWorkspacePath: "/repo/a/feat-x",
      workspaceId: "w1",
    },
    streamingModels: new Map<string, string>(),
    getThinkingLevel: () => "off",
    onSetThinkingLevel: () => undefined,
    onStartWorkspaceCreation: () => undefined,
    onArchiveMergedWorkspacesInProject: () => Promise.resolve(),
    onSelectWorkspace: () => undefined,
    onRemoveWorkspace: () => Promise.resolve({ success: true }),
    onUpdateTitle: () => Promise.resolve({ success: true }),
    onAddProject: () => undefined,
    onRemoveProject: () => undefined,
    onToggleSidebar: () => undefined,
    onNavigateWorkspace: () => undefined,
    onOpenWorkspaceInTerminal: () => undefined,
    onToggleTheme: () => undefined,
    onSetTheme: () => undefined,
    api: {
      workspace: {
        truncateHistory: () => Promise.resolve({ success: true, data: undefined }),
        interruptStream: () => Promise.resolve({ success: true, data: undefined }),
      },
    } as unknown as APIClient,
    getBranchesForProject: () =>
      Promise.resolve({
        branches: ["main"],
        recommendedTrunk: "main",
      }),
    ...over,
  };
  return buildCoreSources(params);
};

test("buildCoreSources includes create/switch workspace actions", () => {
  const sources = mk();
  const actions = sources.flatMap((s) => s());
  const titles = actions.map((a) => a.title);
  expect(titles.some((t) => t.startsWith("Create New Workspace"))).toBe(true);
  // Workspace switcher shows workspace name (or title) as primary label
  expect(titles.some((t) => t.includes("feat-x") || t.includes("feat-y"))).toBe(true);
  expect(titles.includes("Right Sidebar: Split Horizontally")).toBe(true);
  expect(titles.includes("Right Sidebar: Split Vertically")).toBe(true);
  expect(titles.includes("Right Sidebar: Add Tool…")).toBe(true);
  expect(titles.includes("Right Sidebar: Focus Terminal")).toBe(true);
  expect(titles.includes("New Terminal Window")).toBe(true);
  expect(titles.includes("Open Terminal Window for Workspace…")).toBe(true);
});

test("buildCoreSources adds thinking effort command", () => {
  const sources = mk({ getThinkingLevel: () => "medium" });
  const actions = sources.flatMap((s) => s());
  const thinkingAction = actions.find((a) => a.id === "thinking:set-level");

  expect(thinkingAction).toBeDefined();
  expect(thinkingAction?.subtitle).toContain("Medium");
});

test("workspace switch commands include keywords for filtering", () => {
  const sources = mk();
  const actions = sources.flatMap((s) => s());
  const switchAction = actions.find((a) => a.id.startsWith("ws:switch:"));

  expect(switchAction).toBeDefined();
  expect(switchAction?.keywords).toBeDefined();
  // Keywords should include name, projectName for matching
  expect(switchAction?.keywords).toContain("feat-x");
  expect(switchAction?.keywords).toContain("a"); // projectName from mk()
});

test("workspace switch with title shows title as primary label", () => {
  const workspaceMetadata = new Map<string, FrontendWorkspaceMetadata>([
    [
      "w-titled",
      {
        id: "w-titled",
        name: "feature-branch",
        projectPath: "/proj",
        projectName: "my-project",
        namedWorkspacePath: "/proj/feature-branch",
        createdAt: "2024-01-01T00:00:00Z",
        runtimeConfig: DEFAULT_RUNTIME_CONFIG,
        title: "Fix login button styling",
      },
    ],
  ]);
  const sources = mk({ workspaceMetadata });
  const actions = sources.flatMap((s) => s());
  const switchAction = actions.find((a) => a.id === "ws:switch:w-titled");

  expect(switchAction).toBeDefined();
  // Title should be primary label
  expect(switchAction?.title).toContain("Fix login button styling");
  // Subtitle should include name and project
  expect(switchAction?.subtitle).toContain("feature-branch");
  expect(switchAction?.subtitle).toContain("my-project");
  // Keywords should include both title and name for filtering
  expect(switchAction?.keywords).toContain("feature-branch");
  expect(switchAction?.keywords).toContain("my-project");
  expect(switchAction?.keywords).toContain("Fix login button styling");
});

test("thinking effort command submits selected level", async () => {
  const onSetThinkingLevel = mock();
  const sources = mk({ onSetThinkingLevel, getThinkingLevel: () => "low" });
  const actions = sources.flatMap((s) => s());
  const thinkingAction = actions.find((a) => a.id === "thinking:set-level");

  expect(thinkingAction?.prompt).toBeDefined();
  await thinkingAction!.prompt!.onSubmit({ thinkingLevel: "high" });

  expect(onSetThinkingLevel).toHaveBeenCalledWith("w1", "high");
});

test("buildCoreSources includes archive merged workspaces in project action", () => {
  const sources = mk();
  const actions = sources.flatMap((s) => s());
  const archiveAction = actions.find((a) => a.id === "ws:archive-merged-in-project");

  expect(archiveAction).toBeDefined();
  expect(archiveAction?.title).toBe("Archive Merged Workspaces in Project…");
});

test("archive merged workspaces prompt submits selected project", async () => {
  const onArchiveMergedWorkspacesInProject = mock(() => Promise.resolve());
  const sources = mk({ onArchiveMergedWorkspacesInProject });
  const actions = sources.flatMap((s) => s());
  const archiveAction = actions.find((a) => a.id === "ws:archive-merged-in-project");

  expect(archiveAction).toBeDefined();
  expect(archiveAction?.prompt).toBeDefined();

  // buildCoreSources uses confirm(...) in onSubmit.
  const originalConfirm = (globalThis as unknown as { confirm?: typeof confirm }).confirm;
  (globalThis as unknown as { confirm: typeof confirm }).confirm = () => true;
  try {
    await archiveAction!.prompt!.onSubmit({ projectPath: "/repo/a" });
  } finally {
    if (originalConfirm) {
      (globalThis as unknown as { confirm: typeof confirm }).confirm = originalConfirm;
    } else {
      delete (globalThis as unknown as { confirm?: typeof confirm }).confirm;
    }
  }

  expect(onArchiveMergedWorkspacesInProject).toHaveBeenCalledTimes(1);
  expect(onArchiveMergedWorkspacesInProject).toHaveBeenCalledWith("/repo/a");
});

test("workspace generate title command is hidden for Chat with Mux workspace", () => {
  const sources = mk({
    selectedWorkspace: {
      projectPath: "/repo/a",
      projectName: "a",
      namedWorkspacePath: "/repo/a/mux-help",
      workspaceId: MUX_HELP_CHAT_WORKSPACE_ID,
    },
  });
  const actions = sources.flatMap((s) => s());

  expect(actions.some((action) => action.id === "ws:generate-title")).toBe(false);
});

test("workspace generate title command dispatches a title-generation request event", async () => {
  const testWindow = new GlobalWindow();
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  const originalCustomEvent = globalThis.CustomEvent;

  globalThis.window = testWindow as unknown as Window & typeof globalThis;
  globalThis.document = testWindow.document as unknown as Document;
  globalThis.CustomEvent = testWindow.CustomEvent as unknown as typeof CustomEvent;

  const receivedWorkspaceIds: string[] = [];
  const handleRequest = (event: Event) => {
    const detail = (event as CustomEvent<{ workspaceId: string }>).detail;
    receivedWorkspaceIds.push(detail.workspaceId);
  };

  window.addEventListener(CUSTOM_EVENTS.WORKSPACE_GENERATE_TITLE_REQUESTED, handleRequest);

  try {
    const sources = mk();
    const actions = sources.flatMap((s) => s());
    const generateTitleAction = actions.find((a) => a.id === "ws:generate-title");

    expect(generateTitleAction).toBeDefined();

    await generateTitleAction!.run();

    expect(receivedWorkspaceIds).toEqual(["w1"]);
  } finally {
    window.removeEventListener(CUSTOM_EVENTS.WORKSPACE_GENERATE_TITLE_REQUESTED, handleRequest);
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
    globalThis.CustomEvent = originalCustomEvent;
  }
});
