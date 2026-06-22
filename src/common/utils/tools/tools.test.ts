/* eslint-disable @typescript-eslint/require-await */
import { describe, expect, mock, test } from "bun:test";
import { z } from "zod";

import { Ok } from "@/common/types/result";
import type { InitStateManager } from "@/node/services/initStateManager";
import type { DesktopSessionManager } from "@/node/services/desktop/DesktopSessionManager";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import { getToolsForModel, type WorkspaceHeartbeatToolService } from "./tools";

const DESKTOP_TOOL_NAMES = [
  "desktop_screenshot",
  "desktop_move_mouse",
  "desktop_click",
  "desktop_double_click",
  "desktop_drag",
  "desktop_scroll",
  "desktop_type",
  "desktop_key_press",
] as const;

function createInitStateManager(): InitStateManager {
  return {
    waitForInit: () => Promise.resolve(),
  } as unknown as InitStateManager;
}

function createDesktopSessionManager(options: { available: boolean }) {
  const getCapability = mock(() =>
    Promise.resolve(
      options.available
        ? {
            available: true as const,
            width: 1920,
            height: 1080,
            sessionId: "desktop:test-workspace",
          }
        : {
            available: false as const,
            reason: "disabled" as const,
          }
    )
  );

  return {
    desktopSessionManager: {
      getCapability,
      screenshot: mock(() =>
        Promise.resolve({
          imageBase64: "cG5nLWRhdGE=",
          mimeType: "image/png" as const,
          width: 1920,
          height: 1080,
        })
      ),
      action: mock(() => Promise.resolve({ success: true as const })),
    } as unknown as DesktopSessionManager,
    getCapability,
  };
}

describe("getToolsForModel", () => {
  test("only includes agent_report when enableAgentReport=true", async () => {
    const runtime = new LocalRuntime(process.cwd());
    const initStateManager = createInitStateManager();

    const toolsWithoutReport = await getToolsForModel(
      "noop:model",
      {
        cwd: process.cwd(),
        runtime,
        runtimeTempDir: "/tmp",
        enableAgentReport: false,
      },
      "ws-1",
      initStateManager
    );
    expect(toolsWithoutReport.agent_report).toBeUndefined();

    const toolsWithReport = await getToolsForModel(
      "noop:model",
      {
        cwd: process.cwd(),
        runtime,
        runtimeTempDir: "/tmp",
        enableAgentReport: true,
      },
      "ws-1",
      initStateManager
    );
    expect(toolsWithReport.agent_report).toBeDefined();
  });

  test("includes heartbeat only when the heartbeat service and experiment are configured", async () => {
    const runtime = new LocalRuntime(process.cwd());
    const initStateManager = createInitStateManager();

    const toolsWithoutHeartbeat = await getToolsForModel(
      "noop:model",
      {
        cwd: process.cwd(),
        runtime,
        runtimeTempDir: "/tmp",
        workspaceId: "ws-1",
        experiments: { workspaceHeartbeats: true },
      },
      "ws-1",
      initStateManager
    );
    expect(toolsWithoutHeartbeat.heartbeat).toBeUndefined();

    const heartbeatService: WorkspaceHeartbeatToolService = {
      getHeartbeatSettings: mock(() => null),
      setHeartbeatSettings: mock(() =>
        Promise.resolve(
          Ok({ enabled: true, intervalMs: 30 * 60 * 1000, contextMode: "normal" as const })
        )
      ),
      unsetHeartbeatSettings: mock(() => Promise.resolve(Ok(undefined))),
    };
    const toolsWithExperimentDisabled = await getToolsForModel(
      "noop:model",
      {
        cwd: process.cwd(),
        runtime,
        runtimeTempDir: "/tmp",
        workspaceId: "ws-1",
        workspaceHeartbeatService: heartbeatService,
      },
      "ws-1",
      initStateManager
    );
    expect(toolsWithExperimentDisabled.heartbeat).toBeUndefined();

    const toolsWithHeartbeat = await getToolsForModel(
      "noop:model",
      {
        cwd: process.cwd(),
        runtime,
        runtimeTempDir: "/tmp",
        workspaceId: "ws-1",
        experiments: { workspaceHeartbeats: true },
        workspaceHeartbeatService: heartbeatService,
      },
      "ws-1",
      initStateManager
    );
    const childToolsWithHeartbeat = await getToolsForModel(
      "noop:model",
      {
        cwd: process.cwd(),
        runtime,
        runtimeTempDir: "/tmp",
        workspaceId: "child-ws",
        enableAgentReport: true,
        experiments: { workspaceHeartbeats: true },
        workspaceHeartbeatService: heartbeatService,
      },
      "child-ws",
      initStateManager
    );
    expect(childToolsWithHeartbeat.heartbeat).toBeUndefined();
    expect(toolsWithHeartbeat.heartbeat).toBeDefined();
  });

  test("only includes set_goal when goal service and setGoal gate are enabled", async () => {
    const runtime = new LocalRuntime(process.cwd());
    const initStateManager = createInitStateManager();
    // Registration-only test; goal tools capture the service but never execute it here.
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    const goalService = {} as never;

    const disabled = await getToolsForModel(
      "noop:model",
      {
        cwd: process.cwd(),
        runtime,
        runtimeTempDir: "/tmp",
        workspaceId: "ws-1",
        goalService,
        enableGoalTools: { setGoal: false, getGoal: true, completeGoal: true },
      },
      "ws-1",
      initStateManager
    );
    expect(disabled.set_goal).toBeUndefined();
    expect(disabled.get_goal).toBeDefined();
    expect(disabled.complete_goal).toBeDefined();

    const enabled = await getToolsForModel(
      "noop:model",
      {
        cwd: process.cwd(),
        runtime,
        runtimeTempDir: "/tmp",
        workspaceId: "ws-1",
        goalService,
        enableGoalTools: { setGoal: true, getGoal: true, completeGoal: true },
      },
      "ws-1",
      initStateManager
    );
    expect(enabled.set_goal).toBeDefined();
  });

  test("withholds review_pane_* tools from sub-agents (enableAgentReport=true)", async () => {
    const runtime = new LocalRuntime(process.cwd());
    const initStateManager = createInitStateManager();

    // Top-level workspace (not a sub-agent): Review pane tools available.
    const topLevelTools = await getToolsForModel(
      "noop:model",
      {
        cwd: process.cwd(),
        runtime,
        runtimeTempDir: "/tmp",
        enableAgentReport: false,
      },
      "ws-1",
      initStateManager
    );
    expect(topLevelTools.review_pane_update).toBeDefined();
    expect(topLevelTools.review_pane_get).toBeDefined();

    // Sub-agent (child task workspace): can't pin code to the parent Review pane.
    const subAgentTools = await getToolsForModel(
      "noop:model",
      {
        cwd: process.cwd(),
        runtime,
        runtimeTempDir: "/tmp",
        enableAgentReport: true,
      },
      "ws-1",
      initStateManager
    );
    expect(subAgentTools.review_pane_update).toBeUndefined();
    expect(subAgentTools.review_pane_get).toBeUndefined();
  });

  test("only includes workflow tools when dynamic workflows service and experiment are enabled", async () => {
    const runtime = new LocalRuntime(process.cwd());
    const initStateManager = createInitStateManager();

    const withoutExperiment = await getToolsForModel(
      "noop:model",
      {
        cwd: process.cwd(),
        runtime,
        runtimeTempDir: "/tmp",
        workspaceId: "ws-1",
        workflowService: {
          startWorkflow: mock(async () => ({
            runId: "wfr_1",
            status: "completed" as const,
            result: null,
          })),
        },
      },
      "ws-1",
      initStateManager
    );
    expect(withoutExperiment.workflow_list).toBeUndefined();
    expect(withoutExperiment.workflow_read).toBeUndefined();
    expect(withoutExperiment.workflow_run).toBeUndefined();
    expect(withoutExperiment.workflow_resume).toBeUndefined();

    const withExperiment = await getToolsForModel(
      "noop:model",
      {
        cwd: process.cwd(),
        runtime,
        runtimeTempDir: "/tmp",
        workspaceId: "ws-1",
        experiments: { dynamicWorkflows: true },
        workflowService: {
          startWorkflow: mock(async () => ({
            runId: "wfr_1",
            status: "completed" as const,
            result: null,
          })),
        },
      },
      "ws-1",
      initStateManager
    );
    expect(withExperiment.workflow_list).toBeUndefined();
    expect(withExperiment.workflow_read).toBeUndefined();
    expect(withExperiment.workflow_run).toBeDefined();
    expect(withExperiment.workflow_resume).toBeDefined();
  });

  test("includes desktop tools when workspace capability is available", async () => {
    const runtime = new LocalRuntime(process.cwd());
    const initStateManager = createInitStateManager();
    const { desktopSessionManager, getCapability } = createDesktopSessionManager({
      available: true,
    });

    const tools = await getToolsForModel(
      "noop:model",
      {
        cwd: process.cwd(),
        runtime,
        runtimeTempDir: "/tmp",
        workspaceId: "ws-1",
        desktopSessionManager,
      },
      "ws-1",
      initStateManager
    );

    expect(getCapability).toHaveBeenCalledWith("ws-1");
    for (const toolName of DESKTOP_TOOL_NAMES) {
      expect(tools[toolName]).toBeDefined();
    }
  });

  test("omits desktop tools when workspace capability is unavailable", async () => {
    const runtime = new LocalRuntime(process.cwd());
    const initStateManager = createInitStateManager();
    const { desktopSessionManager, getCapability } = createDesktopSessionManager({
      available: false,
    });

    const tools = await getToolsForModel(
      "noop:model",
      {
        cwd: process.cwd(),
        runtime,
        runtimeTempDir: "/tmp",
        workspaceId: "ws-1",
        desktopSessionManager,
      },
      "ws-1",
      initStateManager
    );

    expect(getCapability).toHaveBeenCalledWith("ws-1");
    expect(Object.keys(tools).filter((toolName) => toolName.startsWith("desktop_"))).toEqual([]);
  });

  test("omits desktop tools when no desktop manager is configured", async () => {
    const runtime = new LocalRuntime(process.cwd());
    const initStateManager = createInitStateManager();

    const tools = await getToolsForModel(
      "noop:model",
      {
        cwd: process.cwd(),
        runtime,
        runtimeTempDir: "/tmp",
        workspaceId: "ws-1",
      },
      "ws-1",
      initStateManager
    );

    expect(Object.keys(tools).filter((toolName) => toolName.startsWith("desktop_"))).toEqual([]);
  });

  test("adds native Google Search and URL Context only for Gemini 3 models", async () => {
    const runtime = new LocalRuntime(process.cwd());
    const initStateManager = createInitStateManager();

    const gemini25Tools = await getToolsForModel(
      "google:gemini-2.5-pro",
      {
        cwd: process.cwd(),
        runtime,
        runtimeTempDir: "/tmp",
        workspaceId: "ws-1",
      },
      "ws-1",
      initStateManager
    );
    expect(gemini25Tools.google_search).toBeUndefined();
    expect(gemini25Tools.url_context).toBeUndefined();

    const gemini4Tools = await getToolsForModel(
      "google:gemini-4-pro",
      {
        cwd: process.cwd(),
        runtime,
        runtimeTempDir: "/tmp",
        workspaceId: "ws-1",
      },
      "ws-1",
      initStateManager
    );
    expect(gemini4Tools.google_search).toBeUndefined();
    expect(gemini4Tools.url_context).toBeUndefined();

    const gemini35Tools = await getToolsForModel(
      "google:gemini-3.5-flash",
      {
        cwd: process.cwd(),
        runtime,
        runtimeTempDir: "/tmp",
        workspaceId: "ws-1",
      },
      "ws-1",
      initStateManager
    );
    const namespacedGemini35Tools = await getToolsForModel(
      "google:models/gemini-3.5-flash",
      {
        cwd: process.cwd(),
        runtime,
        runtimeTempDir: "/tmp",
        workspaceId: "ws-1",
      },
      "ws-1",
      initStateManager
    );
    expect(namespacedGemini35Tools.google_search).toBeDefined();
    expect(namespacedGemini35Tools.url_context).toBeDefined();

    expect(gemini35Tools.google_search).toBeDefined();
    expect(gemini35Tools.url_context).toBeDefined();
  });

  test("returns tool keys in sorted order", async () => {
    const runtime = new LocalRuntime(process.cwd());
    const initStateManager = createInitStateManager();

    const tools = await getToolsForModel(
      "noop:model",
      {
        cwd: process.cwd(),
        runtime,
        runtimeTempDir: "/tmp",
        workspaceId: "ws-1",
      },
      "ws-1",
      initStateManager,
      undefined,
      {
        zeta_tool: {
          description: "zeta",
          inputSchema: z.object({}),
          execute: mock(() => Promise.resolve({})),
        },
        alpha_tool: {
          description: "alpha",
          inputSchema: z.object({}),
          execute: mock(() => Promise.resolve({})),
        },
      }
    );

    const toolNames = Object.keys(tools);
    expect(toolNames).toEqual([...toolNames].sort((a, b) => a.localeCompare(b)));
  });
});
