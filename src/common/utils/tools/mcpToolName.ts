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

export interface BuildMcpPromptCommandKeyOptions {
  serverName: string;
  promptName: string;
  usedNames: Set<string>;
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

function buildMcpName(options: {
  baseName: string;
  identityParts: string[];
  usedNames: Set<string>;
}): BuildMcpToolNameResult | null {
  if (!MCP_TOOL_NAME_PATTERN.test(options.baseName)) return null;

  let toolName = options.baseName;
  let wasSuffixed = false;
  if (toolName.length > MAX_MCP_TOOL_NAME_CHARS || options.usedNames.has(toolName)) {
    wasSuffixed = true;
    toolName = buildMcpToolNameWithSuffix(options.baseName, uniqueSuffix(options.identityParts));
    if (options.usedNames.has(toolName)) {
      toolName = buildMcpToolNameWithSuffix(
        options.baseName,
        uniqueSuffix([...options.identityParts, "2"])
      );
      if (options.usedNames.has(toolName)) return null;
    }
  }

  if (!MCP_TOOL_NAME_PATTERN.test(toolName) || toolName.length > MAX_MCP_TOOL_NAME_CHARS) {
    return null;
  }
  options.usedNames.add(toolName);
  return { toolName, baseName: options.baseName, wasSuffixed };
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
  return buildMcpName({
    baseName: `${normalizeMcpToolNamePart(options.serverName)}_${normalizeMcpToolNamePart(options.toolName)}`,
    identityParts: [options.serverName, options.toolName],
    usedNames: options.usedNames,
  });
}

export function buildMcpPromptCommandKey(
  options: BuildMcpPromptCommandKeyOptions
): BuildMcpToolNameResult | null {
  return buildMcpName({
    baseName: `mcp__${normalizeMcpToolNamePart(options.serverName)}__${normalizeMcpToolNamePart(options.promptName)}`,
    identityParts: [options.serverName, options.promptName],
    usedNames: options.usedNames,
  });
}
