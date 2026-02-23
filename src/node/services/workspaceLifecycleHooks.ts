import type { WorkspaceMetadata } from "@/common/types/workspace";
import type { Result } from "@/common/types/result";
import { Ok, Err } from "@/common/types/result";
import { log } from "@/node/services/log";
import { getErrorMessage } from "@/common/utils/errors";

export interface BeforeArchiveHookArgs {
  workspaceId: string;
  workspaceMetadata: WorkspaceMetadata;
}

export type BeforeArchiveHook = (args: BeforeArchiveHookArgs) => Promise<Result<void>>;

export interface AfterUnarchiveHookArgs {
  workspaceId: string;
  workspaceMetadata: WorkspaceMetadata;
}

export type AfterUnarchiveHook = (args: AfterUnarchiveHookArgs) => Promise<Result<void>>;

function sanitizeErrorMessage(error: unknown): string {
  const raw = getErrorMessage(error);
  // Keep single-line, capped error messages to avoid leaking stack traces or long CLI output.
  const singleLine = raw.split("\n")[0]?.trim() ?? "";
  return singleLine.slice(0, 200) || "Unknown error";
}

/**
 * Backend registry for workspace lifecycle hooks.
 *
 * Hooks run in-process (sequentially).
 * - beforeArchive hooks may block the operation if they return Err.
 * - afterUnarchive hooks are best-effort and never block unarchive.
 */
export class WorkspaceLifecycleHooks {
  private readonly beforeArchiveHooks: BeforeArchiveHook[] = [];
  private readonly afterUnarchiveHooks: AfterUnarchiveHook[] = [];

  registerBeforeArchive(hook: BeforeArchiveHook): void {
    this.beforeArchiveHooks.push(hook);
  }

  registerAfterUnarchive(hook: AfterUnarchiveHook): void {
    this.afterUnarchiveHooks.push(hook);
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

  async runAfterUnarchive(args: AfterUnarchiveHookArgs): Promise<void> {
    for (const hook of this.afterUnarchiveHooks) {
      try {
        const result = await hook(args);
        if (!result.success) {
          log.debug("afterUnarchive hook failed", {
            workspaceId: args.workspaceId,
            error: sanitizeErrorMessage(result.error),
          });
        }
      } catch (error) {
        log.debug("afterUnarchive hook threw", {
          workspaceId: args.workspaceId,
          error: sanitizeErrorMessage(error),
        });
      }
    }
  }
}
