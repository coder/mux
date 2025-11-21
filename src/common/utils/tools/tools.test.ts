import { describe, it, expect, beforeEach, mock, type Mock } from "bun:test";
import { getToolsForModel } from "./tools";
import { listScripts } from "@/utils/scripts/discovery";
import { runWorkspaceScript } from "@/node/services/scriptRunner";
import type { ToolConfiguration } from "./tools";
import type { Runtime } from "@/node/runtime/Runtime";
import type { InitStateManager } from "@/node/services/initStateManager";

// Mock listScripts
void mock.module("@/utils/scripts/discovery", () => ({
  listScripts: mock(),
}));

// Mock runWorkspaceScript
void mock.module("@/node/services/scriptRunner", () => ({
  runWorkspaceScript: mock(),
}));

// Mock runtime tools creators to return dummy tools
void mock.module("@/node/services/tools/file_read", () => ({
  createFileReadTool: () => ({ execute: mock() }),
}));
void mock.module("@/node/services/tools/bash", () => ({
  createBashTool: () => ({ execute: mock() }),
}));
void mock.module("@/node/services/tools/file_edit_replace_string", () => ({
  createFileEditReplaceStringTool: () => ({ execute: mock() }),
}));
void mock.module("@/node/services/tools/file_edit_insert", () => ({
  createFileEditInsertTool: () => ({ execute: mock() }),
}));
void mock.module("@/node/services/tools/propose_plan", () => ({
  createProposePlanTool: () => ({ execute: mock() }),
}));
void mock.module("@/node/services/tools/todo", () => ({
  createTodoWriteTool: () => ({ execute: mock() }),
  createTodoReadTool: () => ({ execute: mock() }),
}));
void mock.module("@/node/services/tools/status_set", () => ({
  createStatusSetTool: () => ({ execute: mock() }),
}));
void mock.module("@/node/services/tools/wrapWithInitWait", () => ({
  wrapWithInitWait: (t: unknown) => t,
}));
// Mock log
void mock.module("@/node/services/log", () => ({
  log: { error: mock(), info: mock() },
}));

// Mock shescape
void mock.module("shescape", () => ({
  Shescape: class {
    constructor(options: { shell: boolean | string }) {
      if (options.shell === true && process.env.SHELL === "/bin/sh") {
        throw new Error("Shescape does not support the shell sh");
      }
      if (options.shell === "bash") {
        // OK
      }
    }
    quote(s: string) {
      return `'${s}'`;
    }
  },
}));

describe("getToolsForModel", () => {
  const mockRuntime = {} as unknown as Runtime;
  const mockInitStateManager = {} as unknown as InitStateManager;
  const config: ToolConfiguration = {
    cwd: "/test/cwd",
    runtime: mockRuntime,
    runtimeTempDir: "/tmp",
  } as const;

  beforeEach(() => {
    mock.restore();
  });

  it("should discover and register script tools", async () => {
    const mockScripts = [
      {
        name: "demo",
        description: "A demo script",
        isExecutable: true,
      },
      {
        name: "deploy-prod",
        description: "Deploy to prod",
        isExecutable: true,
      },
      {
        name: "broken",
        description: "Not executable",
        isExecutable: false,
      },
    ];

    const mockListScripts = listScripts as unknown as Mock<typeof listScripts>;
    mockListScripts.mockResolvedValue(mockScripts);

    const tools = await getToolsForModel(
      "anthropic:claude-3-5-sonnet",
      config,
      "workspace-id",
      mockInitStateManager
    );

    expect(listScripts).toHaveBeenCalledWith(mockRuntime, "/test/cwd");

    // Check if script tools are present
    expect(tools).toHaveProperty("script_demo");
    expect(tools).toHaveProperty("script_deploy_prod");
    expect(tools).not.toHaveProperty("script_broken");

    const demoTool = tools.script_demo;
    expect(demoTool).toBeDefined();
  });

  it("should include MUX_PROMPT and MUX_OUTPUT in tool result", async () => {
    const mockScripts = [
      {
        name: "diagnose",
        description: "Diagnose issues",
        isExecutable: true,
      },
    ];

    const mockListScripts = listScripts as unknown as Mock<typeof listScripts>;
    mockListScripts.mockResolvedValue(mockScripts);

    const mockRunScript = runWorkspaceScript as unknown as Mock<typeof runWorkspaceScript>;
    mockRunScript.mockResolvedValue({
      success: true,
      data: {
        exitCode: 0,
        stdout: "Standard output",
        stderr: "",
        outputFileContent: "User notification",
        promptFileContent: "Agent instruction",
        toolResult: {
          success: true,
          exitCode: 0,
          output: "",
          wall_duration_ms: 1000,
        },
      },
    });

    const tools = await getToolsForModel(
      "anthropic:claude-3-5-sonnet",
      config,
      "workspace-id",
      mockInitStateManager
    );

    // Use unknown type assertion first, then cast to expected tool type with execute
    const diagnoseTool = tools.script_diagnose as unknown as {
      execute: (args: { args: string[] }) => Promise<string>;
    };
    const result = await diagnoseTool.execute({ args: [] });

    expect(mockRunScript).toHaveBeenCalledWith(
      config.runtime,
      config.cwd,
      "diagnose",
      [],
      expect.objectContaining({
        overflowPolicy: "tmpfile",
      })
    );

    expect(result).toContain("Standard output");
    expect(result).toContain("--- MUX_OUTPUT ---\nUser notification");
    expect(result).toContain("--- MUX_PROMPT ---\nAgent instruction");
  });

  it("should handle script discovery failure gracefully", async () => {
    const mockListScripts = listScripts as unknown as Mock<typeof listScripts>;
    mockListScripts.mockRejectedValue(new Error("Discovery failed"));

    const tools = await getToolsForModel(
      "anthropic:claude-3-5-sonnet",
      config,
      "workspace-id",
      mockInitStateManager
    );

    // Should still return base tools
    expect(tools).toHaveProperty("bash");
    expect(tools).toHaveProperty("file_read");
    // Should not have script tools
    expect(Object.keys(tools).some((k) => k.startsWith("script_"))).toBe(false);
  });
});
