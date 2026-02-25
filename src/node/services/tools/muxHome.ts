import * as path from "path";

import type { ToolConfiguration } from "@/common/utils/tools/tools";

export function getMuxHomeFromWorkspaceSessionDir(
  config: Pick<ToolConfiguration, "workspaceSessionDir">,
  toolName: string
): string {
  if (!config.workspaceSessionDir) {
    throw new Error(`${toolName} requires workspaceSessionDir`);
  }

  // workspaceSessionDir = <muxHome>/sessions/<workspaceId>
  const sessionsDir = path.dirname(config.workspaceSessionDir);
  return path.dirname(sessionsDir);
}
