import { uniqueSuffix } from "@/common/utils/hasher";

const DEFAULT_MCP_TOOL_NAME_PART = "unknown";

// Be conservative: some providers have strict tool-name validation and limits.
export const MAX_MCP_TOOL_NAME_CHARS = 64;

const MCP_TOOL_NAME_PATTERN = /^[a-z0-9_]+$/;

/** Normalize a component for generated MCP tool names and prompt command keys. */
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
  /**
   * Force the identity hash suffix. Callers set this for every member of a
   * normalized collision group so key assignment does not depend on catalog
   * order: each member gets base + hash(own identity) regardless of which
   * colliding sibling is listed first.
   */
  forceSuffix?: boolean;
}

/** Normalized command key before collision/truncation suffixing. */
export function buildMcpPromptBaseKey(serverName: string, promptName: string): string {
  return `mcp__${normalizeMcpToolNamePart(serverName)}__${normalizeMcpToolNamePart(promptName)}`;
}

export interface BuildMcpToolNameOptions {
  serverName: string;
  toolName: string;
  usedNames: Set<string>;
}

export interface BuildMcpToolNameResult {
  toolName: string;
  /**
   * The normalized identifier without any collision or truncation suffix.
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
  forceSuffix?: boolean;
}): BuildMcpToolNameResult | null {
  if (!MCP_TOOL_NAME_PATTERN.test(options.baseName)) return null;

  let toolName = options.baseName;
  let wasSuffixed = false;
  if (
    options.forceSuffix === true ||
    toolName.length > MAX_MCP_TOOL_NAME_CHARS ||
    options.usedNames.has(toolName)
  ) {
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

/**
 * Identity-derived alias for a prompt: always hash-suffixed, so it never
 * changes with catalog membership. Composer matching falls back to it, which
 * keeps previously inserted collision-suffixed keys resolving after the
 * colliding sibling disappears and its survivor's commandKey loses the suffix.
 */
export function buildMcpPromptStableKey(serverName: string, promptName: string): string | null {
  const result = buildMcpName({
    baseName: buildMcpPromptBaseKey(serverName, promptName),
    identityParts: [serverName, promptName],
    usedNames: new Set(),
    forceSuffix: true,
  });
  return result?.toolName ?? null;
}

export function buildMcpPromptCommandKey(
  options: BuildMcpPromptCommandKeyOptions
): BuildMcpToolNameResult | null {
  return buildMcpName({
    baseName: buildMcpPromptBaseKey(options.serverName, options.promptName),
    identityParts: [options.serverName, options.promptName],
    usedNames: options.usedNames,
    ...(options.forceSuffix !== undefined ? { forceSuffix: options.forceSuffix } : {}),
  });
}
