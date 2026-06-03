/* eslint-disable @typescript-eslint/require-await */
import { describe, expect, mock, test } from "bun:test";
import { z } from "zod";

import type { InitStateManager } from "@/node/services/initStateManager";
import type { DesktopSessionManager } from "@/node/services/desktop/DesktopSessionManager";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import { getToolsForModel } from "./tools";

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
          listDefinitions: mock(async () => []),
          readDefinition: mock(async () => ({
            descriptor: { name: "demo", description: "Demo", scope: "built-in", executable: true },
            source: "export default function workflow() { return null; }",
          })),
          listActions: mock(async () => []),
          startNamedWorkflow: mock(async () => ({
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
    expect(withoutExperiment.workflow_action_list).toBeUndefined();
    expect(withoutExperiment.workflow_run).toBeUndefined();

    const withExperiment = await getToolsForModel(
      "noop:model",
      {
        cwd: process.cwd(),
        runtime,
        runtimeTempDir: "/tmp",
        workspaceId: "ws-1",
        experiments: { dynamicWorkflows: true },
        workflowService: {
          listDefinitions: mock(async () => []),
          readDefinition: mock(async () => ({
            descriptor: { name: "demo", description: "Demo", scope: "built-in", executable: true },
            source: "export default function workflow() { return null; }",
          })),
          listActions: mock(async () => []),
          startNamedWorkflow: mock(async () => ({
            runId: "wfr_1",
            status: "completed" as const,
            result: null,
          })),
        },
      },
      "ws-1",
      initStateManager
    );
    expect(withExperiment.workflow_list).toBeDefined();
    expect(withExperiment.workflow_read).toBeDefined();
    expect(withExperiment.workflow_action_list).toBeDefined();
    expect(withExperiment.workflow_run).toBeDefined();
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
