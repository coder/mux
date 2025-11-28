import { buildCoreSources } from "./sources";
import type { ProjectConfig } from "@/node/config";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { DEFAULT_RUNTIME_CONFIG } from "@/common/constants/workspace";

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
  expect(titles.some((t) => t.includes("Switch to "))).toBe(true);
  expect(titles.includes("Open Current Workspace in Terminal")).toBe(true);
  expect(titles.includes("Open Workspace in Terminal…")).toBe(true);
});

test("buildCoreSources adds thinking effort command", () => {
  const sources = mk({ getThinkingLevel: () => "medium" });
  const actions = sources.flatMap((s) => s());
  const thinkingAction = actions.find((a) => a.id === "thinking:set-level");

  expect(thinkingAction).toBeDefined();
  expect(thinkingAction?.subtitle).toContain("Medium");
});

test("thinking effort command submits selected level", async () => {
  const onSetThinkingLevel = jest.fn();
  const sources = mk({ onSetThinkingLevel, getThinkingLevel: () => "low" });
  const actions = sources.flatMap((s) => s());
  const thinkingAction = actions.find((a) => a.id === "thinking:set-level");

  expect(thinkingAction?.prompt).toBeDefined();
  await thinkingAction!.prompt!.onSubmit({ thinkingLevel: "high" });

  expect(onSetThinkingLevel).toHaveBeenCalledWith("w1", "high");
});
