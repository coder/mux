import { tool } from "ai";
import type { FileEditInsertToolArgs, FileEditInsertToolResult } from "@/common/types/tools";
import {
  EDIT_FAILED_NOTE_PREFIX,
  FILE_EDIT_DIFF_OMITTED_MESSAGE,
  NOTE_READ_FILE_RETRY,
} from "@/common/types/tools";
import type { ToolConfiguration, ToolFactory } from "@/common/utils/tools/tools";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import { generateDiff, validateAndCorrectPath, validatePlanModeAccess } from "./fileCommon";
import { executeFileEditOperation } from "./file_edit_operation";
import { convertNewlines, detectFileEol } from "./eol";
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

        // Validate plan mode access restrictions
        const planModeError = await validatePlanModeAccess(file_path, config);
        if (planModeError) {
          return planModeError;
        }

        const exists = await fileExists(config.runtime, resolvedPath, abortSignal);

        if (!exists) {
          try {
            await writeFileString(config.runtime, resolvedPath, content, abortSignal);
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
                content,
                timestamp: newStat.modifiedTime.getTime(),
              });
            } catch {
              // File stat failed, skip recording
            }
          }

          const diff = generateDiff(resolvedPath, "", content);
          return {
            success: true,
            diff: FILE_EDIT_DIFF_OMITTED_MESSAGE,
            ui_only: {
              file_edit: {
                diff,
              },
            },
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

  const fileEol = detectFileEol(originalContent);
  const normalizedContentToInsert = convertNewlines(contentToInsert, fileEol);

  return insertWithGuards(originalContent, normalizedContentToInsert, { before, after });
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
      `Guard mismatch: ${label} substring matched multiple times. Include more surrounding context (e.g., full signature, adjacent lines) to make it unique.`
    );
  }

  return { success: true, index: firstIndex };
}

function resolveGuardAnchor(
  originalContent: string,
  { before, after }: GuardAnchors
): GuardResolutionSuccess | InsertOperationFailure {
  const fileEol = detectFileEol(originalContent);

  if (before !== undefined) {
    const exactBeforeIndexResult = findUniqueSubstringIndex(originalContent, before, "before");
    if (exactBeforeIndexResult.success) {
      return { success: true, index: exactBeforeIndexResult.index + before.length };
    }

    const normalizedBefore = convertNewlines(before, fileEol);
    if (normalizedBefore !== before) {
      const normalizedBeforeIndexResult = findUniqueSubstringIndex(
        originalContent,
        normalizedBefore,
        "before"
      );
      if (!normalizedBeforeIndexResult.success) {
        return normalizedBeforeIndexResult;
      }
      return {
        success: true,
        index: normalizedBeforeIndexResult.index + normalizedBefore.length,
      };
    }

    return exactBeforeIndexResult;
  }

  if (after !== undefined) {
    const exactAfterIndexResult = findUniqueSubstringIndex(originalContent, after, "after");
    if (exactAfterIndexResult.success) {
      return { success: true, index: exactAfterIndexResult.index };
    }

    const normalizedAfter = convertNewlines(after, fileEol);
    if (normalizedAfter !== after) {
      const normalizedAfterIndexResult = findUniqueSubstringIndex(
        originalContent,
        normalizedAfter,
        "after"
      );
      if (!normalizedAfterIndexResult.success) {
        return normalizedAfterIndexResult;
      }
      return { success: true, index: normalizedAfterIndexResult.index };
    }

    return exactAfterIndexResult;
  }

  return guardFailure("Unable to determine insertion point from guards.");
}
