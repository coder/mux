import assert from "node:assert/strict";
import * as fsPromises from "fs/promises";
import * as path from "node:path";

import { tool } from "ai";

import type { ToolConfiguration, ToolFactory } from "@/common/utils/tools/tools";
import {
  TaskApplyGitPatchToolResultSchema,
  TOOL_DEFINITIONS,
} from "@/common/utils/tools/toolDefinitions";
import { shellQuote } from "@/common/utils/shell";
import { execBuffered } from "@/node/utils/runtime/helpers";
import {
  getSubagentGitPatchMboxPath,
  markSubagentGitPatchArtifactApplied,
  readSubagentGitPatchArtifact,
} from "@/node/services/subagentGitPatchArtifacts";
import { log } from "@/node/services/log";

import { parseToolResult, requireWorkspaceId } from "./toolUtils";

async function copyLocalFileToRuntime(params: {
  runtime: ToolConfiguration["runtime"];
  localPath: string;
  remotePath: string;
  abortSignal?: AbortSignal;
}): Promise<void> {
  const writable = params.runtime.writeFile(params.remotePath, params.abortSignal);
  const writer = writable.getWriter();

  const fileHandle = await fsPromises.open(params.localPath, "r");
  try {
    const buffer = Buffer.alloc(64 * 1024);
    while (true) {
      const { bytesRead } = await fileHandle.read(buffer, 0, buffer.length, null);
      if (bytesRead <= 0) break;
      await writer.write(buffer.subarray(0, bytesRead));
    }

    await writer.close();
  } catch (error) {
    writer.releaseLock();
    throw error;
  } finally {
    await fileHandle.close();
  }
}

export const createTaskApplyGitPatchTool: ToolFactory = (config: ToolConfiguration) => {
  function mergeNotes(...notes: Array<string | undefined>): string | undefined {
    const parts = notes
      .map((note) => (typeof note === "string" ? note.trim() : ""))
      .filter((note) => note.length > 0);

    return parts.length > 0 ? parts.join("\n") : undefined;
  }

  function isPathInsideDir(dirPath: string, filePath: string): boolean {
    const resolvedDir = path.resolve(dirPath);
    const resolvedFile = path.resolve(filePath);
    const relative = path.relative(resolvedDir, resolvedFile);

    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  }

  return tool({
    description: TOOL_DEFINITIONS.task_apply_git_patch.description,
    inputSchema: TOOL_DEFINITIONS.task_apply_git_patch.schema,
    execute: async (args, { abortSignal }): Promise<unknown> => {
      const workspaceId = requireWorkspaceId(config, "task_apply_git_patch");
      assert(config.workspaceSessionDir, "task_apply_git_patch requires workspaceSessionDir");

      const taskId = args.task_id;
      const dryRun = args.dry_run === true;
      const threeWay = args.three_way !== false;
      const force = args.force === true;

      const artifact = await readSubagentGitPatchArtifact(config.workspaceSessionDir, taskId);
      if (!artifact) {
        return parseToolResult(
          TaskApplyGitPatchToolResultSchema,
          {
            success: false as const,
            taskId,
            error: "No git patch artifact found for this taskId.",
          },
          "task_apply_git_patch"
        );
      }

      if (artifact.parentWorkspaceId !== workspaceId) {
        return parseToolResult(
          TaskApplyGitPatchToolResultSchema,
          {
            success: false as const,
            taskId,
            error: "This patch artifact belongs to a different parent workspace.",
            note: "Run task_apply_git_patch from the task's parent workspace.",
          },
          "task_apply_git_patch"
        );
      }

      if (artifact.status === "pending") {
        return parseToolResult(
          TaskApplyGitPatchToolResultSchema,
          {
            success: false as const,
            taskId,
            error: "Patch artifact is still pending generation.",
          },
          "task_apply_git_patch"
        );
      }

      if (artifact.status === "failed") {
        return parseToolResult(
          TaskApplyGitPatchToolResultSchema,
          {
            success: false as const,
            taskId,
            error: artifact.error ?? "Patch artifact generation failed.",
          },
          "task_apply_git_patch"
        );
      }

      if (artifact.status === "skipped") {
        return parseToolResult(
          TaskApplyGitPatchToolResultSchema,
          {
            success: false as const,
            taskId,
            error: "This task produced no commits (patch generation was skipped).",
          },
          "task_apply_git_patch"
        );
      }

      if (artifact.appliedAtMs && !force && !dryRun) {
        return parseToolResult(
          TaskApplyGitPatchToolResultSchema,
          {
            success: false as const,
            taskId,
            error: `Patch already applied at ${new Date(artifact.appliedAtMs).toISOString()}.`,
            note: "Re-run with force=true to apply again.",
          },
          "task_apply_git_patch"
        );
      }

      const expectedPatchPath = getSubagentGitPatchMboxPath(config.workspaceSessionDir, taskId);

      // Defensive: `task_id` is user-controlled input; reject path traversal.
      if (!isPathInsideDir(config.workspaceSessionDir, expectedPatchPath)) {
        return parseToolResult(
          TaskApplyGitPatchToolResultSchema,
          {
            success: false as const,
            taskId,
            error: "Invalid task_id.",
            note: "task_id must not contain path traversal segments.",
          },
          "task_apply_git_patch"
        );
      }

      const safeMboxPath =
        typeof artifact.mboxPath === "string" && artifact.mboxPath.length > 0
          ? isPathInsideDir(config.workspaceSessionDir, artifact.mboxPath)
            ? artifact.mboxPath
            : undefined
          : undefined;

      let patchPathNote =
        artifact.mboxPath && !safeMboxPath
          ? "Ignoring unsafe mboxPath in patch artifact metadata; using canonical patch location."
          : undefined;

      const patchCandidates = [safeMboxPath, expectedPatchPath].filter(
        (candidate): candidate is string => typeof candidate === "string"
      );

      let patchPath: string | null = null;
      for (const candidate of patchCandidates) {
        try {
          const stat = await fsPromises.stat(candidate);
          if (stat.isFile()) {
            patchPath = candidate;
            break;
          }
        } catch {
          // try next candidate
        }
      }

      if (!patchPath) {
        return parseToolResult(
          TaskApplyGitPatchToolResultSchema,
          {
            success: false as const,
            taskId,
            error: "Patch file is missing on disk.",
            note: patchPathNote,
          },
          "task_apply_git_patch"
        );
      }

      if (safeMboxPath && patchPath === expectedPatchPath && safeMboxPath !== expectedPatchPath) {
        patchPathNote = mergeNotes(
          patchPathNote,
          "Patch file not found at metadata mboxPath; using canonical patch location."
        );
      }

      if (!force) {
        const statusResult = await execBuffered(config.runtime, "git status --porcelain", {
          cwd: config.cwd,
          timeout: 10,
        });
        if (statusResult.exitCode !== 0) {
          return parseToolResult(
            TaskApplyGitPatchToolResultSchema,
            {
              success: false as const,
              taskId,
              error: statusResult.stderr.trim() || "git status failed",
              note: patchPathNote,
            },
            "task_apply_git_patch"
          );
        }

        if (statusResult.stdout.trim().length > 0) {
          return parseToolResult(
            TaskApplyGitPatchToolResultSchema,
            {
              success: false as const,
              taskId,
              error: "Working tree is not clean.",
              note: mergeNotes(
                patchPathNote,
                "Commit/stash your changes (or pass force=true) before applying patches."
              ),
            },
            "task_apply_git_patch"
          );
        }
      }

      // Use path.posix.join to preserve forward slashes:
      // - SSH runtime needs POSIX-style paths
      // - Windows local runtime uses drive-qualified paths like C:/Users/... (also with /)
      const remotePatchPath = path.posix.join(
        config.runtimeTempDir,
        `mux-task-${taskId}-series.mbox`
      );

      await copyLocalFileToRuntime({
        runtime: config.runtime,
        localPath: patchPath,
        remotePath: remotePatchPath,
        abortSignal,
      });

      const flags: string[] = [];
      if (threeWay) flags.push("--3way");

      if (dryRun) {
        // `git am` doesn't support a native --dry-run. Instead, apply inside a temporary worktree
        // and discard it. This avoids mutating the current worktree while still exercising `git am`.
        const dryRunId = `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 8)}`;
        const dryRunWorktreePath = path.posix.join(
          config.runtimeTempDir,
          `mux-git-am-dry-run-${taskId}-${dryRunId}`
        );

        const addResult = await execBuffered(
          config.runtime,
          `git worktree add --detach ${shellQuote(dryRunWorktreePath)} HEAD`,
          { cwd: config.cwd, timeout: 60 }
        );
        if (addResult.exitCode !== 0) {
          return parseToolResult(
            TaskApplyGitPatchToolResultSchema,
            {
              success: false as const,
              taskId,
              error:
                addResult.stderr.trim() || addResult.stdout.trim() || "git worktree add failed",
            },
            "task_apply_git_patch"
          );
        }

        try {
          const amCmd = `git am ${flags.join(" ")} ${shellQuote(remotePatchPath)}`.trim();
          const amResult = await execBuffered(config.runtime, amCmd, {
            cwd: dryRunWorktreePath,
            timeout: 300,
          });

          if (amResult.exitCode !== 0) {
            const stderr = amResult.stderr.trim();
            const stdout = amResult.stdout.trim();
            const errorOutput = [stderr, stdout]
              .filter((s) => s.length > 0)
              .join("\n")
              .trim();
            return parseToolResult(
              TaskApplyGitPatchToolResultSchema,
              {
                success: false as const,
                taskId,
                error:
                  errorOutput.length > 0
                    ? errorOutput
                    : `git am failed (exitCode=${amResult.exitCode})`,
                note: mergeNotes(
                  patchPathNote,
                  "Dry run failed; the patch does not apply cleanly. Applying for real will likely require conflict resolution."
                ),
              },
              "task_apply_git_patch"
            );
          }

          return parseToolResult(
            TaskApplyGitPatchToolResultSchema,
            {
              success: true as const,
              taskId,
              appliedCommitCount: artifact.commitCount ?? 0,
              dryRun: true,
              note: mergeNotes(patchPathNote, "Dry run succeeded; no commits were applied."),
            },
            "task_apply_git_patch"
          );
        } finally {
          // Best-effort: clean up the temp worktree. This should never fail the tool call.
          try {
            const abortResult = await execBuffered(config.runtime, "git am --abort", {
              cwd: dryRunWorktreePath,
              timeout: 30,
            });
            if (abortResult.exitCode !== 0) {
              log.debug("task_apply_git_patch: dry-run git am --abort failed", {
                taskId,
                dryRunWorktreePath,
                exitCode: abortResult.exitCode,
                stderr: abortResult.stderr.trim(),
                stdout: abortResult.stdout.trim(),
              });
            }
          } catch (error: unknown) {
            log.debug("task_apply_git_patch: dry-run git am --abort threw", {
              taskId,
              dryRunWorktreePath,
              error,
            });
          }

          try {
            const removeResult = await execBuffered(
              config.runtime,
              `git worktree remove --force ${shellQuote(dryRunWorktreePath)}`,
              { cwd: config.cwd, timeout: 60 }
            );
            if (removeResult.exitCode !== 0) {
              log.debug("task_apply_git_patch: dry-run git worktree remove failed", {
                taskId,
                dryRunWorktreePath,
                exitCode: removeResult.exitCode,
                stderr: removeResult.stderr.trim(),
                stdout: removeResult.stdout.trim(),
              });
            }
          } catch (error: unknown) {
            log.debug("task_apply_git_patch: dry-run git worktree remove threw", {
              taskId,
              dryRunWorktreePath,
              error,
            });
          }

          try {
            const pruneResult = await execBuffered(config.runtime, "git worktree prune", {
              cwd: config.cwd,
              timeout: 60,
            });
            if (pruneResult.exitCode !== 0) {
              log.debug("task_apply_git_patch: dry-run git worktree prune failed", {
                taskId,
                exitCode: pruneResult.exitCode,
                stderr: pruneResult.stderr.trim(),
                stdout: pruneResult.stdout.trim(),
              });
            }
          } catch (error: unknown) {
            log.debug("task_apply_git_patch: dry-run git worktree prune threw", {
              taskId,
              error,
            });
          }
        }
      }

      const amCmd = `git am ${flags.join(" ")} ${shellQuote(remotePatchPath)}`.trim();
      const amResult = await execBuffered(config.runtime, amCmd, { cwd: config.cwd, timeout: 300 });

      if (amResult.exitCode !== 0) {
        const stderr = amResult.stderr.trim();
        const stdout = amResult.stdout.trim();
        const errorOutput = [stderr, stdout]
          .filter((s) => s.length > 0)
          .join("\n")
          .trim();
        return parseToolResult(
          TaskApplyGitPatchToolResultSchema,
          {
            success: false as const,
            taskId,
            error:
              errorOutput.length > 0
                ? errorOutput
                : `git am failed (exitCode=${amResult.exitCode})`,
            note: mergeNotes(
              patchPathNote,
              "If git am stopped due to conflicts, resolve them then run `git am --continue` or `git am --abort`."
            ),
          },
          "task_apply_git_patch"
        );
      }

      let headCommitSha: string | undefined;
      try {
        const headResult = await execBuffered(config.runtime, "git rev-parse HEAD", {
          cwd: config.cwd,
          timeout: 10,
        });
        if (headResult.exitCode === 0) {
          const sha = headResult.stdout.trim();
          if (sha.length > 0) headCommitSha = sha;
        }
      } catch {
        // ignore
      }

      if (!dryRun) {
        await markSubagentGitPatchArtifactApplied({
          workspaceId,
          workspaceSessionDir: config.workspaceSessionDir,
          childTaskId: taskId,
          appliedAtMs: Date.now(),
        });
      }

      return parseToolResult(
        TaskApplyGitPatchToolResultSchema,
        {
          success: true as const,
          taskId,
          appliedCommitCount: artifact.commitCount ?? 0,
          headCommitSha,
          dryRun: dryRun ? true : undefined,
          note: mergeNotes(
            patchPathNote,
            dryRun ? "Dry run succeeded; no commits were applied." : undefined
          ),
        },
        "task_apply_git_patch"
      );
    },
  });
};
