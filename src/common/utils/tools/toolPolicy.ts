import type { Tool } from "ai";
import type { z } from "zod";
import type { ToolPolicySchema } from "@/common/orpc/schemas/stream";

/**
 * Tool policy - array of filters applied in order
 * Default behavior is "allow" (all tools enabled) for backwards compatibility
 * Inferred from ToolPolicySchema (single source of truth)
 */
export type ToolPolicy = z.infer<typeof ToolPolicySchema>;

/**
 * Apply tool policy to filter available tools
 * @param tools All available tools
 * @param policy Optional policy to apply (default: allow all)
 * @returns Filtered tools based on policy
 *
 * Algorithm:
 * - Filters are applied in order, with default behavior "allow all".
 * - "require" acts like "enable" for filtering purposes.
 * - The last matching filter wins for each tool.
 */
export function applyToolPolicy(
  tools: Record<string, Tool>,
  policy?: ToolPolicy
): Record<string, Tool> {
  if (!policy || policy.length === 0) {
    return tools;
  }

  const toolNames = Object.keys(tools);

  // Build a map of tool name -> enabled status.
  // "require" acts as "enable" for filtering purposes — enforcement
  // happens at the stream level (stop-when + post-stream recovery).
  const toolStatus = new Map<string, boolean>();
  for (const toolName of toolNames) {
    toolStatus.set(toolName, true);
  }

  for (const filter of policy) {
    const regex = new RegExp(`^${filter.regex_match}$`);
    const shouldEnable = filter.action !== "disable";

    for (const toolName of toolNames) {
      if (regex.test(toolName)) {
        toolStatus.set(toolName, shouldEnable);
      }
    }
  }

  const filteredTools: Record<string, Tool> = {};
  for (const [toolName, tool] of Object.entries(tools)) {
    if (toolStatus.get(toolName) === true) {
      filteredTools[toolName] = tool;
    }
  }

  return filteredTools;
}
