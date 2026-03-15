import assert from "@/common/utils/assert";

const MUX_BROWSER_SESSION_PREFIX = "mux";

export function getMuxBrowserSessionId(workspaceId: string): string {
  assert(workspaceId.trim().length > 0, "Browser session IDs require a non-empty workspaceId");
  return `${MUX_BROWSER_SESSION_PREFIX}-${workspaceId}`;
}
