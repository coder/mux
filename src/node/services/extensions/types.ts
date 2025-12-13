import type { Runtime } from "@/node/runtime/Runtime";
import type { RuntimeConfig } from "@/common/types/runtime";

export interface PostToolUseHookPayload {
  workspaceId: string;
  projectPath: string;
  workspacePath: string;
  runtimeConfig: RuntimeConfig;
  runtimeTempDir: string;

  toolName: string;
  toolCallId: string;
  args: unknown;
  result: unknown;
  timestamp: number;

  /** Full Runtime handle for this workspace (local/worktree/ssh). */
  runtime: Runtime;
}

/**
 * Optional return value from onPostToolUse.
 *
 * If an extension returns { result }, that value becomes the tool result returned
 * to the model (and shown in the UI).
 */
export type PostToolUseHookReturn = void | { result: unknown };

export interface Extension {
  onPostToolUse?: (payload: PostToolUseHookPayload) => Promise<PostToolUseHookReturn> | PostToolUseHookReturn;
}
