import { tool } from "ai";
import type { FileEditInsertToolArgs, FileEditInsertToolResult } from "@/common/types/tools";
import { EDIT_FAILED_NOTE_PREFIX, NOTE_READ_FILE_RETRY } from "@/common/types/tools";
import type { ToolConfiguration, ToolFactory } from "@/common/utils/tools/tools";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import {
  generateDiff,
  validateAndCorrectPath,
  validatePathInCwd,
  isPlanFileAccess,
} from "./fileCommon";
import { executeFileEditOperation } from "./file_edit_operation";
import { fileExists } from "@/node/utils/runtime/fileExists";
import { writeFileString } from "@/node/utils/runtime/helpers";
import { RuntimeError } from "@/node/runtime/Runtime";

const READ_AND_RETRY_NOTE = `${EDIT_FAILED_NOTE_PREFIX} ${NOTE_READ_FILE_RETRY}`;

interface InsertOperationSuccess {
  success: true;
  newContent: string;
  metadata: Record<string, never>;
}

interface InsertOperationFailure {
  success: false;
  error: string;
  note?: string;
}

interface InsertContentOptions {
  before?: string;
  after?: string;
}

interface GuardResolutionSuccess {
  success: true;
  index: number;
}

function guardFailure(error: string): InsertOperationFailure {
  return {
    success: false,
    error,
    note: READ_AND_RETRY_NOTE,
  };
}

type GuardAnchors = Pick<InsertContentOptions, "before" | "after">;

export const createFileEditInsertTool: ToolFactory = (config: ToolConfiguration) => {
  return tool({
    description: TOOL_DEFINITIONS.file_edit_insert.description,
    inputSchema: TOOL_DEFINITIONS.file_edit_insert.schema,
    execute: async (
      { file_path, content, before, after }: FileEditInsertToolArgs,
      { abortSignal }
    ): Promise<FileEditInsertToolResult> => {
      try {
        const { correctedPath, warning: pathWarning } = validateAndCorrectPath(
          file_path,
          config.cwd,
          config.runtime
        );
        file_path = correctedPath;

        const resolvedPath = config.runtime.normalizePath(file_path, config.cwd);

        // Determine if this is a plan file access - plan files always use local filesystem
        const isPlanFile = isPlanFileAccess(resolvedPath, config);

        // Select runtime: plan files use localRuntime (always local), others use workspace runtime
        const effectiveRuntime =
          isPlanFile && config.localRuntime ? config.localRuntime : config.runtime;

        // For plan files, resolve path using local runtime since plan files are always local
        const effectiveResolvedPath =
          isPlanFile && config.localRuntime
            ? config.localRuntime.normalizePath(file_path, config.cwd)
            : resolvedPath;

        // Plan mode restriction: only allow editing/creating the plan file
        if (config.mode === "plan" && config.planFilePath) {
          if (!isPlanFile) {
            return {
              success: false,
              error: `In plan mode, only the plan file can be edited. Attempted to edit: ${file_path}`,
            };
          }
          // Skip cwd validation for plan file - it's intentionally outside workspace
        } else {
          // Standard cwd validation for non-plan-mode edits
          const pathValidation = validatePathInCwd(file_path, config.cwd, config.runtime);
          if (pathValidation) {
            return {
              success: false,
              error: pathValidation.error,
            };
          }
        }

        const exists = await fileExists(effectiveRuntime, effectiveResolvedPath, abortSignal);

        if (!exists) {
          try {
            await writeFileString(effectiveRuntime, effectiveResolvedPath, content, abortSignal);
          } catch (err) {
            if (err instanceof RuntimeError) {
              return {
                success: false,
                error: err.message,
              };
            }
            throw err;
          }

          const diff = generateDiff(effectiveResolvedPath, "", content);
          return {
            success: true,
            diff,
            ...(pathWarning && { warning: pathWarning }),
          };
        }

        return executeFileEditOperation({
          config,
          filePath: file_path,
          abortSignal,
          operation: (originalContent) =>
            insertContent(originalContent, content, {
              before,
              after,
            }),
        });
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "EACCES") {
          return {
            success: false,
            error: `Permission denied: ${file_path}`,
          };
        }

        const message = error instanceof Error ? error.message : String(error);
        return {
          success: false,
          error: `Failed to insert content: ${message}`,
        };
      }
    },
  });
};

function insertContent(
  originalContent: string,
  contentToInsert: string,
  options: InsertContentOptions
): InsertOperationSuccess | InsertOperationFailure {
  const { before, after } = options;

  if (before !== undefined && after !== undefined) {
    return guardFailure("Provide only one of before or after (not both).");
  }

  if (before === undefined && after === undefined) {
    return guardFailure("Provide either a before or after guard when editing existing files.");
  }

  return insertWithGuards(originalContent, contentToInsert, { before, after });
}

function insertWithGuards(
  originalContent: string,
  contentToInsert: string,
  anchors: GuardAnchors
): InsertOperationSuccess | InsertOperationFailure {
  const anchorResult = resolveGuardAnchor(originalContent, anchors);
  if (!anchorResult.success) {
    return anchorResult;
  }

  const newContent =
    originalContent.slice(0, anchorResult.index) +
    contentToInsert +
    originalContent.slice(anchorResult.index);

  return {
    success: true,
    newContent,
    metadata: {},
  };
}

function findUniqueSubstringIndex(
  haystack: string,
  needle: string,
  label: "before" | "after"
): GuardResolutionSuccess | InsertOperationFailure {
  const firstIndex = haystack.indexOf(needle);
  if (firstIndex === -1) {
    return guardFailure(`Guard mismatch: unable to find ${label} substring in the current file.`);
  }

  const secondIndex = haystack.indexOf(needle, firstIndex + needle.length);
  if (secondIndex !== -1) {
    return guardFailure(
      `Guard mismatch: ${label} substring matched multiple times. Provide a more specific string.`
    );
  }

  return { success: true, index: firstIndex };
}

function resolveGuardAnchor(
  originalContent: string,
  { before, after }: GuardAnchors
): GuardResolutionSuccess | InsertOperationFailure {
  if (before !== undefined) {
    const beforeIndexResult = findUniqueSubstringIndex(originalContent, before, "before");
    if (!beforeIndexResult.success) {
      return beforeIndexResult;
    }
    return { success: true, index: beforeIndexResult.index + before.length };
  }

  if (after !== undefined) {
    const afterIndexResult = findUniqueSubstringIndex(originalContent, after, "after");
    if (!afterIndexResult.success) {
      return afterIndexResult;
    }
    return { success: true, index: afterIndexResult.index };
  }

  return guardFailure("Unable to determine insertion point from guards.");
}
