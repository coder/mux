import * as fs from "fs";
import * as fsPromises from "fs/promises";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import { MULTI_PROJECT_CONFIG_KEY } from "@/common/constants/multiProject";
import {
  WORKFLOW_RESULT_METADATA_TYPE,
  WORKFLOW_RUN_CARD_DISPLAY_METADATA_TYPE,
  WORKFLOW_TRIGGER_DISPLAY_METADATA_TYPE,
} from "@/common/utils/workflowRunMessages";
import { Config } from "@/node/config";
import { ServiceContainer } from "./serviceContainer";

function parseJsonObjectLine(line: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(line);
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Expected chat.jsonl line to contain an object");
  }
  return parsed as Record<string, unknown>;
}

function getMuxMetadata(message: Record<string, unknown>): Record<string, unknown> | null {
  const metadata = message.metadata;
  if (metadata == null || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }
  const muxMetadata = (metadata as Record<string, unknown>).muxMetadata;
  if (muxMetadata == null || typeof muxMetadata !== "object" || Array.isArray(muxMetadata)) {
    return null;
  }
  return muxMetadata as Record<string, unknown>;
}

describe("ServiceContainer", () => {
  let tempDir: string;
  let config: Config;
  let services: ServiceContainer | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mux-service-container-test-"));
    config = new Config(tempDir);
  });

  afterEach(async () => {
    if (services) {
      await services.dispose();
      await services.shutdown();
      services = undefined;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("attributes multi-project stream-end analytics to the primary project path", async () => {
    const primaryProjectPath = "/fake/project-a";
    const secondaryProjectPath = "/fake/project-b";
    const workspaceId = "workspace-1";
    const workspaceName = "feature-branch";
    const workspacePath = path.join(config.srcDir, "project-a+project-b", workspaceName);

    await config.editConfig((cfg) => {
      cfg.projects.set(MULTI_PROJECT_CONFIG_KEY, {
        workspaces: [
          {
            path: workspacePath,
            id: workspaceId,
            name: workspaceName,
            parentWorkspaceId: "parent-workspace",
            projects: [
              { projectName: "project-a", projectPath: primaryProjectPath },
              { projectName: "project-b", projectPath: secondaryProjectPath },
            ],
            runtimeConfig: { type: "local" },
          },
        ],
      });
      return cfg;
    });

    services = new ServiceContainer(config);
    const ingestWorkspaceSpy = spyOn(
      services.analyticsService,
      "ingestWorkspace"
    ).mockImplementation(() => undefined);

    services.aiService.emit("stream-end", {
      type: "stream-end",
      workspaceId,
      messageId: "message-1",
      metadata: { model: "openai:gpt-4o" },
      parts: [],
    });

    expect(ingestWorkspaceSpy).toHaveBeenCalledWith(
      workspaceId,
      config.getSessionDir(workspaceId),
      {
        projectPath: primaryProjectPath,
        projectName: path.basename(primaryProjectPath),
        workspaceName,
        parentWorkspaceId: "parent-workspace",
      }
    );
  });

  it("continues the target workspace after an automation workflow finishes", async () => {
    const projectPath = path.join(tempDir, "project");
    const workspaceId = "workspace-1";
    await fsPromises.mkdir(path.join(projectPath, ".mux", "workflows"), { recursive: true });
    await fsPromises.writeFile(
      path.join(projectPath, ".mux", "workflows", "security-scan.js"),
      "// description: Security scan\nexport default function workflow() { return { reportMarkdown: 'scan done' }; }\n",
      "utf-8"
    );
    await config.editConfig((current) => {
      current.projects.set(projectPath, {
        trusted: true,
        workspaces: [
          {
            path: projectPath,
            id: workspaceId,
            name: "main",
            runtimeConfig: { type: "local" },
          },
        ],
        workflowSchedules: [
          {
            id: "schedule-1",
            enabled: true,
            workflowName: "security-scan",
            args: { severity: "high" },
            intervalMs: 60_000,
            target: { type: "existing-workspace", workspaceId },
          },
        ],
      });
      return current;
    });
    services = new ServiceContainer(config);
    spyOn(services.experimentsService, "isExperimentEnabled").mockImplementation(
      (experimentId) => experimentId === EXPERIMENT_IDS.DYNAMIC_WORKFLOWS
    );
    const continuationSpy = spyOn(services.workspaceService, "sendMessage").mockImplementation(() =>
      Promise.resolve({ success: true as const, data: undefined })
    );

    services.workflowSchedulerService.tick();
    await services.workflowSchedulerService.awaitActiveDispatches();

    const chatPath = path.join(config.getSessionDir(workspaceId), "chat.jsonl");
    const messages = (await fsPromises.readFile(chatPath, "utf-8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(parseJsonObjectLine);
    const triggerMessage = messages.find(
      (message) => getMuxMetadata(message)?.type === WORKFLOW_TRIGGER_DISPLAY_METADATA_TYPE
    );
    const cardMessage = messages.find(
      (message) => getMuxMetadata(message)?.type === WORKFLOW_RUN_CARD_DISPLAY_METADATA_TYPE
    );
    if (triggerMessage == null || cardMessage == null) {
      throw new Error("Expected automation trigger and card messages");
    }
    const triggerMetadata = triggerMessage.metadata as Record<string, unknown>;
    const triggerMuxMetadata = getMuxMetadata(triggerMessage);
    const cardMetadata = cardMessage.metadata as Record<string, unknown>;
    const cardMuxMetadata = getMuxMetadata(cardMessage);
    const triggerRunId = triggerMuxMetadata?.runId;
    const cardRunId = cardMuxMetadata?.runId;

    expect(typeof triggerRunId).toBe("string");
    expect(cardRunId).toBe(triggerRunId);
    expect(triggerMessage.role).toBe("user");
    expect(triggerMetadata.synthetic).toBe(true);
    expect(triggerMetadata.uiVisible).toBe(true);
    expect(triggerMuxMetadata).toMatchObject({
      type: WORKFLOW_TRIGGER_DISPLAY_METADATA_TYPE,
      rawCommand: "Automation: security-scan",
    });
    expect(cardMessage.role).toBe("assistant");
    expect(cardMetadata.synthetic).toBe(true);
    expect(cardMetadata.uiVisible).toBe(true);
    expect(cardMuxMetadata).toMatchObject({ type: WORKFLOW_RUN_CARD_DISPLAY_METADATA_TYPE });
    if (!Array.isArray(cardMessage.parts) || cardMessage.parts.length !== 1) {
      throw new Error("Expected automation card to contain one tool part");
    }
    const cardPart = cardMessage.parts[0] as Record<string, unknown>;
    const cardInput = cardPart.input as Record<string, unknown>;
    const cardOutput = cardPart.output as Record<string, unknown>;
    expect(cardPart.type).toBe("dynamic-tool");
    expect(cardPart.toolName).toBe("workflow_run");
    expect(cardInput).toEqual({
      name: "security-scan",
      args: { severity: "high" },
      run_in_background: true,
    });
    const continuationCall = continuationSpy.mock.calls[0];
    if (continuationCall == null) {
      throw new Error("Expected automation completion to trigger a continuation turn");
    }
    expect(continuationCall[0]).toBe(workspaceId);
    expect(continuationCall[1]).toContain("<mux_workflow_result>");
    expect(continuationCall[1]).toContain("scan done");
    expect(continuationCall[2]?.muxMetadata).toMatchObject({
      type: WORKFLOW_RESULT_METADATA_TYPE,
      rawCommand: "Automation: security-scan",
      runId: triggerRunId,
    });
    expect(continuationCall[3]).toMatchObject({
      synthetic: true,
      agentInitiated: true,
      requireIdle: true,
      startStreamInBackground: true,
    });
    expect(cardOutput.status).toBe("pending");
    expect(cardOutput.runId).toBe(triggerRunId);
  });

  it("continues the target workspace after an automation workflow fails", async () => {
    const projectPath = path.join(tempDir, "failing-project");
    const workspaceId = "workspace-fail";
    await fsPromises.mkdir(path.join(projectPath, ".mux", "workflows"), { recursive: true });
    await fsPromises.writeFile(
      path.join(projectPath, ".mux", "workflows", "failing-scan.js"),
      "// description: Failing scan\nexport default function workflow() { throw new Error('scan failed'); }\n",
      "utf-8"
    );
    await config.editConfig((current) => {
      current.projects.set(projectPath, {
        trusted: true,
        workspaces: [
          {
            path: projectPath,
            id: workspaceId,
            name: "main",
            runtimeConfig: { type: "local" },
          },
        ],
        workflowSchedules: [
          {
            id: "schedule-fail",
            enabled: true,
            workflowName: "failing-scan",
            intervalMs: 60_000,
            target: { type: "existing-workspace", workspaceId },
          },
        ],
      });
      return current;
    });
    services = new ServiceContainer(config);
    spyOn(services.experimentsService, "isExperimentEnabled").mockImplementation(
      (experimentId) => experimentId === EXPERIMENT_IDS.DYNAMIC_WORKFLOWS
    );
    const continuationSpy = spyOn(services.workspaceService, "sendMessage").mockImplementation(() =>
      Promise.resolve({ success: true as const, data: undefined })
    );

    services.workflowSchedulerService.tick();
    await services.workflowSchedulerService.awaitActiveDispatches();

    const continuationCall = continuationSpy.mock.calls[0];
    if (continuationCall == null) {
      throw new Error("Expected failing automation to trigger a continuation turn");
    }
    expect(continuationCall[0]).toBe(workspaceId);
    expect(continuationCall[1]).toContain("<mux_workflow_result>");
    expect(continuationCall[2]?.muxMetadata).toMatchObject({
      type: WORKFLOW_RESULT_METADATA_TYPE,
      rawCommand: "Automation: failing-scan",
    });
    expect(continuationCall[3]).toMatchObject({
      synthetic: true,
      agentInitiated: true,
      requireIdle: true,
      startStreamInBackground: true,
    });
  });

  it("does not inherit sub-project scope when creating project automation workspaces", async () => {
    const projectPath = path.join(tempDir, "project-with-subscope-template");
    const subProjectPath = path.join(projectPath, "packages", "api");
    const templateWorkspaceId = "template-workspace";
    await config.editConfig((current) => {
      current.projects.set(projectPath, {
        trusted: true,
        workspaces: [
          {
            path: projectPath,
            id: templateWorkspaceId,
            name: "api-workspace",
            subProjectPath,
            runtimeConfig: { type: "local", srcBaseDir: tempDir },
          },
        ],
        workflowSchedules: [
          {
            id: "schedule-new-workspace",
            enabled: true,
            workflowName: "missing-workflow",
            intervalMs: 60_000,
            target: { type: "new-workspace", trunkBranch: "main" },
          },
        ],
      });
      current.projects.set(subProjectPath, {
        parentProjectPath: projectPath,
        workspaces: [],
      });
      return current;
    });
    services = new ServiceContainer(config);
    spyOn(services.experimentsService, "isExperimentEnabled").mockImplementation(
      (experimentId) => experimentId === EXPERIMENT_IDS.DYNAMIC_WORKFLOWS
    );
    const createSpy = spyOn(services.workspaceService, "create").mockImplementation(() =>
      Promise.resolve({
        success: true as const,
        data: {
          metadata: {
            id: "created-workspace",
            name: "created-workspace",
            projectName: path.basename(projectPath),
            projectPath,
            namedWorkspacePath: path.join(tempDir, "created-workspace"),
            runtimeConfig: { type: "local" as const, srcBaseDir: tempDir },
          },
        },
      })
    );
    spyOn(services.workspaceService, "archive").mockImplementation(() =>
      Promise.resolve({ success: true as const, data: { kind: "archived" as const } })
    );

    services.workflowSchedulerService.tick();
    await services.workflowSchedulerService.awaitActiveDispatches();

    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(createSpy.mock.calls[0]?.[5]).toBeUndefined();
  });

  it("uses parent workspace templates when creating sub-project automation workspaces", async () => {
    const projectPath = path.join(tempDir, "project-with-subproject-schedule");
    const subProjectPath = path.join(projectPath, "packages", "api");
    await config.editConfig((current) => {
      current.projects.set(projectPath, {
        trusted: true,
        workspaces: [
          {
            path: projectPath,
            id: "parent-template",
            name: "parent-template",
            runtimeConfig: { type: "local", srcBaseDir: tempDir },
          },
        ],
      });
      current.projects.set(subProjectPath, {
        parentProjectPath: projectPath,
        workspaces: [],
        workflowSchedules: [
          {
            id: "subproject-schedule",
            enabled: true,
            workflowName: "missing-workflow",
            intervalMs: 60_000,
            target: { type: "new-workspace", trunkBranch: "main" },
          },
        ],
      });
      return current;
    });
    services = new ServiceContainer(config);
    spyOn(services.experimentsService, "isExperimentEnabled").mockImplementation(
      (experimentId) => experimentId === EXPERIMENT_IDS.DYNAMIC_WORKFLOWS
    );
    const createSpy = spyOn(services.workspaceService, "create").mockImplementation(() =>
      Promise.resolve({
        success: true as const,
        data: {
          metadata: {
            id: "created-subproject-workspace",
            name: "created-subproject-workspace",
            projectName: path.basename(projectPath),
            projectPath,
            namedWorkspacePath: path.join(tempDir, "created-subproject-workspace"),
            subProjectPath,
            runtimeConfig: { type: "local" as const, srcBaseDir: tempDir },
          },
        },
      })
    );
    spyOn(services.workspaceService, "archive").mockImplementation(() =>
      Promise.resolve({ success: true as const, data: { kind: "archived" as const } })
    );

    services.workflowSchedulerService.tick();
    await services.workflowSchedulerService.awaitActiveDispatches();

    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(createSpy.mock.calls[0]?.[0]).toBe(subProjectPath);
    expect(createSpy.mock.calls[0]?.[4]).toEqual({ type: "local", srcBaseDir: tempDir });
    expect(createSpy.mock.calls[0]?.[5]).toBeUndefined();
  });

  it("exposes desktopSessionManager in the ORPC context", () => {
    services = new ServiceContainer(config);

    const context = services.toORPCContext();

    expect(context.desktopSessionManager).toBe(services.desktopSessionManager);
  });

  it("closes desktop sessions during shutdown", async () => {
    services = new ServiceContainer(config);
    const closeAllSpy = spyOn(services.desktopSessionManager, "closeAll").mockImplementation(() =>
      Promise.resolve(undefined)
    );

    await services.shutdown();

    expect(closeAllSpy).toHaveBeenCalledTimes(1);
  });

  it("closes desktop sessions during dispose", async () => {
    services = new ServiceContainer(config);
    const closeAllSpy = spyOn(services.desktopSessionManager, "closeAll").mockImplementation(() =>
      Promise.resolve(undefined)
    );

    await services.dispose();

    expect(closeAllSpy).toHaveBeenCalledTimes(1);
  });
});
