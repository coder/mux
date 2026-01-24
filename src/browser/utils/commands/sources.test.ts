import { expect, test, mock } from "bun:test";
import { buildCoreSources } from "./sources";
import type { ProjectConfig } from "@/node/config";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { DEFAULT_RUNTIME_CONFIG } from "@/common/constants/workspace";
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
    onSelectWorkspace: () => undefined,
    onRemoveWorkspace: () => Promise.resolve({ success: true }),
    onRenameWorkspace: () => Promise.resolve({ success: true }),
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
