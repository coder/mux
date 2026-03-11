import * as fs from "node:fs/promises";
import * as path from "node:path";

import { describe, expect, test } from "bun:test";

import { DEFAULT_RUNTIME_CONFIG } from "@/common/constants/workspace";
import { sliceMessagesFromLatestCompactionBoundary } from "@/common/utils/messages/compactionBoundary";
import { createMuxMessage } from "@/common/types/message";
import type { WorkspaceMetadata } from "@/common/types/workspace";
import type { ProjectsConfig } from "@/common/types/project";
import { DEFAULT_TASK_SETTINGS } from "@/common/types/tasks";
import { getPlanFilePath } from "@/common/utils/planStorage";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import { DisposableTempDir } from "@/node/services/tempDir";

import { buildPlanInstructions, buildStreamSystemContext } from "./streamContextBuilder";

class TestRuntime extends LocalRuntime {
  constructor(
    projectPath: string,
    private readonly muxHomePath: string
  ) {
    super(projectPath);
  }

  override getMuxHome(): string {
    return this.muxHomePath;
  }
}

function createWorkspaceMetadata(args: {
  id: string;
  name: string;
  projectName: string;
  projectPath: string;
  parentWorkspaceId?: string;
}): WorkspaceMetadata {
  return {
    id: args.id,
    name: args.name,
    projectName: args.projectName,
    projectPath: args.projectPath,
    runtimeConfig: DEFAULT_RUNTIME_CONFIG,
    parentWorkspaceId: args.parentWorkspaceId,
  };
}

function createProjectsConfig(args: {
  projectPath: string;
  workspaces: Array<{
    id: string;
    name: string;
    parentWorkspaceId?: string;
  }>;
}): ProjectsConfig {
  return {
    projects: new Map([
      [
        args.projectPath,
        {
          trusted: true,
          workspaces: args.workspaces.map((workspace) => ({
            path: path.join(args.projectPath, workspace.name),
            id: workspace.id,
            name: workspace.name,
            createdAt: "2026-01-01T00:00:00.000Z",
            runtimeConfig: DEFAULT_RUNTIME_CONFIG,
            parentWorkspaceId: workspace.parentWorkspaceId,
          })),
        },
      ],
    ]),
  };
}

async function buildSystemContextForTest(args: {
  runtime: TestRuntime;
  metadata: WorkspaceMetadata;
  workspacePath: string;
  cfg: ProjectsConfig;
  isSubagentWorkspace: boolean;
  effectiveAdditionalInstructions?: string;
  planFilePath?: string;
}) {
  return buildStreamSystemContext({
    runtime: args.runtime,
    metadata: args.metadata,
    workspacePath: args.workspacePath,
    workspaceId: args.metadata.id,
    agentDefinition: { id: "exec" },
    agentDiscoveryPath: args.workspacePath,
    isSubagentWorkspace: args.isSubagentWorkspace,
    effectiveAdditionalInstructions: args.effectiveAdditionalInstructions,
    planFilePath: args.planFilePath,
    modelString: "openai:gpt-5.2",
    cfg: args.cfg,
    providersConfig: null,
    mcpServers: {},
  });
}

describe("buildPlanInstructions", () => {
  test("prepends runtime plan file guidance ahead of caller additional instructions", async () => {
    using tempRoot = new DisposableTempDir("stream-context-builder");

    const projectPath = path.join(tempRoot.path, "project");
    const muxHome = path.join(tempRoot.path, "mux-home");
    await fs.mkdir(projectPath, { recursive: true });
    await fs.mkdir(muxHome, { recursive: true });

    const metadata: WorkspaceMetadata = {
      id: "ws-1",
      name: "workspace-1",
      projectName: "project-1",
      projectPath,
      runtimeConfig: DEFAULT_RUNTIME_CONFIG,
    };

    const runtime = new TestRuntime(projectPath, muxHome);
    const requestPayloadMessages = [createMuxMessage("u1", "user", "plan the fix")];
    const callerInstructions = "Caller-specific plan note";

    const expectedPlanFilePath = getPlanFilePath(metadata.name, metadata.projectName, muxHome);

    const result = await buildPlanInstructions({
      runtime,
      metadata,
      workspaceId: metadata.id,
      workspacePath: projectPath,
      effectiveMode: "plan",
      effectiveAgentId: "plan",
      agentIsPlanLike: true,
      agentDiscoveryPath: projectPath,
      additionalSystemInstructions: callerInstructions,
      shouldDisableTaskToolsForDepth: false,
      taskDepth: 0,
      taskSettings: DEFAULT_TASK_SETTINGS,
      requestPayloadMessages,
    });

    expect(result.effectiveAdditionalInstructions).toContain(
      `Plan file path: ${expectedPlanFilePath}`
    );
    expect(result.effectiveAdditionalInstructions).toContain(callerInstructions);
    expect(result.effectiveAdditionalInstructions).toContain("propose_plan");
    expect(
      result.effectiveAdditionalInstructions?.indexOf(`Plan file path: ${expectedPlanFilePath}`)
    ).toBeLessThan(
      result.effectiveAdditionalInstructions?.indexOf(callerInstructions) ??
        Number.POSITIVE_INFINITY
    );
  });

  test("uses request payload history for Start Here detection", async () => {
    using tempRoot = new DisposableTempDir("stream-context-builder");

    const projectPath = path.join(tempRoot.path, "project");
    const muxHome = path.join(tempRoot.path, "mux-home");
    await fs.mkdir(projectPath, { recursive: true });
    await fs.mkdir(muxHome, { recursive: true });

    const metadata: WorkspaceMetadata = {
      id: "ws-1",
      name: "workspace-1",
      projectName: "project-1",
      projectPath,
      runtimeConfig: DEFAULT_RUNTIME_CONFIG,
    };

    const runtime = new TestRuntime(projectPath, muxHome);

    const planFilePath = getPlanFilePath(metadata.name, metadata.projectName, muxHome);
    await fs.mkdir(path.dirname(planFilePath), { recursive: true });
    await fs.writeFile(planFilePath, "# Plan\n\n- Keep implementing", "utf-8");

    const startHereSummary = createMuxMessage(
      "start-here",
      "assistant",
      "# Start Here\n\n- Existing plan context\n\n*Plan file preserved at:* /tmp/plan.md",
      {
        compacted: "user",
        agentId: "plan",
      }
    );

    const compactionBoundary = createMuxMessage("boundary", "assistant", "Compacted summary", {
      compacted: "user",
      compactionBoundary: true,
      compactionEpoch: 1,
    });

    const latestUserMessage = createMuxMessage("u1", "user", "continue implementation");

    const fullHistory = [startHereSummary, compactionBoundary, latestUserMessage];
    const requestPayloadMessages = sliceMessagesFromLatestCompactionBoundary(fullHistory);

    expect(requestPayloadMessages.map((message) => message.id)).toEqual(["boundary", "u1"]);

    const fromSlicedPayload = await buildPlanInstructions({
      runtime,
      metadata,
      workspaceId: metadata.id,
      workspacePath: projectPath,
      effectiveMode: "exec",
      effectiveAgentId: "exec",
      agentIsPlanLike: false,
      agentDiscoveryPath: projectPath,
      additionalSystemInstructions: undefined,
      shouldDisableTaskToolsForDepth: false,
      taskDepth: 0,
      taskSettings: DEFAULT_TASK_SETTINGS,
      requestPayloadMessages,
    });

    const fromFullHistory = await buildPlanInstructions({
      runtime,
      metadata,
      workspaceId: metadata.id,
      workspacePath: projectPath,
      effectiveMode: "exec",
      effectiveAgentId: "exec",
      agentIsPlanLike: false,
      agentDiscoveryPath: projectPath,
      additionalSystemInstructions: undefined,
      shouldDisableTaskToolsForDepth: false,
      taskDepth: 0,
      taskSettings: DEFAULT_TASK_SETTINGS,
      requestPayloadMessages: fullHistory,
    });

    expect(fromSlicedPayload.effectiveAdditionalInstructions).toContain(
      `A plan file exists at: ${fromSlicedPayload.planFilePath}`
    );
    expect(fromFullHistory.effectiveAdditionalInstructions).toBeUndefined();
  });
});

describe("buildStreamSystemContext", () => {
  test("includes the direct parent plan path ahead of caller instructions", async () => {
    using tempRoot = new DisposableTempDir("stream-system-context");

    const projectPath = path.join(tempRoot.path, "project");
    const muxHome = path.join(tempRoot.path, "mux-home");
    await fs.mkdir(projectPath, { recursive: true });
    await fs.mkdir(muxHome, { recursive: true });

    const metadata = createWorkspaceMetadata({
      id: "child-ws",
      name: "child-workspace",
      projectName: "project",
      projectPath,
      parentWorkspaceId: "parent-ws",
    });
    const cfg = createProjectsConfig({
      projectPath,
      workspaces: [
        { id: "parent-ws", name: "parent-workspace" },
        { id: metadata.id, name: metadata.name, parentWorkspaceId: metadata.parentWorkspaceId },
      ],
    });

    const parentPlanPath = getPlanFilePath("parent-workspace", "project", muxHome);
    const result = await buildSystemContextForTest({
      runtime: new TestRuntime(projectPath, muxHome),
      metadata,
      workspacePath: projectPath,
      cfg,
      isSubagentWorkspace: true,
      effectiveAdditionalInstructions: "Caller-specific note",
    });

    expect(result.ancestorPlanFilePaths).toEqual([parentPlanPath]);
    expect(result.systemMessage).toContain("Ancestor plan file paths (nearest parent first):");
    expect(result.systemMessage).toContain(
      "If useful for broader context, you may read these ancestor/parent plan files:"
    );
    expect(result.systemMessage).toContain(`- parent-workspace: ${parentPlanPath}`);
    expect(result.systemMessage).toContain("Caller-specific note");
    expect(result.systemMessage.indexOf(parentPlanPath)).toBeLessThan(
      result.systemMessage.indexOf("Caller-specific note")
    );
  });

  test("lists nested ancestor plan paths in nearest-parent-first order", async () => {
    using tempRoot = new DisposableTempDir("stream-system-context");

    const projectPath = path.join(tempRoot.path, "project");
    const muxHome = path.join(tempRoot.path, "mux-home");
    await fs.mkdir(projectPath, { recursive: true });
    await fs.mkdir(muxHome, { recursive: true });

    const metadata = createWorkspaceMetadata({
      id: "grandchild-ws",
      name: "grandchild-workspace",
      projectName: "project",
      projectPath,
      parentWorkspaceId: "child-ws",
    });
    const cfg = createProjectsConfig({
      projectPath,
      workspaces: [
        { id: "parent-ws", name: "parent-workspace" },
        { id: "child-ws", name: "child-workspace", parentWorkspaceId: "parent-ws" },
        { id: metadata.id, name: metadata.name, parentWorkspaceId: metadata.parentWorkspaceId },
      ],
    });

    const childPlanPath = getPlanFilePath("child-workspace", "project", muxHome);
    const parentPlanPath = getPlanFilePath("parent-workspace", "project", muxHome);
    const result = await buildSystemContextForTest({
      runtime: new TestRuntime(projectPath, muxHome),
      metadata,
      workspacePath: projectPath,
      cfg,
      isSubagentWorkspace: true,
    });

    expect(result.ancestorPlanFilePaths).toEqual([childPlanPath, parentPlanPath]);
    expect(result.systemMessage).toContain(`- child-workspace: ${childPlanPath}`);
    expect(result.systemMessage).toContain(`- parent-workspace: ${parentPlanPath}`);
    expect(result.systemMessage.indexOf(childPlanPath)).toBeLessThan(
      result.systemMessage.indexOf(parentPlanPath)
    );
  });

  test("omits ancestor plan paths for top-level workspaces", async () => {
    using tempRoot = new DisposableTempDir("stream-system-context");

    const projectPath = path.join(tempRoot.path, "project");
    const muxHome = path.join(tempRoot.path, "mux-home");
    await fs.mkdir(projectPath, { recursive: true });
    await fs.mkdir(muxHome, { recursive: true });

    const metadata = createWorkspaceMetadata({
      id: "top-level-ws",
      name: "top-level-workspace",
      projectName: "project",
      projectPath,
    });
    const cfg = createProjectsConfig({
      projectPath,
      workspaces: [{ id: metadata.id, name: metadata.name }],
    });

    const result = await buildSystemContextForTest({
      runtime: new TestRuntime(projectPath, muxHome),
      metadata,
      workspacePath: projectPath,
      cfg,
      isSubagentWorkspace: false,
      effectiveAdditionalInstructions: "Top-level note",
    });

    expect(result.ancestorPlanFilePaths).toEqual([]);
    expect(result.systemMessage).not.toContain("Ancestor plan file paths (nearest parent first):");
    expect(result.systemMessage).toContain("Top-level note");
  });

  test("omits the ancestor section when the parent metadata is missing", async () => {
    using tempRoot = new DisposableTempDir("stream-system-context");

    const projectPath = path.join(tempRoot.path, "project");
    const muxHome = path.join(tempRoot.path, "mux-home");
    await fs.mkdir(projectPath, { recursive: true });
    await fs.mkdir(muxHome, { recursive: true });

    const metadata = createWorkspaceMetadata({
      id: "child-ws",
      name: "child-workspace",
      projectName: "project",
      projectPath,
      parentWorkspaceId: "missing-parent-ws",
    });
    const cfg = createProjectsConfig({
      projectPath,
      workspaces: [
        { id: metadata.id, name: metadata.name, parentWorkspaceId: metadata.parentWorkspaceId },
      ],
    });

    const result = await buildSystemContextForTest({
      runtime: new TestRuntime(projectPath, muxHome),
      metadata,
      workspacePath: projectPath,
      cfg,
      isSubagentWorkspace: true,
      effectiveAdditionalInstructions: "Existing note",
    });

    expect(result.ancestorPlanFilePaths).toEqual([]);
    expect(result.systemMessage).not.toContain("Ancestor plan file paths (nearest parent first):");
    expect(result.systemMessage).toContain("Existing note");
  });

  test("dedupes ancestor plan paths that are already covered by the active plan file", async () => {
    using tempRoot = new DisposableTempDir("stream-system-context");

    const projectPath = path.join(tempRoot.path, "project");
    const muxHome = path.join(tempRoot.path, "mux-home");
    await fs.mkdir(projectPath, { recursive: true });
    await fs.mkdir(muxHome, { recursive: true });

    const metadata = createWorkspaceMetadata({
      id: "child-ws",
      name: "child-workspace",
      projectName: "project",
      projectPath,
      parentWorkspaceId: "parent-ws",
    });
    const cfg = createProjectsConfig({
      projectPath,
      workspaces: [
        { id: "parent-ws", name: "parent-workspace" },
        { id: metadata.id, name: metadata.name, parentWorkspaceId: metadata.parentWorkspaceId },
      ],
    });

    const parentPlanPath = getPlanFilePath("parent-workspace", "project", muxHome);
    const result = await buildSystemContextForTest({
      runtime: new TestRuntime(projectPath, muxHome),
      metadata,
      workspacePath: projectPath,
      cfg,
      isSubagentWorkspace: true,
      planFilePath: parentPlanPath,
    });

    expect(result.ancestorPlanFilePaths).toEqual([]);
    expect(result.systemMessage).not.toContain("Ancestor plan file paths (nearest parent first):");
    expect(result.systemMessage).not.toContain(parentPlanPath);
  });

  test("truncates cyclic ancestry without crashing", async () => {
    using tempRoot = new DisposableTempDir("stream-system-context");

    const projectPath = path.join(tempRoot.path, "project");
    const muxHome = path.join(tempRoot.path, "mux-home");
    await fs.mkdir(projectPath, { recursive: true });
    await fs.mkdir(muxHome, { recursive: true });

    const metadata = createWorkspaceMetadata({
      id: "child-ws",
      name: "child-workspace",
      projectName: "project",
      projectPath,
      parentWorkspaceId: "parent-ws",
    });
    const cfg = createProjectsConfig({
      projectPath,
      workspaces: [
        { id: "parent-ws", name: "parent-workspace", parentWorkspaceId: metadata.id },
        { id: metadata.id, name: metadata.name, parentWorkspaceId: metadata.parentWorkspaceId },
      ],
    });

    const parentPlanPath = getPlanFilePath("parent-workspace", "project", muxHome);
    const result = await buildSystemContextForTest({
      runtime: new TestRuntime(projectPath, muxHome),
      metadata,
      workspacePath: projectPath,
      cfg,
      isSubagentWorkspace: true,
    });

    expect(result.ancestorPlanFilePaths).toEqual([parentPlanPath]);
    expect(result.systemMessage).toContain("Ancestor plan file paths (nearest parent first):");
    expect(result.systemMessage).toContain(`- parent-workspace: ${parentPlanPath}`);
    expect(result.systemMessage).not.toContain(
      `- child-workspace: ${getPlanFilePath(metadata.name, "project", muxHome)}`
    );
  });
});
