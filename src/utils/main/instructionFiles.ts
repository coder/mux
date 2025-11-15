import * as fs from "fs/promises";
import * as path from "path";
import type { Runtime } from "@/runtime/Runtime";
import { readFileString } from "@/utils/runtime/helpers";

const MARKDOWN_COMMENT_REGEX = /<!--[\s\S]*?-->/g;

function stripMarkdownComments(content: string): string {
  return content.replace(MARKDOWN_COMMENT_REGEX, "").trim();
}

/**
 * Instruction file names to search for, in priority order.
 * The first file found in a directory is used as the base instruction set.
 */
export const INSTRUCTION_FILE_NAMES = ["AGENTS.md", "AGENT.md", "CLAUDE.md"] as const;

/**
 * Local instruction file suffix. If a base instruction file is found,
 * we also look for a matching .local.md variant in the same directory.
 *
 * Example: If AGENTS.md exists, we also check for AGENTS.local.md
 */
export const LOCAL_INSTRUCTION_FILENAME = "AGENTS.local.md";

/**
 * File reader abstraction for reading files from either local fs or Runtime.
 */
interface FileReader {
  readFile(filePath: string): Promise<string>;
}

/**
 * Create a FileReader for local filesystem access.
 */
function createLocalFileReader(): FileReader {
  return {
    readFile: (filePath: string) => fs.readFile(filePath, "utf-8"),
  };
}

/**
 * Create a FileReader for Runtime-based access (supports SSH).
 */
function createRuntimeFileReader(runtime: Runtime): FileReader {
  return {
    readFile: (filePath: string) => readFileString(runtime, filePath),
  };
}

/**
 * Read the first available file from a list using the provided file reader.
 *
 * @param reader - FileReader abstraction (local or runtime)
 * @param directory - Directory to search in
 * @param filenames - List of filenames to try, in priority order
 * @returns Content of the first file found, or null if none exist
 */
async function readFirstAvailableFile(
  reader: FileReader,
  directory: string,
  filenames: readonly string[]
): Promise<string | null> {
  for (const filename of filenames) {
    try {
      return await reader.readFile(path.join(directory, filename));
    } catch {
      continue; // File doesn't exist, try next
    }
  }
  return null;
}

/**
 * Read a base file with optional local variant using the provided file reader.
 *
 * @param reader - FileReader abstraction (local or runtime)
 * @param directory - Directory to search
 * @param baseFilenames - Base filenames to try in priority order
 * @param localFilename - Optional local filename to append if present
 * @returns Combined content or null if no base file exists
 */
async function readFileWithLocalVariant(
  reader: FileReader,
  directory: string,
  baseFilenames: readonly string[],
  localFilename?: string
): Promise<string | null> {
  const baseContent = await readFirstAvailableFile(reader, directory, baseFilenames);
  if (!baseContent) return null;

  let combinedContent = baseContent;

  if (localFilename) {
    try {
      const localContent = await reader.readFile(path.join(directory, localFilename));
      combinedContent = `${combinedContent}\n\n${localContent}`;
    } catch {
      // Local variant missing, keep base only
    }
  }

  const sanitized = stripMarkdownComments(combinedContent);
  return sanitized.length > 0 ? sanitized : null;
}

/**
 * Read an instruction set from a local directory.
 *
 * An instruction set consists of:
 * 1. A base instruction file (AGENTS.md → AGENT.md → CLAUDE.md, first found wins)
 * 2. An optional local instruction file (AGENTS.local.md)
 *
 * If both exist, they are concatenated with a blank line separator.
 *
 * @param directory - Directory to search for instruction files
 * @returns Combined instruction content, or null if no base file exists
 */
export async function readInstructionSet(
  directory: string | null | undefined
): Promise<string | null> {
  if (!directory) return null;
  const reader = createLocalFileReader();
  return readFileWithLocalVariant(
    reader,
    path.resolve(directory),
    INSTRUCTION_FILE_NAMES,
    LOCAL_INSTRUCTION_FILENAME
  );
}

/**
 * Read an instruction set from a workspace using Runtime abstraction.
 * Supports both local and remote (SSH) workspaces.
 *
 * @param runtime - Runtime instance (may be local or SSH)
 * @param directory - Directory to search for instruction files
 * @returns Combined instruction content, or null if no base file exists
 */
export async function readInstructionSetFromRuntime(
  runtime: Runtime,
  directory: string
): Promise<string | null> {
  const reader = createRuntimeFileReader(runtime);
  return readFileWithLocalVariant(
    reader,
    directory,
    INSTRUCTION_FILE_NAMES,
    LOCAL_INSTRUCTION_FILENAME
  );
}

/**
 * Searches for instruction files across multiple directories in priority order.
 *
 * Each directory is searched for a complete instruction set (base + local).
 * All found instruction sets are returned as separate segments.
 *
 * This allows for layered instructions where:
 * - Global instructions (~/.cmux/AGENTS.md) apply to all projects
 * - Project instructions (workspace/AGENTS.md) add project-specific context
 *
 * @param directories - List of directories to search, in priority order
 * @returns Array of instruction segments (one per directory with instructions)
 */
export async function gatherInstructionSets(directories: string[]): Promise<string[]> {
  const segments: string[] = [];

  for (const directory of directories) {
    const instructionSet = await readInstructionSet(directory);
    if (instructionSet) {
      segments.push(instructionSet);
    }
  }

  return segments;
}
