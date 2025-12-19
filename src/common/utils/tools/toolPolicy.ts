import type { Tool } from "ai";
import type { z } from "zod";
import type { ToolPolicyFilterSchema, ToolPolicySchema } from "@/common/orpc/schemas/stream";

/**
 * Filter for tool policy - determines if a tool should be enabled, disabled, or required
 * Inferred from ToolPolicyFilterSchema (single source of truth)
 */
export type ToolPolicyFilter = z.infer<typeof ToolPolicyFilterSchema>;

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
 * - If any tool is marked as "require" (at most one tool may match across the whole policy),
 *   only that tool remains eligible. Later filters may still disable it (resulting in no tools).
 * - Without a required tool, enable/disable filters apply to all tools, and the last matching
 *   filter wins for each tool.
 */
export function applyToolPolicy(
  tools: Record<string, Tool>,
  policy?: ToolPolicy
): Record<string, Tool> {
  // No policy = allow all (backwards compatible)
  if (!policy || policy.length === 0) {
    return tools;
  }

  const toolNames = Object.keys(tools);

  // First pass: find a single required tool (if any), validating that the policy
  // never results in multiple required matches.
  let requiredTool: string | null = null;
  for (const filter of policy) {
    if (filter.action !== "require") continue;

    const regex = new RegExp(`^${filter.regex_match}$`);
    const matches = toolNames.filter((toolName) => regex.test(toolName));

    if (matches.length > 1) {
      throw new Error(
        `Tool policy error: Multiple tools marked as required (${matches.join(", ")}). At most one tool can be required.`
      );
    }
    if (matches.length === 0) continue;

    if (requiredTool && requiredTool !== matches[0]) {
      throw new Error(
        `Tool policy error: Multiple tools marked as required (${requiredTool}, ${matches[0]}). At most one tool can be required.`
      );
    }
    requiredTool = matches[0];
  }

  // If a tool is required, only that tool remains eligible, but later filters may disable it.
  if (requiredTool) {
    let enabled = true; // Default allow

    for (const filter of policy) {
      const regex = new RegExp(`^${filter.regex_match}$`);
      if (!regex.test(requiredTool)) continue;

      if (filter.action === "disable") {
        enabled = false;
        continue;
      }
      // enable/require both imply enabled for the required tool at this point in the policy
      enabled = true;
    }

    return enabled ? { [requiredTool]: tools[requiredTool] } : {};
  }

  // No required tools: apply standard enable/disable logic
  // Build a map of tool name -> enabled status
  const toolStatus = new Map<string, boolean>();

  // Initialize all tools as enabled (default allow)
  for (const toolName of toolNames) {
    toolStatus.set(toolName, true);
  }

  // Apply each filter in order (skip "require" actions as they were handled above)
  for (const filter of policy) {
    if (filter.action === "require") continue;

    const regex = new RegExp(`^${filter.regex_match}$`);
    const shouldEnable = filter.action === "enable";

    // Apply filter to matching tools
    for (const toolName of toolNames) {
      if (regex.test(toolName)) {
        toolStatus.set(toolName, shouldEnable);
      }
    }
  }

  // Filter tools based on final status
  const filteredTools: Record<string, Tool> = {};
  for (const [toolName, tool] of Object.entries(tools)) {
    if (toolStatus.get(toolName) === true) {
      filteredTools[toolName] = tool;
    }
  }

  return filteredTools;
}
