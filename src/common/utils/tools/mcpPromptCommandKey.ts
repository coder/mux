// Crypto-free on purpose: browser bundles (e.g. the VS Code webview) import this
// matcher, while mcpToolName.ts pulls node:crypto for collision hashing.
export function isMcpPromptCommandKey(value: string): boolean {
  return /^mcp__[a-z0-9_]+$/.test(value);
}
