/**
 * Agent Plugins 1.0.0 plugin-name grammar (§5, canonical plugin.schema.json).
 *
 * Lives in src/common so both the node-side manifest validator and the shared
 * registry schema (src/common/config/schemas/agentPluginInstalls.ts) enforce
 * the same rule. Registry names double as directory names under
 * `~/.mux/plugins`, so this validation is also a filesystem-safety gate:
 * the pattern excludes path separators, `.`/`..`, and `..` runs.
 */

// Canonical name pattern from plugin.schema.json (JS supports the lookahead).
export const AGENT_PLUGIN_NAME_PATTERN = /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;
export const AGENT_PLUGIN_NAME_MAX_LENGTH = 64;

/** True when `name` satisfies the §5 plugin-name grammar. */
export function isValidAgentPluginName(name: string): boolean {
  return name.length <= AGENT_PLUGIN_NAME_MAX_LENGTH && AGENT_PLUGIN_NAME_PATTERN.test(name);
}
