/**
 * Type Generator for PTC
 *
 * Generates `.d.ts` TypeScript declarations from tool schemas.
 * Used to:
 * 1. Inform the model about available tools and their signatures
 * 2. Validate agent code with TypeScript before QuickJS execution
 *
 * Input types are generated from Zod schemas via JSON Schema conversion.
 * Result types are generated from Zod schemas in toolDefinitions.ts (single source of truth).
 */

import { createHash } from "crypto";
import { z } from "zod";
import { compile } from "json-schema-to-typescript";
import type { Tool } from "ai";
import { RESULT_SCHEMAS, type BridgeableToolName } from "@/common/utils/tools/toolDefinitions";

/**
 * MCP result type - protocol-defined, same for all MCP tools.
 */
const MCP_RESULT_TYPE = `type MCPCallToolResult = {
  content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
    | { type: "resource"; resource: { uri: string; text?: string; blob?: string } }
  >;
  isError?: boolean;
};`;

// ============================================================================
// Caching
// ============================================================================

/**
 * Unified cache structure for all type generation artifacts.
 */
interface TypeCache {
  /** Full generated .d.ts content, keyed by tool set hash */
  fullTypes: Map<string, string>;
  /** Individual result type strings, keyed by tool name */
  resultTypes: Map<string, string>;
}

const cache: TypeCache = {
  fullTypes: new Map(),
  resultTypes: new Map(),
};

/**
 * Clear all type caches. Call for test isolation or when tool schemas might have changed.
 */
export function clearTypeCache(): void {
  cache.fullTypes.clear();
  cache.resultTypes.clear();
}

/**
 * Hash tool definitions (names, schemas, descriptions) to detect when tools change.
 * This ensures cache invalidation when schemas are updated, not just when tool names change.
 */
function hashToolDefinitions(tools: Record<string, Tool>): string {
  const sortedNames = Object.keys(tools).sort();
  const toolData = sortedNames.map((name) => {
    const tool = tools[name];
    return {
      name,
      schema: getInputJsonSchema(tool),
      description: tool.description ?? "",
    };
  });
  return createHash("md5").update(JSON.stringify(toolData)).digest("hex");
}

/**
 * Get cached mux types or generate new ones if tool definitions changed.
 */
export async function getCachedMuxTypes(tools: Record<string, Tool>): Promise<string> {
  const hash = hashToolDefinitions(tools);
  const cached = cache.fullTypes.get(hash);
  if (cached) {
    return cached;
  }

  const types = await generateMuxTypes(tools);
  cache.fullTypes.set(hash, types);
  return types;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Convert snake_case or kebab-case to PascalCase.
 */
function pascalCase(str: string): string {
  return str
    .split(/[_-]/)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join("");
}

/**
 * Indent each line of a string.
 */
function indent(str: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return str
    .split("\n")
    .map((line) => (line.trim() ? pad + line : line))
    .join("\n");
}

/**
 * Extract JSON Schema from a tool, handling both Zod schemas and raw JSON Schema.
 */
function getInputJsonSchema(tool: Tool): object {
  const toolRecord = tool as { inputSchema?: unknown; parameters?: unknown };
  const schema = toolRecord.inputSchema ?? toolRecord.parameters;

  if (!schema) {
    return { type: "object", properties: {}, required: [] };
  }

  // Check if it's a Zod schema (has _def property)
  if (typeof schema === "object" && "_def" in schema) {
    return z.toJSONSchema(schema as z.ZodType);
  }

  // Already JSON Schema
  return schema as object;
}

/**
 * Get result type string for a built-in tool.
 * Uses Zod schema → JSON Schema → TypeScript string pipeline.
 * Results are cached by tool name.
 *
 * @returns TypeScript type string or null if no schema exists
 */
async function getResultTypeString(toolName: string): Promise<string | null> {
  // Check cache first
  if (cache.resultTypes.has(toolName)) {
    return cache.resultTypes.get(toolName)!;
  }

  // Check if this is a bridgeable tool with a known result schema
  if (!(toolName in RESULT_SCHEMAS)) {
    return null;
  }
  const schema = RESULT_SCHEMAS[toolName as BridgeableToolName];

  // Convert Zod → JSON Schema → TypeScript
  const jsonSchema = z.toJSONSchema(schema);
  const tsOutput = await compile(
    jsonSchema as Parameters<typeof compile>[0],
    `${pascalCase(toolName)}Result`,
    {
      bannerComment: "",
      ignoreMinAndMaxItems: true,
    }
  );

  // Extract just the type definition body (after "export type X = ")
  // The compile output looks like: "export type FooResult = { ... } | { ... };"
  // Use regex to match the declaration pattern, avoiding false matches on `=` in type body
  const typeBodyRegex = /^export\s+type\s+\w+\s*=\s*([\s\S]+?);?\s*$/;
  const match = typeBodyRegex.exec(tsOutput);
  if (!match) return null;

  const result = match[1].trim();

  if (result) {
    cache.resultTypes.set(toolName, result);
  }
  return result;
}

// ============================================================================
// Main Generator
// ============================================================================

/**
 * Generate TypeScript declaration file content for all bridgeable tools.
 *
 * @param tools Record of tool name to Tool, already filtered to bridgeable tools only
 * @returns `.d.ts` content as a string
 */
export async function generateMuxTypes(tools: Record<string, Tool>): Promise<string> {
  const lines: string[] = ["declare namespace mux {"];
  let mcpToolsPresent = false;

  // Sort tool names for deterministic output
  const sortedNames = Object.keys(tools).sort();

  for (const name of sortedNames) {
    const tool = tools[name];
    const isMcp = name.startsWith("mcp__");

    // Generate arg interface from JSON Schema
    const inputSchema = getInputJsonSchema(tool);
    const argsTypeName = `${pascalCase(name)}Args`;

    try {
      const argInterface = await compile(
        inputSchema as Parameters<typeof compile>[0],
        argsTypeName,
        {
          bannerComment: "",
          ignoreMinAndMaxItems: true, // Clean Type[] instead of verbose tuple unions
        }
      );
      // Strip "export " prefix and add to output
      const stripped = argInterface.replace(/^export /gm, "");
      lines.push(indent(stripped.trim(), 2));
    } catch {
      // Fallback for schemas that can't be compiled
      lines.push(`  interface ${argsTypeName} { [key: string]: unknown; }`);
    }

    // Add JSDoc comment with tool description (first line only)
    const description = tool.description ?? "";
    if (description) {
      const firstLine = description.split("\n")[0].trim();
      if (firstLine) {
        lines.push(`  /** ${firstLine} */`);
      }
    }

    // Add function declaration with appropriate result type
    // Note: Asyncify makes async host functions appear synchronous to QuickJS,
    // so we declare them as returning T directly, not Promise<T>
    if (isMcp) {
      mcpToolsPresent = true;
      lines.push(`  function ${name}(args: ${argsTypeName}): MCPCallToolResult;`);
    } else {
      const resultType = await getResultTypeString(name);
      if (resultType) {
        const resultTypeName = `${pascalCase(name)}Result`;
        lines.push(`  type ${resultTypeName} = ${resultType};`);
        lines.push(`  function ${name}(args: ${argsTypeName}): ${resultTypeName};`);
      } else {
        // Unknown tool - return unknown
        lines.push(`  function ${name}(args: ${argsTypeName}): unknown;`);
      }
    }

    lines.push(""); // Blank line between tools
  }

  // Add MCP result type if any MCP tools are present
  if (mcpToolsPresent) {
    lines.push(indent(MCP_RESULT_TYPE, 2));
    lines.push("");
  }

  lines.push("}");
  lines.push("");

  // Add console global declaration
  lines.push(
    "declare var console: { log(...args: unknown[]): void; warn(...args: unknown[]): void; error(...args: unknown[]): void };"
  );
  lines.push("");

  return lines.join("\n");
}
