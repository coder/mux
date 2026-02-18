import * as path from "node:path";
import assert from "node:assert/strict";
import * as fsPromises from "fs/promises";

import type { Config } from "@/node/config";
import {
  coerceNonEmptyString,
  tryReadGitHeadCommitSha,
  findWorkspaceEntry,
} from "@/node/services/taskUtils";
import { log } from "@/node/services/log";
import { readAgentDefinition } from "@/node/services/agentDefinitions/agentDefinitionsService";
import { resolveAgentInheritanceChain } from "@/node/services/agentDefinitions/resolveAgentInheritanceChain";
import { isExecLikeEditingCapableInResolvedChain } from "@/common/utils/agentTools";
import { createRuntimeForWorkspace } from "@/node/runtime/runtimeHelpers";
import { execBuffered } from "@/node/utils/runtime/helpers";
import { AgentIdSchema } from "@/common/orpc/schemas";
import {
  getSubagentGitPatchMboxPath,
  upsertSubagentGitPatchArtifact,
} from "@/node/services/subagentGitPatchArtifacts";
import { shellQuote } from "@/common/utils/shell";
import { streamToString } from "@/node/runtime/streamUtils";
import { getErrorMessage } from "@/common/utils/errors";

/** Callback invoked after patch generation completes (success or failure). */
export type OnPatchGenerationComplete = (childWorkspaceId: string) => Promise<void>;

async function writeReadableStreamToLocalFile(
  stream: ReadableStream<Uint8Array>,
  filePath: string
): Promise<void> {
  assert(filePath.length > 0, "writeReadableStreamToLocalFile: filePath must be non-empty");

  await fsPromises.mkdir(path.dirname(filePath), { recursive: true });

  const fileHandle = await fsPromises.open(filePath, "w");
  try {
    const reader = stream.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          await fileHandle.write(value);
        }
      }
    } finally {
      reader.releaseLock();
    }
  } finally {
    await fileHandle.close();
  }
}

// ---------------------------------------------------------------------------
// GitPatchArtifactService
// ---------------------------------------------------------------------------

/**
 * Handles git-format-patch artifact generation for subagent tasks.
 *
 * Extracted from TaskService to keep patch-specific logic self-contained.
 */
export class GitPatchArtifactService {
  private readonly pendingJobsByTaskId = new Map<string, Promise<void>>();

  constructor(private readonly config: Config) {}

  /**
   * If the child workspace is an exec-like agent, write a pending patch artifact
   * marker and kick off background `git format-patch` generation.
   *
   * @param onComplete - called after generation finishes (success *or* failure),
   *   typically used to trigger reported-leaf-task cleanup.
   */
  async maybeStartGeneration(
    parentWorkspaceId: string,
    childWorkspaceId: string,
    onComplete: OnPatchGenerationComplete
  ): Promise<void> {
    assert(
      parentWorkspaceId.length > 0,
      "maybeStartGeneration: parentWorkspaceId must be non-empty"
    );
    assert(childWorkspaceId.length > 0, "maybeStartGeneration: childWorkspaceId must be non-empty");

    const parentSessionDir = this.config.getSessionDir(parentWorkspaceId);

    // Write a pending marker before we attempt cleanup, so the reported task workspace isn't deleted
    // while we're still reading commits from it.
    const nowMs = Date.now();
    const cfg = this.config.loadConfigOrDefault();
    const childEntry = findWorkspaceEntry(cfg, childWorkspaceId);

    // Only exec-like subagents are expected to make commits that should be handed back to the parent.
    // NOTE: Custom agents can inherit from exec (base: exec). Those should also generate patches,
    // but read-only subagents (e.g. explore) should not.
    const childAgentIdRaw = coerceNonEmptyString(
      childEntry?.workspace.agentId ?? childEntry?.workspace.agentType
    );
    const childAgentId = childAgentIdRaw?.toLowerCase();
    if (!childAgentId) {
      return;
    }

    let shouldGeneratePatch = childAgentId === "exec";

    if (!shouldGeneratePatch) {
      const parsedChildAgentId = AgentIdSchema.safeParse(childAgentId);
      if (parsedChildAgentId.success) {
        const agentId = parsedChildAgentId.data;

        // Prefer resolving agent inheritance from the parent workspace: project agents may be untracked
        // (and therefore absent from child worktrees), but they are always present in the parent that
        // spawned the task.
        const agentDiscoveryEntry = findWorkspaceEntry(cfg, parentWorkspaceId) ?? childEntry;
        const agentDiscoveryWs = agentDiscoveryEntry?.workspace;

        const agentWorkspacePath = coerceNonEmptyString(agentDiscoveryWs?.path);
        const runtimeConfig = agentDiscoveryWs?.runtimeConfig;

        if (agentDiscoveryEntry && agentWorkspacePath && runtimeConfig) {
          const fallbackName =
            agentWorkspacePath.split("/").pop() ?? agentWorkspacePath.split("\\").pop() ?? "";
          const workspaceName =
            coerceNonEmptyString(agentDiscoveryWs?.name) ?? coerceNonEmptyString(fallbackName);

          if (workspaceName) {
            const runtime = createRuntimeForWorkspace({
              runtimeConfig,
              projectPath: agentDiscoveryEntry.projectPath,
              name: workspaceName,
            });

            try {
              const agentDefinition = await readAgentDefinition(
                runtime,
                agentWorkspacePath,
                agentId
              );
              const chain = await resolveAgentInheritanceChain({
                runtime,
                workspacePath: agentWorkspacePath,
                agentId,
                agentDefinition,
                workspaceId: childWorkspaceId,
              });

              shouldGeneratePatch = isExecLikeEditingCapableInResolvedChain(chain);
            } catch {
              // ignore - treat as non-exec-like
            }
          }
        }
      }
    }

    if (!shouldGeneratePatch) {
      return;
    }

    const baseCommitSha =
      coerceNonEmptyString(childEntry?.workspace.taskBaseCommitSha) ?? undefined;

    const artifact = await upsertSubagentGitPatchArtifact({
      workspaceId: parentWorkspaceId,
      workspaceSessionDir: parentSessionDir,
      childTaskId: childWorkspaceId,
      updater: (existing) => {
        if (existing && existing.status !== "pending") {
          return existing;
        }

        return {
          ...(existing ?? {}),
          childTaskId: childWorkspaceId,
          parentWorkspaceId,
          createdAtMs: existing?.createdAtMs ?? nowMs,
          updatedAtMs: nowMs,
          status: "pending",
          baseCommitSha: baseCommitSha ?? existing?.baseCommitSha,
        };
      },
    });

    if (artifact.status !== "pending") {
      return;
    }

    if (this.pendingJobsByTaskId.has(childWorkspaceId)) {
      return;
    }

    let job: Promise<void>;
    try {
      job = this.generate(parentWorkspaceId, childWorkspaceId, onComplete)
        .catch(async (error: unknown) => {
          log.error("Subagent git patch generation failed", {
            parentWorkspaceId,
            childWorkspaceId,
            error,
          });

          // Best-effort: if generation failed before it could update the artifact status,
          // mark it failed so the parent isn't blocked forever by a pending marker.
          try {
            await upsertSubagentGitPatchArtifact({
              workspaceId: parentWorkspaceId,
              workspaceSessionDir: parentSessionDir,
              childTaskId: childWorkspaceId,
              updater: (existing) => {
                if (existing && existing.status !== "pending") {
                  return existing;
                }

                const failedAtMs = Date.now();
                return {
                  ...(existing ?? {}),
                  childTaskId: childWorkspaceId,
                  parentWorkspaceId,
                  createdAtMs: existing?.createdAtMs ?? failedAtMs,
                  updatedAtMs: failedAtMs,
                  status: "failed",
                  error: getErrorMessage(error),
                };
              },
            });
          } catch (updateError: unknown) {
            log.error("Failed to mark subagent git patch artifact as failed", {
              parentWorkspaceId,
              childWorkspaceId,
              error: updateError,
            });
          }
        })
        .finally(() => {
          this.pendingJobsByTaskId.delete(childWorkspaceId);
        });
    } catch (error: unknown) {
      // If scheduling fails synchronously, don't leave the artifact stuck in `pending`.
      await upsertSubagentGitPatchArtifact({
        workspaceId: parentWorkspaceId,
        workspaceSessionDir: parentSessionDir,
        childTaskId: childWorkspaceId,
        updater: (existing) => {
          if (existing && existing.status !== "pending") {
            return existing;
          }

          const failedAtMs = Date.now();
          return {
            ...(existing ?? {}),
            childTaskId: childWorkspaceId,
            parentWorkspaceId,
            createdAtMs: existing?.createdAtMs ?? failedAtMs,
            updatedAtMs: failedAtMs,
            status: "failed",
            error: getErrorMessage(error),
          };
        },
      });
      return;
    }

    this.pendingJobsByTaskId.set(childWorkspaceId, job);
  }

  private async generate(
    parentWorkspaceId: string,
    childWorkspaceId: string,
    onComplete: OnPatchGenerationComplete
  ): Promise<void> {
    assert(parentWorkspaceId.length > 0, "generate: parentWorkspaceId must be non-empty");
    assert(childWorkspaceId.length > 0, "generate: childWorkspaceId must be non-empty");

    const parentSessionDir = this.config.getSessionDir(parentWorkspaceId);

    const updateArtifact = async (
      updater: Parameters<typeof upsertSubagentGitPatchArtifact>[0]["updater"]
    ): Promise<void> => {
      await upsertSubagentGitPatchArtifact({
        workspaceId: parentWorkspaceId,
        workspaceSessionDir: parentSessionDir,
        childTaskId: childWorkspaceId,
        updater,
      });
    };

    const nowMs = Date.now();

    try {
      const cfg = this.config.loadConfigOrDefault();
      const entry = findWorkspaceEntry(cfg, childWorkspaceId);

      if (!entry) {
        await updateArtifact((existing) => ({
          ...(existing ?? {}),
          childTaskId: childWorkspaceId,
          parentWorkspaceId,
          createdAtMs: existing?.createdAtMs ?? nowMs,
          updatedAtMs: nowMs,
          status: "failed",
          error: "Task workspace not found in config.",
        }));
        return;
      }

      const ws = entry.workspace;

      const workspacePath = coerceNonEmptyString(ws.path);
      if (!workspacePath) {
        await updateArtifact((existing) => ({
          ...(existing ?? {}),
          childTaskId: childWorkspaceId,
          parentWorkspaceId,
          createdAtMs: existing?.createdAtMs ?? nowMs,
          updatedAtMs: nowMs,
          status: "failed",
          error: "Task workspace path missing.",
        }));
        return;
      }

      if (!ws.runtimeConfig) {
        await updateArtifact((existing) => ({
          ...(existing ?? {}),
          childTaskId: childWorkspaceId,
          parentWorkspaceId,
          createdAtMs: existing?.createdAtMs ?? nowMs,
          updatedAtMs: nowMs,
          status: "failed",
          error: "Task runtimeConfig missing.",
        }));
        return;
      }

      const fallbackName = workspacePath.split("/").pop() ?? workspacePath.split("\\").pop() ?? "";
      const workspaceName = coerceNonEmptyString(ws.name) ?? coerceNonEmptyString(fallbackName);
      if (!workspaceName) {
        await updateArtifact((existing) => ({
          ...(existing ?? {}),
          childTaskId: childWorkspaceId,
          parentWorkspaceId,
          createdAtMs: existing?.createdAtMs ?? nowMs,
          updatedAtMs: nowMs,
          status: "failed",
          error: "Task workspace name missing.",
        }));
        return;
      }

      const runtime = createRuntimeForWorkspace({
        runtimeConfig: ws.runtimeConfig,
        projectPath: entry.projectPath,
        name: workspaceName,
      });

      let baseCommitSha = coerceNonEmptyString(ws.taskBaseCommitSha);
      if (!baseCommitSha) {
        const trunkBranch =
          coerceNonEmptyString(ws.taskTrunkBranch) ??
          coerceNonEmptyString(findWorkspaceEntry(cfg, parentWorkspaceId)?.workspace.name);

        if (!trunkBranch) {
          await updateArtifact((existing) => ({
            ...(existing ?? {}),
            childTaskId: childWorkspaceId,
            parentWorkspaceId,
            createdAtMs: existing?.createdAtMs ?? nowMs,
            updatedAtMs: nowMs,
            status: "failed",
            error:
              "taskBaseCommitSha missing and could not determine trunk branch for merge-base fallback.",
          }));
          return;
        }

        const mergeBaseResult = await execBuffered(
          runtime,
          `git merge-base ${shellQuote(trunkBranch)} HEAD`,
          { cwd: workspacePath, timeout: 30 }
        );
        if (mergeBaseResult.exitCode !== 0) {
          await updateArtifact((existing) => ({
            ...(existing ?? {}),
            childTaskId: childWorkspaceId,
            parentWorkspaceId,
            createdAtMs: existing?.createdAtMs ?? nowMs,
            updatedAtMs: nowMs,
            status: "failed",
            error: `git merge-base failed: ${mergeBaseResult.stderr.trim() || "unknown error"}`,
          }));
          return;
        }

        baseCommitSha = mergeBaseResult.stdout.trim();
      }

      const headCommitSha = await tryReadGitHeadCommitSha(runtime, workspacePath);
      if (!headCommitSha) {
        await updateArtifact((existing) => ({
          ...(existing ?? {}),
          childTaskId: childWorkspaceId,
          parentWorkspaceId,
          createdAtMs: existing?.createdAtMs ?? nowMs,
          updatedAtMs: nowMs,
          status: "failed",
          error: "git rev-parse HEAD failed.",
        }));
        return;
      }

      const countResult = await execBuffered(
        runtime,
        `git rev-list --count ${baseCommitSha}..${headCommitSha}`,
        { cwd: workspacePath, timeout: 30 }
      );
      if (countResult.exitCode !== 0) {
        await updateArtifact((existing) => ({
          ...(existing ?? {}),
          childTaskId: childWorkspaceId,
          parentWorkspaceId,
          createdAtMs: existing?.createdAtMs ?? nowMs,
          updatedAtMs: nowMs,
          status: "failed",
          baseCommitSha,
          headCommitSha,
          error: `git rev-list failed: ${countResult.stderr.trim() || "unknown error"}`,
        }));
        return;
      }

      const commitCount = Number.parseInt(countResult.stdout.trim(), 10);
      if (!Number.isFinite(commitCount) || commitCount < 0) {
        await updateArtifact((existing) => ({
          ...(existing ?? {}),
          childTaskId: childWorkspaceId,
          parentWorkspaceId,
          createdAtMs: existing?.createdAtMs ?? nowMs,
          updatedAtMs: nowMs,
          status: "failed",
          baseCommitSha,
          headCommitSha,
          error: `Invalid commit count: ${countResult.stdout.trim()}`,
        }));
        return;
      }

      if (commitCount === 0) {
        await updateArtifact((existing) => ({
          ...(existing ?? {}),
          childTaskId: childWorkspaceId,
          parentWorkspaceId,
          createdAtMs: existing?.createdAtMs ?? nowMs,
          updatedAtMs: nowMs,
          status: "skipped",
          baseCommitSha,
          headCommitSha,
          commitCount,
          error: undefined,
        }));
        return;
      }

      const patchPath = getSubagentGitPatchMboxPath(parentSessionDir, childWorkspaceId);

      const formatPatchStream = await runtime.exec(
        `git format-patch --stdout --binary ${baseCommitSha}..${headCommitSha}`,
        { cwd: workspacePath, timeout: 120 }
      );
      await formatPatchStream.stdin.close();

      const stderrPromise = streamToString(formatPatchStream.stderr);
      const writePromise = writeReadableStreamToLocalFile(formatPatchStream.stdout, patchPath);

      const [exitCode, stderr] = await Promise.all([
        formatPatchStream.exitCode,
        stderrPromise,
        writePromise,
      ]);

      if (exitCode !== 0) {
        // Leave no half-written patches around.
        await fsPromises.rm(patchPath, { force: true });

        await updateArtifact((existing) => ({
          ...(existing ?? {}),
          childTaskId: childWorkspaceId,
          parentWorkspaceId,
          createdAtMs: existing?.createdAtMs ?? nowMs,
          updatedAtMs: Date.now(),
          status: "failed",
          baseCommitSha,
          headCommitSha,
          commitCount,
          error: `git format-patch failed (exitCode=${exitCode}): ${stderr.trim() || "unknown error"}`,
        }));
        return;
      }

      await updateArtifact((existing) => ({
        ...(existing ?? {}),
        childTaskId: childWorkspaceId,
        parentWorkspaceId,
        createdAtMs: existing?.createdAtMs ?? nowMs,
        updatedAtMs: Date.now(),
        status: "ready",
        baseCommitSha,
        headCommitSha,
        commitCount,
        mboxPath: patchPath,
        error: undefined,
      }));
    } catch (error: unknown) {
      await updateArtifact((existing) => ({
        ...(existing ?? {}),
        childTaskId: childWorkspaceId,
        parentWorkspaceId,
        createdAtMs: existing?.createdAtMs ?? nowMs,
        updatedAtMs: Date.now(),
        status: "failed",
        error: getErrorMessage(error),
      }));
    } finally {
      // Unblock auto-cleanup once the patch generation attempt has finished.
      await onComplete(childWorkspaceId);
    }
  }
}
