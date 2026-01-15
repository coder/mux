/**
 * Utilities for client-side file explorer operations via bash commands.
 */

import type { FileTreeNode } from "@/common/utils/git/numstatParser";

/** Maximum file size for viewing (10MB) */
export const MAX_FILE_SIZE = 10 * 1024 * 1024;

/** Exit code for "file too large" */
export const EXIT_CODE_TOO_LARGE = 42;

/** Magic bytes for image type detection */
const IMAGE_MAGIC_BYTES: Array<{ bytes: number[]; offset?: number; mime: string }> = [
  { bytes: [0x89, 0x50, 0x4e, 0x47], mime: "image/png" },
  { bytes: [0xff, 0xd8, 0xff], mime: "image/jpeg" },
  { bytes: [0x47, 0x49, 0x46], mime: "image/gif" }, // GIF87a or GIF89a
  // WebP: RIFF header + "WEBP" at offset 8
  { bytes: [0x52, 0x49, 0x46, 0x46], mime: "image/webp" },
  { bytes: [0x42, 0x4d], mime: "image/bmp" },
  { bytes: [0x00, 0x00, 0x01, 0x00], mime: "image/x-icon" },
];

/**
 * Validates that a relative path is safe (no traversal, no absolute paths).
 * Returns error message if invalid, undefined if valid.
 */
export function validateRelativePath(path: string): string | undefined {
  if (!path) return undefined; // Empty path is valid (root)
  if (path.startsWith("/")) return "Absolute paths are not allowed";
  if (path.includes("..")) return "Path traversal not allowed";
  if (path.includes("\0")) return "Invalid path";
  return undefined;
}

/**
 * Escapes a path for safe use in shell commands.
 * Uses single quotes and escapes any existing single quotes.
 */
export function shellEscape(s: string): string {
  // Replace single quotes with '\'' (end quote, escaped quote, start quote)
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/**
 * Parse `ls -la` output into FileTreeNode[].
 * Output format: `drwxr-xr-x 2 user group 4096 Jan 15 10:30 dirname`
 * For symlinks: `lrwxrwxrwx 1 user group 10 Jan 15 10:30 link -> target`
 */
export function parseLsOutput(output: string, basePath: string): FileTreeNode[] {
  const lines = output.trim().split("\n");
  const nodes: FileTreeNode[] = [];

  for (const line of lines) {
    // Skip empty lines and total line
    if (!line || line.startsWith("total ")) continue;

    // Parse ls -la output: permissions linkcount user group size date name
    // The name is everything after the date/time fields
    const parts = line.split(/\s+/);
    if (parts.length < 9) continue;

    const permissions = parts[0];
    const isSymlink = permissions.startsWith("l");
    // Date/time is typically 3 fields (e.g., "Jan 15 10:30" or "Jan 15  2024")
    // Name starts at index 8 and may contain spaces
    let name = parts.slice(8).join(" ");

    // For symlinks, strip the " -> target" suffix
    if (isSymlink) {
      const arrowIndex = name.indexOf(" -> ");
      if (arrowIndex !== -1) {
        name = name.slice(0, arrowIndex);
      }
    }

    // Skip . and .. entries, and .git
    if (name === "." || name === ".." || name === ".git") continue;

    // Symlinks to directories still show 'l' not 'd', so treat symlinks as files
    // (they'll be resolved when opened)
    const isDirectory = permissions.startsWith("d");
    const entryPath = basePath ? `${basePath}/${name}` : name;

    nodes.push({
      name,
      path: entryPath,
      isDirectory,
      children: [],
    });
  }

  // Sort: directories first, then files, both alphabetically (case-insensitive)
  nodes.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) {
      return a.isDirectory ? -1 : 1;
    }
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });

  return nodes;
}

/** Git status result containing categorized file paths */
export interface GitStatusResult {
  ignored: Set<string>;
  modified: Set<string>;
  untracked: Set<string>;
}

/**
 * Parse `git status --ignored --porcelain` output to categorize file paths.
 *
 * Porcelain format: XY path (where X=index status, Y=worktree status)
 * - `!!` = ignored
 * - ` M` or `M ` or `MM` = modified (staged or unstaged)
 * - `??` = untracked (new)
 * - ` A` or `A ` = added (staged)
 * - ` D` or `D ` = deleted
 */
export function parseGitStatus(output: string, basePath: string): GitStatusResult {
  const ignored = new Set<string>();
  const modified = new Set<string>();
  const untracked = new Set<string>();
  // Use trimEnd, not trim - leading spaces are significant (e.g., " M" = unstaged modified)
  const lines = output.trimEnd().split("\n");
  const prefix = basePath ? `${basePath}/` : "";

  for (const line of lines) {
    if (line.length < 4) continue; // Need at least "XY " + 1 char path

    const xy = line.slice(0, 2);
    let path = line.slice(3); // Skip "XY " prefix

    // For renamed files, format is "XY old -> new", use the new path
    const arrowIdx = path.indexOf(" -> ");
    if (arrowIdx !== -1) {
      path = path.slice(arrowIdx + 4);
    }

    // Trim any trailing whitespace
    path = path.trimEnd();

    // If path starts with our base, keep only the relative part
    if (basePath && path.startsWith(prefix)) {
      path = path.slice(prefix.length);
    }

    // Remove trailing slash for directories
    if (path.endsWith("/")) {
      path = path.slice(0, -1);
    }

    // Categorize based on status codes
    if (xy === "!!") {
      ignored.add(path);
    } else if (xy === "??") {
      untracked.add(path);
    } else if (xy.includes("M") || xy.includes("A") || xy.includes("R")) {
      // M = modified, A = added, R = renamed (all show as "modified" in explorer)
      modified.add(path);
    }
    // Skip deleted files (D) - they won't appear in ls output anyway
  }

  return { ignored, modified, untracked };
}

/**
 * Decode base64 string to Uint8Array.
 */
export function base64ToUint8Array(base64: string): Uint8Array {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

/**
 * Detect image type from buffer using magic bytes.
 * Returns MIME type if it's a supported image type, undefined otherwise.
 */
export function detectImageType(buffer: Uint8Array): string | undefined {
  for (const { bytes, mime } of IMAGE_MAGIC_BYTES) {
    if (buffer.length < bytes.length) continue;

    let matches = true;
    for (let i = 0; i < bytes.length; i++) {
      if (buffer[i] !== bytes[i]) {
        matches = false;
        break;
      }
    }

    if (matches) {
      // WebP needs additional check for "WEBP" at offset 8
      if (mime === "image/webp") {
        if (
          buffer.length >= 12 &&
          buffer[8] === 0x57 && // W
          buffer[9] === 0x45 && // E
          buffer[10] === 0x42 && // B
          buffer[11] === 0x50 // P
        ) {
          return mime;
        }
        continue; // Not WebP, might be other RIFF format
      }
      return mime;
    }
  }

  return undefined;
}

/**
 * Check if file is an SVG by looking for XML/SVG markers in content.
 * SVGs are text-based so file-type can't detect them via magic bytes.
 */
export function detectSvg(buffer: Uint8Array): boolean {
  // Check first 1KB for SVG markers
  const sampleSize = Math.min(buffer.length, 1024);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    const text = decoder.decode(buffer.slice(0, sampleSize)).toLowerCase();
    return text.includes("<svg") || (text.includes("<?xml") && text.includes("<svg"));
  } catch {
    // Not valid UTF-8, definitely not SVG
    return false;
  }
}

/**
 * Check if buffer contains binary content.
 * Any null bytes or control characters (except tab/newline/CR) means binary.
 */
export function detectBinary(buffer: Uint8Array): boolean {
  const sampleSize = Math.min(buffer.length, 8192);

  for (let i = 0; i < sampleSize; i++) {
    const byte = buffer[i];
    // Null byte or control characters (except tab, newline, carriage return)
    if (byte === 0 || (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13)) {
      return true;
    }
  }

  return false;
}

/**
 * Generate bash script to list directory contents.
 */
export function buildListDirScript(relativePath: string): string {
  const dir = relativePath ? shellEscape(relativePath) : ".";
  return `ls -la ${dir}`;
}

/**
 * Generate bash script to get git ignored status for a directory.
 */
export function buildGitIgnoredScript(relativePath: string): string {
  const dir = relativePath ? shellEscape(relativePath) : ".";
  // Use git status --ignored --porcelain to get ignored files
  // The -- separates pathspec from options
  return `git status --ignored --porcelain -- ${dir} 2>/dev/null || true`;
}

/**
 * Generate bash script to check if paths are gitignored.
 * Paths are passed via stdin to git check-ignore.
 * Returns only the paths that are ignored.
 */
export function buildGitCheckIgnoreScript(paths: string[]): string {
  // Echo paths (one per line) and pipe to git check-ignore --stdin
  // --stdin reads paths from stdin, outputs only ignored ones
  // Use printf to avoid issues with echo -e portability
  const escapedPaths = paths.map((p) => shellEscape(p)).join("\\n");
  return `printf '${escapedPaths}\\n' | git check-ignore --stdin 2>/dev/null || true`;
}

/**
 * Parse git check-ignore output to get set of ignored paths.
 * Output is one ignored path per line.
 */
export function parseGitCheckIgnoreOutput(output: string): Set<string> {
  const ignored = new Set<string>();
  if (!output.trim()) return ignored;

  for (const line of output.trimEnd().split("\n")) {
    if (line) {
      // Remove trailing slash for directories
      const path = line.endsWith("/") ? line.slice(0, -1) : line;
      ignored.add(path);
    }
  }
  return ignored;
}

/**
 * Generate bash script to read file contents with size check.
 * Uses base64 encoding for all files to handle binary safely.
 * Exits with EXIT_CODE_TOO_LARGE if file exceeds MAX_FILE_SIZE.
 */
export function buildReadFileScript(relativePath: string): string {
  const file = shellEscape(relativePath);
  // Cross-platform stat: try GNU stat first, fall back to BSD stat (macOS)
  // Use stdin redirect for base64 - works on both BSD (macOS) and GNU (Linux)
  return `size=$(stat -c %s ${file} 2>/dev/null || stat -f %z ${file})
[ "$size" -gt ${MAX_FILE_SIZE} ] && exit ${EXIT_CODE_TOO_LARGE}
echo "$size"
base64 < ${file}`;
}

/**
 * Generate bash script to get git diff for a file.
 */
export function buildFileDiffScript(relativePath: string): string {
  const file = shellEscape(relativePath);
  return `git diff -- ${file}`;
}

/**
 * Parse the read file script output (size on first line, base64 on remaining lines).
 */
export function parseReadFileOutput(output: string): { size: number; base64: string } {
  const firstNewline = output.indexOf("\n");

  // Empty files: base64 produces no output, so there's no newline after size
  if (firstNewline === -1) {
    const size = parseInt(output, 10);
    if (isNaN(size)) {
      throw new Error("Invalid file output format");
    }
    return { size, base64: "" };
  }

  const size = parseInt(output.slice(0, firstNewline), 10);
  if (isNaN(size)) {
    throw new Error("Invalid file size");
  }
  // base64 output may have line wrapping, strip all CR/LF (handles Windows CRLF)
  const base64 = output.slice(firstNewline + 1).replace(/[\r\n]/g, "");
  return { size, base64 };
}

/** File contents response types for the client */
export type FileContentsResult =
  | { type: "text"; content: string; size: number }
  | { type: "image"; base64: string; mimeType: string; size: number }
  | { type: "error"; message: string };

/**
 * Process file output into a typed result.
 * Decodes base64 and determines if text or image based on magic bytes.
 */
export function processFileContents(output: string, exitCode: number): FileContentsResult {
  // Check for "too large" exit code
  if (exitCode === EXIT_CODE_TOO_LARGE) {
    return { type: "error", message: "File is too large to display. Maximum: 10 MB." };
  }

  // Parse output
  const { size, base64 } = parseReadFileOutput(output);

  // Decode base64 to buffer
  let buffer: Uint8Array;
  try {
    buffer = base64ToUint8Array(base64);
  } catch {
    return { type: "error", message: "Unable to decode file contents" };
  }

  // Check for image by magic bytes
  const mimeType = detectImageType(buffer);
  if (mimeType) {
    return { type: "image", base64, mimeType, size };
  }

  // Check for SVG (text-based, no magic bytes)
  if (detectSvg(buffer)) {
    return { type: "image", base64, mimeType: "image/svg+xml", size };
  }

  // Check for binary content
  if (detectBinary(buffer)) {
    return { type: "error", message: "Unable to display binary file" };
  }

  // Decode as text
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const content = decoder.decode(buffer);

  return { type: "text", content, size };
}
