import type { WorkspaceMetadata } from "@/common/types/workspace";
import type { Result } from "@/common/types/result";
import { Ok, Err } from "@/common/types/result";

export interface BeforeArchiveHookArgs {
  workspaceId: string;
  workspaceMetadata: WorkspaceMetadata;
}

export type BeforeArchiveHook = (args: BeforeArchiveHookArgs) => Promise<Result<void>>;

function sanitizeErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  // Keep single-line, capped error messages to avoid leaking stack traces or long CLI output.
  const singleLine = raw.split("\n")[0]?.trim() ?? "";
  return singleLine.slice(0, 200) || "Unknown error";
}

/**
 * Backend registry for workspace lifecycle hooks.
 *
 * Hooks run in-process (sequentially) and may block the operation if they return Err.
 */
export class WorkspaceLifecycleHooks {
  private readonly beforeArchiveHooks: BeforeArchiveHook[] = [];

  registerBeforeArchive(hook: BeforeArchiveHook): void {
    this.beforeArchiveHooks.push(hook);
  }

  async runBeforeArchive(args: BeforeArchiveHookArgs): Promise<Result<void>> {
    for (const hook of this.beforeArchiveHooks) {
      try {
        const result = await hook(args);
        if (!result.success) {
          return Err(sanitizeErrorMessage(result.error));
        }
      } catch (error) {
        return Err(`beforeArchive hook threw: ${sanitizeErrorMessage(error)}`);
      }
    }

    return Ok(undefined);
  }
}
