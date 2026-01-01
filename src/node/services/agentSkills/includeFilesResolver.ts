/**
 * Resolves `include_files` glob patterns for agent skills into file content.
 *
 * Provides a unified XML representation for context files using the `<@path>` tag format.
 */
import * as path from "path";
import picomatch from "picomatch";

import type { Runtime } from "@/node/runtime/Runtime";
import { SSHRuntime } from "@/node/runtime/SSHRuntime";
import { shellQuote } from "@/node/runtime/backgroundCommands";
import { execBuffered, readFileString } from "@/node/utils/runtime/helpers";
import { log } from "@/node/services/log";

// Conservative limits for included files
const MAX_INCLUDE_FILES = 20;
const MAX_BYTES_PER_FILE = 32 * 1024; // 32KB per file
const MAX_TOTAL_BYTES = 128 * 1024; // 128KB total across all included files
const MAX_LINES_PER_FILE = 500;

export interface IncludedFile {
  /** Path relative to skill directory */
  path: string;
  /** File content */
  content: string;
  /** Whether content was truncated */
  truncated: boolean;
}

export interface IncludeFilesResult {
  files: IncludedFile[];
  /** Patterns that had errors during expansion */
  errors: Array<{ pattern: string; error: string }>;
}

/**
 * Guess code fence language from file extension for syntax highlighting.
 */
function guessCodeFenceLanguage(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const langMap: Record<string, string> = {
    ".ts": "ts",
    ".tsx": "tsx",
    ".js": "js",
    ".jsx": "jsx",
    ".json": "json",
    ".md": "md",
    ".yml": "yaml",
    ".yaml": "yaml",
    ".sh": "sh",
    ".bash": "bash",
    ".py": "py",
    ".go": "go",
    ".rs": "rs",
    ".css": "css",
    ".html": "html",
    ".xml": "xml",
    ".sql": "sql",
    ".rb": "rb",
    ".java": "java",
    ".c": "c",
    ".cpp": "cpp",
    ".h": "h",
    ".hpp": "hpp",
  };
  return langMap[ext] ?? "";
}

/**
 * Render a file as unified context XML using the `<@path>` tag format.
 */
export function renderContextFile(file: IncludedFile): string {
  const lang = guessCodeFenceLanguage(file.path);
  const fence = lang ? `\`\`\`${lang}` : "```";
  const truncatedAttr = file.truncated ? ' truncated="true"' : "";

  return (
    `<@${file.path}${truncatedAttr}>\n` +
    `${fence}\n` +
    `${file.content}\n` +
    `\`\`\`\n` +
    `</@${file.path}>`
  );
}

/**
 * Render an error for a file that couldn't be included.
 */
export function renderContextFileError(filePath: string, error: string): string {
  return `<@${filePath} error="${escapeXmlAttr(error)}" />`;
}

function escapeXmlAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * List files in directory matching patterns using find command.
 * Falls back to simple file listing if find fails.
 */
async function listFilesInDir(runtime: Runtime, dir: string, cwd: string): Promise<string[]> {
  const quotedDir = shellQuote(dir);
  const command =
    `if [ -d ${quotedDir} ]; then ` +
    `find ${quotedDir} -type f -maxdepth 5 2>/dev/null | head -500; ` +
    `fi`;

  const result = await execBuffered(runtime, command, { cwd, timeout: 10 });
  if (result.exitCode !== 0) {
    log.warn(`Failed to list files in ${dir}: ${result.stderr || result.stdout}`);
    return [];
  }

  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

async function listFilesWithGitLsFiles(runtime: Runtime, cwd: string): Promise<string[]> {
  const result = await execBuffered(runtime, "git ls-files -co --exclude-standard", {
    cwd,
    timeout: 10,
  });
  if (result.exitCode !== 0) {
    log.warn(`Failed to list files with git ls-files in ${cwd}: ${result.stderr || result.stdout}`);
    return [];
  }

  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * Resolve glob patterns against a skill directory and return matching files.
 */
export async function resolveIncludeFiles(
  runtime: Runtime,
  skillDir: string,
  patterns: string[],
  options?: { abortSignal?: AbortSignal; listMode?: "find" | "git" }
): Promise<IncludeFilesResult> {
  if (!patterns || patterns.length === 0) {
    return { files: [], errors: [] };
  }

  const resolvedSkillDir = await runtime.resolvePath(skillDir);
  const pathModule = runtime instanceof SSHRuntime ? path.posix : path;

  const listMode = options?.listMode ?? "find";

  const toRelativePaths = (files: string[]): string[] => {
    return files
      .map((f) => {
        const rel = pathModule.relative(resolvedSkillDir, f);
        // Normalize to forward slashes for consistent glob matching
        return rel.replace(/\\/g, "/");
      })
      .filter((rel) => rel && !rel.startsWith(".."));
  };

  let relativePaths: string[];
  if (listMode === "git") {
    const gitPaths = await listFilesWithGitLsFiles(runtime, resolvedSkillDir);
    relativePaths =
      gitPaths.length > 0
        ? gitPaths.map((filePath) => filePath.replace(/\\/g, "/")).filter(Boolean)
        : toRelativePaths(await listFilesInDir(runtime, resolvedSkillDir, resolvedSkillDir));
  } else {
    // List all files in the skill directory (up to reasonable depth)
    relativePaths = toRelativePaths(
      await listFilesInDir(runtime, resolvedSkillDir, resolvedSkillDir)
    );
  }

  // Match patterns using picomatch
  const matchedPaths = new Set<string>();
  const errors: Array<{ pattern: string; error: string }> = [];

  for (const pattern of patterns) {
    try {
      const matcher = picomatch(pattern, { dot: true });
      let hasMatch = false;

      for (const relPath of relativePaths) {
        if (matcher(relPath)) {
          matchedPaths.add(relPath);
          hasMatch = true;
        }
      }

      if (!hasMatch) {
        // Not an error, just no matches - common for optional patterns
        log.debug(`include_files pattern '${pattern}' matched no files in ${skillDir}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ pattern, error: `Invalid pattern: ${message}` });
    }
  }

  // Read matched files respecting limits
  const files: IncludedFile[] = [];
  let totalBytes = 0;

  const sortedPaths = Array.from(matchedPaths).sort();

  for (const relPath of sortedPaths) {
    if (files.length >= MAX_INCLUDE_FILES) {
      log.debug(`include_files: hit max file limit (${MAX_INCLUDE_FILES})`);
      break;
    }

    if (totalBytes >= MAX_TOTAL_BYTES) {
      log.debug(`include_files: hit total bytes limit (${MAX_TOTAL_BYTES})`);
      break;
    }

    const fullPath = pathModule.join(resolvedSkillDir, relPath);

    try {
      const stat = await runtime.stat(fullPath, options?.abortSignal);
      if (stat.isDirectory) continue;

      if (stat.size > MAX_BYTES_PER_FILE) {
        errors.push({
          pattern: relPath,
          error: `File too large (${(stat.size / 1024).toFixed(1)}KB > ${MAX_BYTES_PER_FILE / 1024}KB)`,
        });
        continue;
      }

      let content = await readFileString(runtime, fullPath, options?.abortSignal);

      // Check for binary content
      if (content.includes("\u0000")) {
        errors.push({ pattern: relPath, error: "Binary file detected" });
        continue;
      }

      // Apply line limits
      let truncated = false;
      const lines = content.split("\n");
      if (lines.length > MAX_LINES_PER_FILE) {
        content = lines.slice(0, MAX_LINES_PER_FILE).join("\n");
        truncated = true;
      }

      // Check total bytes budget
      const contentBytes = Buffer.byteLength(content, "utf8");
      if (totalBytes + contentBytes > MAX_TOTAL_BYTES) {
        // Truncate content to fit remaining budget
        const remaining = MAX_TOTAL_BYTES - totalBytes;
        if (remaining < 100) break; // Not worth truncating to tiny amount

        content = Buffer.from(content, "utf8").subarray(0, remaining).toString("utf8");
        truncated = true;
      }

      files.push({ path: relPath, content, truncated });
      totalBytes += Buffer.byteLength(content, "utf8");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ pattern: relPath, error: message });
    }
  }

  return { files, errors };
}

/**
 * Render all included files as unified context XML.
 */
export function renderIncludedFilesContext(result: IncludeFilesResult): string {
  const blocks: string[] = [];

  for (const file of result.files) {
    blocks.push(renderContextFile(file));
  }

  for (const error of result.errors) {
    blocks.push(renderContextFileError(error.pattern, error.error));
  }

  return blocks.join("\n\n");
}
