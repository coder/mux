import { tool } from "ai";
import type { ToolFactory, ToolConfiguration } from "@/common/utils/tools/tools";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import type { LspQueryToolResult } from "@/common/types/tools";
import { resolvePathWithinCwd, validatePathInCwd } from "./fileCommon";

function validateArguments(args: {
  operation: string;
  line?: number | null;
  column?: number | null;
  query?: string | null;
}): string | null {
  switch (args.operation) {
    case "hover":
    case "definition":
    case "references":
    case "implementation":
      if (args.line == null || args.column == null) {
        return `${args.operation} requires both line and column`;
      }
      return null;
    case "workspace_symbols":
      if (!args.query?.trim()) {
        return "workspace_symbols requires a non-empty query";
      }
      return null;
    case "document_symbols":
      return null;
    default:
      return `Unsupported LSP operation: ${args.operation}`;
  }
}

export const createLspQueryTool: ToolFactory = (config: ToolConfiguration) =>
  tool({
    description: TOOL_DEFINITIONS.lsp_query.description,
    inputSchema: TOOL_DEFINITIONS.lsp_query.schema,
    execute: async (args): Promise<LspQueryToolResult> => {
      if (!config.lspManager || !config.workspaceId || !config.lspPolicyContext) {
        return {
          success: false,
          error: "LSP query tool is unavailable in this workspace",
        };
      }

      const argumentError = validateArguments(args);
      if (argumentError) {
        return {
          success: false,
          error: argumentError,
        };
      }

      const pathError = validatePathInCwd(args.path, config.cwd, config.runtime);
      if (pathError) {
        return {
          success: false,
          error: pathError.error,
        };
      }

      const { resolvedPath, warning: pathWarning } = resolvePathWithinCwd(
        args.path,
        config.cwd,
        config.runtime
      );

      try {
        const result = await config.lspManager.query({
          workspaceId: config.workspaceId,
          runtime: config.runtime,
          workspacePath: config.cwd,
          filePath: resolvedPath,
          operation: args.operation,
          policyContext: config.lspPolicyContext,
          line: args.line ?? undefined,
          column: args.column ?? undefined,
          query: args.query ?? undefined,
          includeDeclaration: args.includeDeclaration ?? undefined,
        });
        const warning = [result.warning, pathWarning]
          .filter((value): value is string => value != null && value.length > 0)
          .join(" ");

        return {
          success: true,
          ...result,
          ...(warning ? { warning } : {}),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          success: false,
          error: message,
          ...(pathWarning ? { warning: pathWarning } : {}),
        };
      }
    },
  });
