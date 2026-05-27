import * as fs from "fs/promises";
import * as path from "path";
import type {
  InstructionFile,
  InstructionScope,
  InstructionSet,
} from "@/common/types/instructions";
import type { Runtime } from "@/node/runtime/Runtime";
import { readFileString } from "@/node/utils/runtime/helpers";

const MARKDOWN_COMMENT_REGEX = /<!--[\s\S]*?-->/g;

function stripMarkdownComments(content: string): string {
  return content.replace(MARKDOWN_COMMENT_REGEX, "").trim();
}

/**
 * Instruction file names to search for, in priority order.
 * The first file found in a directory is used as the base instruction set.
 */
const INSTRUCTION_FILE_NAMES = ["AGENTS.md", "AGENT.md", "CLAUDE.md"] as const;

/**
 * Local instruction file suffix. If a base instruction file is found,
 * we also look for a matching .local.md variant in the same directory.
 *
 * Example: If AGENTS.md exists, we also check for AGENTS.local.md
 */
const LOCAL_INSTRUCTION_FILENAME = "AGENTS.local.md";

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

type ReadInstructionFileResult = { exists: false } | { exists: true; file: InstructionFile | null };

/** Read a single instruction file via the given reader, returning structured info. */
async function readSingleFile(
  reader: FileReader,
  directory: string,
  filename: string,
  scope: InstructionScope,
  isLocal: boolean,
  projectName: string | undefined
): Promise<ReadInstructionFileResult> {
  let raw: string;
  try {
    raw = await reader.readFile(path.join(directory, filename));
  } catch {
    return { exists: false };
  }
  const sanitized = stripMarkdownComments(raw);
  if (sanitized.length === 0) return { exists: true, file: null };
  return {
    exists: true,
    file: {
      path: path.join(directory, filename),
      filename,
      isLocal,
      scope,
      projectName: projectName ?? null,
      content: sanitized,
      bytes: Buffer.byteLength(sanitized, "utf-8"),
      tokens: null,
    },
  };
}

/** Try each base filename in priority order; return the first that exists. */
async function readBaseInstructionFile(
  reader: FileReader,
  directory: string,
  scope: InstructionScope,
  projectName: string | undefined
): Promise<ReadInstructionFileResult> {
  for (const filename of INSTRUCTION_FILE_NAMES) {
    const result = await readSingleFile(reader, directory, filename, scope, false, projectName);
    // Existence, not post-comment content, decides base-file priority. This
    // preserves the historical behavior where an AGENTS.md containing only
    // comments still enables AGENTS.local.md and prevents lower-priority
    // AGENT.md/CLAUDE.md files from taking over.
    if (result.exists) return result;
  }
  return { exists: false };
}

/**
 * Read a complete instruction set (base + optional .local.md variant) from the
 * given directory using the supplied reader. Returns null when no base file
 * exists or both files are empty after comment stripping.
 *
 * @param scope        Logical scope to tag the resulting files with.
 * @param projectName  Optional project name (only meaningful for "project" scope).
 */
async function readInstructionSetWith(
  reader: FileReader,
  directory: string,
  scope: InstructionScope,
  projectName?: string
): Promise<InstructionSet | null> {
  const base = await readBaseInstructionFile(reader, directory, scope, projectName);
  if (!base.exists) return null;

  const local = await readSingleFile(
    reader,
    directory,
    LOCAL_INSTRUCTION_FILENAME,
    scope,
    true,
    projectName
  );

  const files: InstructionFile[] = [base.file, local.exists ? local.file : null].filter(
    (file): file is InstructionFile => file != null
  );
  if (files.length === 0) return null;

  const combinedContent = files.map((f) => f.content).join("\n\n");

  return {
    scope,
    projectName: projectName ?? null,
    directory,
    files,
    combinedContent,
  };
}

/**
 * Read an instruction set from a local directory.
 *
 * An instruction set consists of:
 * 1. A base instruction file (AGENTS.md → AGENT.md → CLAUDE.md, first found wins)
 * 2. An optional local instruction file (AGENTS.local.md)
 *
 * If both exist, they are concatenated with a blank line separator inside the
 * returned set's `combinedContent`.
 *
 * @param directory - Directory to search for instruction files
 * @param scope     - Scope to tag the resulting set with
 * @param projectName - Project name (only for "project" scope)
 * @returns Structured instruction set, or null if no base file exists
 */
export async function readInstructionSet(
  directory: string | null | undefined,
  scope: InstructionScope,
  projectName?: string
): Promise<InstructionSet | null> {
  if (!directory) return null;
  return readInstructionSetWith(
    createLocalFileReader(),
    path.resolve(directory),
    scope,
    projectName
  );
}

/**
 * Read an instruction set from a workspace using the Runtime abstraction.
 * Supports both local and remote (SSH/Docker/devcontainer) workspaces.
 *
 * @param runtime    - Runtime instance (may be local or remote)
 * @param directory  - Directory to search for instruction files
 * @param scope      - Scope to tag the resulting set with
 * @param projectName - Project name (only for "project" scope)
 */
export async function readInstructionSetFromRuntime(
  runtime: Runtime,
  directory: string,
  scope: InstructionScope,
  projectName?: string
): Promise<InstructionSet | null> {
  return readInstructionSetWith(createRuntimeFileReader(runtime), directory, scope, projectName);
}

/**
 * Searches for instruction files across multiple directories in priority order.
 *
 * Each directory is searched for a complete instruction set (base + local).
 * All found instruction sets are returned as separate entries.
 *
 * This allows for layered instructions where:
 * - Global instructions (~/.mux/AGENTS.md) apply to all projects
 * - Project instructions (workspace/AGENTS.md) add project-specific context
 *
 * @param directories - List of (directory, scope, projectName?) tuples in priority order
 * @returns Array of instruction sets (one per directory with instructions)
 */
export async function gatherInstructionSets(
  directories: ReadonlyArray<{
    directory: string;
    scope: InstructionScope;
    projectName?: string;
  }>
): Promise<InstructionSet[]> {
  const sets: InstructionSet[] = [];
  for (const { directory, scope, projectName } of directories) {
    const set = await readInstructionSet(directory, scope, projectName);
    if (set) sets.push(set);
  }
  return sets;
}
