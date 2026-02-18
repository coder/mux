import {
  FILE_EDIT_DIFF_OMITTED_MESSAGE,
  type FileEditDiffSuccessBase,
  type FileEditErrorResult,
} from "@/common/types/tools";
import type { ToolConfiguration } from "@/common/utils/tools/tools";
import {
  generateDiff,
  validateFileSize,
  validateAndCorrectPath,
  validatePlanModeAccess,
} from "./fileCommon";
import { RuntimeError } from "@/node/runtime/Runtime";
import { readFileString, writeFileString } from "@/node/utils/runtime/helpers";
import { getErrorMessage } from "@/common/utils/errors";
import { attachModelOnlyToolNotifications } from "@/common/utils/tools/internalToolResultFields";
import { DOOM_LOOP_EDIT_THRESHOLD } from "@/node/services/streamGuardrails/StreamEditTracker";

type FileEditOperationResult<TMetadata> =
  | {
      success: true;
      newContent: string;
      metadata: TMetadata;
    }
  | {
      success: false;
      error: string;
      note?: string; // Agent-only message (not displayed in UI)
    };

interface ExecuteFileEditOperationOptions<TMetadata> {
  config: ToolConfiguration;
  filePath: string;
  operation: (
    originalContent: string
  ) => FileEditOperationResult<TMetadata> | Promise<FileEditOperationResult<TMetadata>>;
  abortSignal?: AbortSignal;
}

/**
 * Shared execution pipeline for file edit tools.
 * Handles validation, file IO, diff generation, and common error handling.
 */
export async function executeFileEditOperation<TMetadata>({
  config,
  filePath,
  operation,
  abortSignal,
}: ExecuteFileEditOperationOptions<TMetadata>): Promise<
  FileEditErrorResult | (FileEditDiffSuccessBase & TMetadata)
> {
  try {
    // Validate and auto-correct redundant path prefix
    const { correctedPath: validatedPath, warning: pathWarning } = validateAndCorrectPath(
      filePath,
      config.cwd,
      config.runtime
    );
    filePath = validatedPath;

    // Use runtime's normalizePath method to resolve paths correctly for both local and SSH runtimes
    // This ensures path resolution uses runtime-specific semantics instead of Node.js path module
    const resolvedPath = config.runtime.normalizePath(filePath, config.cwd);

    // Validate plan mode access restrictions
    const planModeError = await validatePlanModeAccess(filePath, config);
    if (planModeError) {
      return planModeError;
    }

    // Check if file exists and get stats using runtime
    let fileStat;
    try {
      fileStat = await config.runtime.stat(resolvedPath, abortSignal);
    } catch (err) {
      if (err instanceof RuntimeError) {
        return {
          success: false,
          error: err.message,
        };
      }
      throw err;
    }

    if (fileStat.isDirectory) {
      return {
        success: false,
        error: `Path is a directory, not a file: ${resolvedPath}`,
      };
    }

    const sizeValidation = validateFileSize(fileStat);
    if (sizeValidation) {
      return {
        success: false,
        error: sizeValidation.error,
      };
    }

    // Read file content using runtime helper
    let originalContent: string;
    try {
      originalContent = await readFileString(config.runtime, resolvedPath, abortSignal);
    } catch (err) {
      if (err instanceof RuntimeError) {
        return {
          success: false,
          error: err.message,
        };
      }
      throw err;
    }

    const operationResult = await Promise.resolve(operation(originalContent));
    if (!operationResult.success) {
      return {
        success: false,
        error: operationResult.error,
        note: operationResult.note, // Pass through agent-only message
      };
    }

    // Write file using runtime helper
    try {
      await writeFileString(config.runtime, resolvedPath, operationResult.newContent, abortSignal);
    } catch (err) {
      if (err instanceof RuntimeError) {
        return {
          success: false,
          error: err.message,
        };
      }
      throw err;
    }

    let doomLoopNudge: string | undefined;

    // Record file state for post-compaction attachment tracking
    if (config.recordFileState) {
      try {
        const newStat = await config.runtime.stat(resolvedPath, abortSignal);
        config.recordFileState(resolvedPath, {
          content: operationResult.newContent,
          timestamp: newStat.modifiedTime.getTime(),
        });
      } catch {
        // File stat failed, skip recording (shouldn't happen since we just wrote it)
      }
    }

    // Track repeated edits to detect potential doom loops in exec mode.
    // Reset verification state so pre-edit validation doesn't count.
    if (!config.planFileOnly && config.editTracker) {
      const editCount = config.editTracker.recordEdit(resolvedPath);
      config.verificationTracker?.resetValidation();
      if (config.editTracker.shouldNudge(resolvedPath, DOOM_LOOP_EDIT_THRESHOLD)) {
        config.editTracker.markNudged(resolvedPath);
        doomLoopNudge = `<notification>Potential doom loop: you have edited ${resolvedPath} ${editCount} times this stream. Step back and reconsider:\n- Re-read the latest error/output carefully.\n- Verify your assumptions about the problem.\n- Consider a fundamentally different approach (not a small variation of what you've been trying).</notification>`;
      }
    }

    const diff = generateDiff(resolvedPath, originalContent, operationResult.newContent);

    const baseResult: FileEditDiffSuccessBase & TMetadata = {
      success: true,
      diff: FILE_EDIT_DIFF_OMITTED_MESSAGE,
      ui_only: {
        file_edit: {
          diff,
        },
      },
      ...operationResult.metadata,
      ...(pathWarning ? { warning: pathWarning } : {}),
    };

    if (doomLoopNudge) {
      return attachModelOnlyToolNotifications(baseResult, [doomLoopNudge]) as typeof baseResult;
    }

    return baseResult;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) {
      const nodeError = error as { code?: string };
      if (nodeError.code === "ENOENT") {
        return {
          success: false,
          error: `File not found: ${filePath}`,
        };
      }

      if (nodeError.code === "EACCES") {
        return {
          success: false,
          error: `Permission denied: ${filePath}`,
        };
      }
    }

    const message = getErrorMessage(error);
    return {
      success: false,
      error: `Failed to edit file: ${message}`,
    };
  }
}
