import { describe, expect, mock, test } from "bun:test";
import type { ToolExecutionOptions } from "ai";
import { LspManager } from "@/node/services/lsp/lspManager";
import { createTestToolConfig } from "./testHelpers";
import { createLspQueryTool } from "./lsp_query";
import type { LspQueryToolResult } from "@/common/types/tools";

const TEST_LSP_POLICY_CONTEXT = {
  provisioningMode: "manual" as const,
  trustedWorkspaceExecution: true,
};

const mockToolCallOptions: ToolExecutionOptions = {
  toolCallId: "tool-call-id",
  messages: [],
};

function requireDirectoryWorkspaceSymbolsResult(result: LspQueryToolResult) {
  expect(result.success).toBe(true);
  if (!result.success || !("results" in result)) {
    throw new Error("Expected a directory workspace_symbols tool result");
  }

  return result.results;
}

describe("lsp_query tool", () => {
  test("returns formatted LSP data from the manager", async () => {
    const lspManager = new LspManager({ registry: [] });
    const query = mock(() =>
      Promise.resolve({
        operation: "hover" as const,
        serverId: "typescript",
        rootUri: "file:///tmp/workspace",
        hover: "const value: 1",
      })
    );
    lspManager.query = query;
    const config = createTestToolConfig(process.cwd());
    config.lspManager = lspManager;
    config.lspPolicyContext = TEST_LSP_POLICY_CONTEXT;
    const configuredTool = createLspQueryTool(config);

    try {
      const result = (await configuredTool.execute!(
        {
          operation: "hover",
          path: "src/browser/App.tsx",
          line: 1,
          column: 1,
        },
        mockToolCallOptions
      )) as LspQueryToolResult;

      expect(result.success).toBe(true);
      if (!result.success || !("serverId" in result)) {
        throw new Error("Expected a single-root LSP result");
      }
      expect(result.serverId).toBe("typescript");
      expect(result.hover).toBe("const value: 1");
      expect(query).toHaveBeenCalledTimes(1);
      expect(query).toHaveBeenCalledWith(
        expect.objectContaining({
          policyContext: TEST_LSP_POLICY_CONTEXT,
        })
      );
    } finally {
      await lspManager.dispose();
    }
  });

  test("resolves path . to the workspace directory for workspace_symbols queries", async () => {
    const lspManager = new LspManager({ registry: [] });
    const query = mock(() =>
      Promise.resolve({
        operation: "workspace_symbols" as const,
        results: [],
        skippedRoots: [
          {
            serverId: "rust",
            rootUri: `file://${process.cwd()}`,
            reasonCode: "unsupported_provisioning" as const,
            reason:
              "rust-analyzer is not available on PATH and automatic installation is not supported yet",
            installGuidance:
              "Install rust-analyzer and ensure it is available on PATH, or query a representative source file for a supported language.",
          },
        ],
      })
    );
    lspManager.query = query;
    const config = createTestToolConfig(process.cwd());
    config.lspManager = lspManager;
    config.lspPolicyContext = TEST_LSP_POLICY_CONTEXT;
    const tool = createLspQueryTool(config);

    try {
      const result = (await tool.execute!(
        {
          operation: "workspace_symbols",
          path: ".",
          query: "ResourceService",
        },
        mockToolCallOptions
      )) as LspQueryToolResult;

      expect(result).toEqual({
        success: true,
        operation: "workspace_symbols",
        results: [],
        skippedRoots: [
          {
            serverId: "rust",
            rootUri: `file://${process.cwd()}`,
            reasonCode: "unsupported_provisioning",
            reason:
              "rust-analyzer is not available on PATH and automatic installation is not supported yet",
            installGuidance:
              "Install rust-analyzer and ensure it is available on PATH, or query a representative source file for a supported language.",
          },
        ],
      });
      expect(requireDirectoryWorkspaceSymbolsResult(result)).toHaveLength(0);
      expect(query).toHaveBeenCalledWith(
        expect.objectContaining({
          filePath: process.cwd(),
          operation: "workspace_symbols",
          query: "ResourceService",
        })
      );
    } finally {
      await lspManager.dispose();
    }
  });

  test("validates required position arguments for hover-like operations", async () => {
    const config = createTestToolConfig(process.cwd());
    const lspManager = new LspManager({ registry: [] });
    const query = mock(() =>
      Promise.resolve({
        operation: "hover" as const,
        serverId: "typescript",
        rootUri: "file:///tmp/workspace",
        hover: "",
      })
    );
    lspManager.query = query;
    config.lspManager = lspManager;
    config.lspPolicyContext = TEST_LSP_POLICY_CONTEXT;
    const tool = createLspQueryTool(config);

    try {
      const result = (await tool.execute!(
        {
          operation: "definition",
          path: "src/browser/App.tsx",
        },
        mockToolCallOptions
      )) as LspQueryToolResult;

      expect(result).toEqual({
        success: false,
        error: "definition requires both line and column",
      });
    } finally {
      await lspManager.dispose();
    }
  });
});
