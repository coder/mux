import { uniqueSuffix } from "@/common/utils/hasher";

const DEFAULT_MCP_TOOL_NAME_PART = "unknown";

// Be conservative: some providers have strict tool-name validation and limits.
export const MAX_MCP_TOOL_NAME_CHARS = 64;

const MCP_TOOL_NAME_PATTERN = /^[a-z0-9_]+$/;

/**
 * Normalize a single component used to build an MCP tool name.
 *
 * Note: This is NOT user-facing. It's purely to ensure provider-safe tool keys.
 */
export function normalizeMcpToolNamePart(input: string): string {
  const normalized = input
    .normalize("NFKD")
    .toLowerCase()
    // Replace whitespace and any non-[a-z0-9_] characters with underscores.
    // (Treat '-' as '_' too for maximum provider compatibility.)
    .replace(/[^a-z0-9_]+/g, "_")
    // Collapse consecutive underscores.
    .replace(/_+/g, "_")
    // Trim leading/trailing underscores.
    .replace(/^_+|_+$/g, "");

  return normalized.length > 0 ? normalized : DEFAULT_MCP_TOOL_NAME_PART;
}

export interface BuildMcpToolNameOptions {
  serverName: string;
  toolName: string;
  usedNames: Set<string>;
}

export interface BuildMcpToolNameResult {
  toolName: string;
  /**
   * The normalized tool name without any collision/truncation suffix.
   * Useful for debugging/logging.
   */
  baseName: string;
  /** True when we added a hash suffix due to collision or length constraints. */
  wasSuffixed: boolean;
}

function buildMcpToolNameWithSuffix(baseName: string, suffix: string): string {
  // Ensure we always fit the suffix + separator.
  const trimmedSuffix = suffix.slice(0, 8);
  const suffixWithSeparator = `_${trimmedSuffix}`;

  const maxBaseLength = MAX_MCP_TOOL_NAME_CHARS - suffixWithSeparator.length;
  if (maxBaseLength <= 0) {
    return `tool${suffixWithSeparator}`.slice(0, MAX_MCP_TOOL_NAME_CHARS);
  }

  const trimmedBase = baseName.slice(0, maxBaseLength).replace(/_+$/g, "") || "tool";
  return `${trimmedBase}${suffixWithSeparator}`;
}

/**
 * Build a provider-safe, collision-resistant MCP tool name.
 *
 * The tool name is derived from `${serverName}_${toolName}`, but normalized to:
 * - lowercase
 * - underscore-delimited
 * - <= 64 characters
 * - [a-z0-9_]+ only
 *
 * If the normalized name collides with an existing tool name (or exceeds 64 chars),
 * a stable hash suffix is appended.
 */
export function buildMcpToolName(options: BuildMcpToolNameOptions): BuildMcpToolNameResult | null {
  const serverPart = normalizeMcpToolNamePart(options.serverName);
  const toolPart = normalizeMcpToolNamePart(options.toolName);
  const baseName = `${serverPart}_${toolPart}`;

  if (!MCP_TOOL_NAME_PATTERN.test(baseName)) {
    return null;
  }

  let finalName = baseName;
  let wasSuffixed = false;

  if (finalName.length > MAX_MCP_TOOL_NAME_CHARS || options.usedNames.has(finalName)) {
    wasSuffixed = true;

    // Use a stable suffix derived from the *original* server/tool names so that renaming
    // only happens when necessary (collisions/length), and remains deterministic.
    const suffix = uniqueSuffix([options.serverName, options.toolName]);
    finalName = buildMcpToolNameWithSuffix(baseName, suffix);

    // Extremely defensive: in the astronomically unlikely case of a hash collision,
    // attempt a second derivation before giving up.
    if (options.usedNames.has(finalName)) {
      const suffix2 = uniqueSuffix([options.serverName, options.toolName, "2"]);
      finalName = buildMcpToolNameWithSuffix(baseName, suffix2);

      if (options.usedNames.has(finalName)) {
        return null;
      }
    }
  }

  if (!MCP_TOOL_NAME_PATTERN.test(finalName) || finalName.length > MAX_MCP_TOOL_NAME_CHARS) {
    return null;
  }

  options.usedNames.add(finalName);

  return { toolName: finalName, baseName, wasSuffixed };
}
