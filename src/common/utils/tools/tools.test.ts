import { describe, expect, mock, test } from "bun:test";
import { z } from "zod";

import type { InitStateManager } from "@/node/services/initStateManager";
import type { DesktopSessionManager } from "@/node/services/desktop/DesktopSessionManager";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import { LspManager } from "@/node/services/lsp/lspManager";
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

  test("only includes lsp_query when the experiment is enabled and a manager is available", async () => {
    const runtime = new LocalRuntime(process.cwd());
    const initStateManager = createInitStateManager();
    const lspManager = new LspManager({ registry: [] });
    lspManager.query = mock(() =>
      Promise.resolve({
        operation: "hover" as const,
        serverId: "typescript",
        rootUri: "file:///tmp/workspace",
        hover: "",
      })
    );

    try {
      const toolsWithoutLsp = await getToolsForModel(
        "noop:model",
        {
          cwd: process.cwd(),
          runtime,
          runtimeTempDir: "/tmp",
          lspQueryEnabled: false,
        },
        "ws-1",
        initStateManager
      );
      expect(toolsWithoutLsp.lsp_query).toBeUndefined();

      const toolsWithLsp = await getToolsForModel(
        "noop:model",
        {
          cwd: process.cwd(),
          runtime,
          runtimeTempDir: "/tmp",
          lspManager,
          lspPolicyContext: {
            provisioningMode: "manual",
            trustedWorkspaceExecution: true,
          },
          lspQueryEnabled: true,
        },
        "ws-1",
        initStateManager
      );
      expect(toolsWithLsp.lsp_query).toBeDefined();
    } finally {
      await lspManager.dispose();
    }
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
