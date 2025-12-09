import type { FileEditDiffSuccessBase, FileEditErrorResult } from "@/common/types/tools";
import type { ToolConfiguration } from "@/common/utils/tools/tools";
import {
  generateDiff,
  validateFileSize,
  validatePathInCwd,
  validateAndCorrectPath,
  isPlanFilePath,
} from "./fileCommon";
import { RuntimeError } from "@/node/runtime/Runtime";
import { readFileString, writeFileString } from "@/node/utils/runtime/helpers";

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

    // Plan mode restriction: only allow editing the plan file
    if (config.mode === "plan" && config.planFilePath) {
      if (!(await isPlanFilePath(filePath, config))) {
        return {
          success: false,
          error: `In plan mode, only the plan file can be edited. Attempted to edit: ${filePath}`,
        };
      }
      // Skip cwd validation for plan file - it may be outside workspace
    } else {
      // Standard cwd validation for non-plan-mode edits
      const pathValidation = validatePathInCwd(filePath, config.cwd, config.runtime);
      if (pathValidation) {
        return {
          success: false,
          error: pathValidation.error,
        };
      }
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

    const diff = generateDiff(resolvedPath, originalContent, operationResult.newContent);

    return {
      success: true,
      diff,
      ...operationResult.metadata,
      ...(pathWarning && { warning: pathWarning }),
    };
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

    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: `Failed to edit file: ${message}`,
    };
  }
}
