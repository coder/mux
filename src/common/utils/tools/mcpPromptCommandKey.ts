// Crypto-free on purpose: browser bundles (e.g. the VS Code webview) import
// these helpers, while mcpToolName.ts pulls node:crypto for collision hashing.

const DEFAULT_MCP_TOOL_NAME_PART = "unknown";

export function isMcpPromptCommandKey(value: string): boolean {
  return /^mcp__[a-z0-9_]+$/.test(value);
}

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

/** Normalized command key before collision/truncation suffixing. */
export function buildMcpPromptBaseKey(serverName: string, promptName: string): string {
  return `mcp__${normalizeMcpToolNamePart(serverName)}__${normalizeMcpToolNamePart(promptName)}`;
}
