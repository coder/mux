import type { FileEditDiffSuccessBase, FileEditErrorResult } from "@/common/types/tools";
import type { ToolConfiguration } from "@/common/utils/tools/tools";
import {
  generateDiff,
  validateFileSize,
  validatePathInCwd,
  validateAndCorrectPath,
  isPlanFileAccess,
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

    // Determine if this is a plan file access - plan files always use local filesystem
    const isPlanFile = isPlanFileAccess(resolvedPath, config);

    // Select runtime: plan files use localRuntime (always local), others use workspace runtime
    const effectiveRuntime =
      isPlanFile && config.localRuntime ? config.localRuntime : config.runtime;

    // For plan files, resolve path using local runtime since plan files are always local
    const effectiveResolvedPath =
      isPlanFile && config.localRuntime
        ? config.localRuntime.normalizePath(filePath, config.cwd)
        : resolvedPath;

    // Plan mode restriction: only allow editing the plan file
    if (config.mode === "plan" && config.planFilePath) {
      if (!isPlanFile) {
        return {
          success: false,
          error: `In plan mode, only the plan file can be edited. Attempted to edit: ${filePath}`,
        };
      }
      // Skip cwd validation for plan file - it's intentionally outside workspace
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
      fileStat = await effectiveRuntime.stat(effectiveResolvedPath, abortSignal);
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
        error: `Path is a directory, not a file: ${effectiveResolvedPath}`,
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
      originalContent = await readFileString(effectiveRuntime, effectiveResolvedPath, abortSignal);
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
      await writeFileString(
        effectiveRuntime,
        effectiveResolvedPath,
        operationResult.newContent,
        abortSignal
      );
    } catch (err) {
      if (err instanceof RuntimeError) {
        return {
          success: false,
          error: err.message,
        };
      }
      throw err;
    }

    const diff = generateDiff(effectiveResolvedPath, originalContent, operationResult.newContent);

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
