import * as path from "path";

import assert from "@/common/utils/assert";
import type { MuxMessage } from "@/common/types/message";
import { createMuxMessage } from "@/common/types/message";
import { extractAtMentions } from "@/common/utils/atMentions";
import type { Runtime } from "@/node/runtime/Runtime";
import { SSHRuntime } from "@/node/runtime/SSHRuntime";
import { readFileString } from "@/node/utils/runtime/helpers";
import { MAX_FILE_SIZE } from "@/node/services/tools/fileCommon";

const MAX_MENTION_FILES = 10;

// Conservative guards for model context.
const MAX_TOTAL_BYTES = 64 * 1024; // 64KB across all injected files
const MAX_BYTES_PER_FILE = 32 * 1024; // 32KB per file
const MAX_LINES_PER_FILE = 500;
const MAX_LINE_BYTES = 4 * 1024;

function isAbsolutePathAny(filePath: string): boolean {
  if (filePath.startsWith("/") || filePath.startsWith("\\")) return true;
  // Windows drive letter paths (e.g., C:\foo or C:/foo)
  return /^[A-Za-z]:[\\/]/.test(filePath);
}

function isLikelyFilePathToken(filePath: string): boolean {
  // Heuristic to decide whether an @mention is likely intended to be a file reference.
  //
  // Note: We still allow root files like "@Makefile" if they exist; this only controls whether we
  // emit error blocks when a mention doesn't resolve.
  return filePath.includes("/") || filePath.includes("\\") || filePath.includes(".");
}

function resolveWorkspaceFilePath(
  runtime: Runtime,
  workspacePath: string,
  filePath: string
): string {
  assert(filePath, "filePath is required");

  // Disallow absolute and home-relative paths.
  if (isAbsolutePathAny(filePath) || filePath.startsWith("~")) {
    throw new Error(`Invalid file path in @mention (must be workspace-relative): ${filePath}`);
  }

  // SSH uses POSIX paths; local runtime can use the platform resolver.
  const pathModule = runtime instanceof SSHRuntime ? path.posix : path;
  const cleaned = runtime instanceof SSHRuntime ? filePath.replace(/\\/g, "/") : filePath;

  const resolved = pathModule.resolve(workspacePath, cleaned);
  const relative = pathModule.relative(workspacePath, resolved);

  // Note: relative === "" means "same directory" (the workspace root itself).
  if (relative === "" || relative === ".") {
    throw new Error(`Invalid file path in @mention (expected a file, got directory): ${filePath}`);
  }

  if (relative.startsWith("..") || pathModule.isAbsolute(relative)) {
    throw new Error(`Invalid file path in @mention (path traversal): ${filePath}`);
  }

  return resolved;
}

function guessCodeFenceLanguage(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".ts":
      return "ts";
    case ".tsx":
      return "tsx";
    case ".js":
      return "js";
    case ".jsx":
      return "jsx";
    case ".json":
      return "json";
    case ".md":
      return "md";
    case ".yml":
    case ".yaml":
      return "yaml";
    case ".sh":
      return "sh";
    case ".py":
      return "py";
    case ".go":
      return "go";
    case ".rs":
      return "rs";
    case ".css":
      return "css";
    case ".html":
      return "html";
    default:
      return "";
  }
}

function truncateLine(line: string): { line: string; truncated: boolean } {
  const bytes = Buffer.byteLength(line, "utf8");
  if (bytes <= MAX_LINE_BYTES) {
    return { line, truncated: false };
  }

  const truncated = Buffer.from(line, "utf8").subarray(0, MAX_LINE_BYTES).toString("utf8");
  return { line: truncated, truncated: true };
}

function takeLinesWithinByteLimit(
  lines: string[],
  maxBytes: number
): { lines: string[]; truncated: boolean } {
  const taken: string[] = [];
  let bytes = 0;

  for (const line of lines) {
    // +1 for newline
    const lineBytes = Buffer.byteLength(line, "utf8") + 1;
    if (taken.length > 0 && bytes + lineBytes > maxBytes) {
      return { lines: taken, truncated: true };
    }

    if (taken.length === 0 && lineBytes > maxBytes) {
      // Nothing fits; return empty rather than producing a partial multi-byte string.
      return { lines: [], truncated: true };
    }

    taken.push(line);
    bytes += lineBytes;
  }

  return { lines: taken, truncated: false };
}

function formatRange(startLine: number, endLine: number, lineCount: number): string {
  if (lineCount === 0) {
    return "empty";
  }
  return `L${startLine}-L${endLine}`;
}

function renderMuxFileBlock(options: {
  filePath: string;
  rangeLabel: string;
  content: string;
  truncated: boolean;
}): string {
  const lang = guessCodeFenceLanguage(options.filePath);
  const fence = lang ? `\`\`\`${lang}` : "```";
  const truncatedAttr = options.truncated ? ' truncated="true"' : "";

  return (
    `<mux-file path="${options.filePath}" range="${options.rangeLabel}"${truncatedAttr}>\n` +
    `${fence}\n` +
    `${options.content}\n` +
    `\`\`\`\n` +
    `</mux-file>`
  );
}

function renderMuxFileError(filePath: string, error: string): string {
  return `<mux-file-error path="${filePath}">${error}</mux-file-error>`;
}

export async function injectFileAtMentions(
  messages: MuxMessage[],
  options: {
    runtime: Runtime;
    workspacePath: string;
    abortSignal?: AbortSignal;
  }
): Promise<MuxMessage[]> {
  assert(Array.isArray(messages), "messages must be an array");
  assert(options.runtime, "runtime is required");
  assert(options.workspacePath, "workspacePath is required");

  // Find the last user-authored message (ignore synthetic injections like mode transitions).
  let targetIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role === "user" && msg.metadata?.synthetic !== true) {
      targetIndex = i;
      break;
    }
  }

  if (targetIndex === -1) {
    return messages;
  }

  const target = messages[targetIndex];
  assert(target, "target message must exist");

  const textParts = (target.parts ?? [])
    .filter((p) => p.type === "text")
    .map((p) => p.text)
    .filter((t) => typeof t === "string" && t.length > 0);

  if (textParts.length === 0) {
    return messages;
  }

  const mentionCandidates = extractAtMentions(textParts.join("\n")).slice(0, MAX_MENTION_FILES * 5);

  if (mentionCandidates.length === 0) {
    return messages;
  }

  // Deduplicate by token (path + optional range) to avoid bloating context.
  const seenTokens = new Set<string>();
  const mentions = mentionCandidates.filter((m) => {
    if (seenTokens.has(m.token)) return false;
    seenTokens.add(m.token);
    return true;
  });

  const blocks: string[] = [];
  let totalBytes = 0;

  for (const mention of mentions) {
    if (blocks.length >= MAX_MENTION_FILES) {
      break;
    }

    const displayPath = mention.path;
    const pathLooksLikeFilePath = isLikelyFilePathToken(displayPath) || mention.range !== undefined;

    if (mention.rangeError) {
      let shouldEmitRangeError = pathLooksLikeFilePath;

      // For "bare" @mentions, only emit range errors if the path actually exists as a file.
      // This avoids noisy errors for patterns like "@alice#123".
      if (!shouldEmitRangeError) {
        try {
          const resolvedPathForRange = resolveWorkspaceFilePath(
            options.runtime,
            options.workspacePath,
            mention.path
          );
          const statForRange = await options.runtime.stat(
            resolvedPathForRange,
            options.abortSignal
          );
          shouldEmitRangeError = !statForRange.isDirectory;
        } catch {
          shouldEmitRangeError = false;
        }
      }

      if (!shouldEmitRangeError) {
        continue;
      }

      const block = renderMuxFileError(displayPath, mention.rangeError);
      const blockBytes = Buffer.byteLength(block, "utf8");
      if (totalBytes + blockBytes > MAX_TOTAL_BYTES) {
        break;
      }
      blocks.push(block);
      totalBytes += blockBytes;
      continue;
    }

    let resolvedPath: string;
    try {
      resolvedPath = resolveWorkspaceFilePath(options.runtime, options.workspacePath, mention.path);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const block = renderMuxFileError(displayPath, message);
      const blockBytes = Buffer.byteLength(block, "utf8");
      if (totalBytes + blockBytes > MAX_TOTAL_BYTES) {
        break;
      }
      blocks.push(block);
      totalBytes += blockBytes;
      continue;
    }

    let stat;
    try {
      stat = await options.runtime.stat(resolvedPath, options.abortSignal);
    } catch (error) {
      if (!pathLooksLikeFilePath) {
        continue;
      }

      const message = error instanceof Error ? error.message : String(error);
      const block = renderMuxFileError(displayPath, `Failed to stat file: ${message}`);
      const blockBytes = Buffer.byteLength(block, "utf8");
      if (totalBytes + blockBytes > MAX_TOTAL_BYTES) {
        break;
      }
      blocks.push(block);
      totalBytes += blockBytes;
      continue;
    }

    if (stat.isDirectory) {
      if (!pathLooksLikeFilePath) {
        continue;
      }

      const block = renderMuxFileError(displayPath, "Path is a directory, not a file.");
      const blockBytes = Buffer.byteLength(block, "utf8");
      if (totalBytes + blockBytes > MAX_TOTAL_BYTES) {
        break;
      }
      blocks.push(block);
      totalBytes += blockBytes;
      continue;
    }

    if (stat.size > MAX_FILE_SIZE) {
      const sizeMB = (stat.size / (1024 * 1024)).toFixed(2);
      const maxMB = (MAX_FILE_SIZE / (1024 * 1024)).toFixed(2);
      const block = renderMuxFileError(
        displayPath,
        `File is too large to include (${sizeMB}MB > ${maxMB}MB). Use a smaller #L<start>-<end> range or file_read.`
      );
      const blockBytes = Buffer.byteLength(block, "utf8");
      if (totalBytes + blockBytes > MAX_TOTAL_BYTES) {
        break;
      }
      blocks.push(block);
      totalBytes += blockBytes;
      continue;
    }

    let content: string;
    try {
      content = await readFileString(options.runtime, resolvedPath, options.abortSignal);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const block = renderMuxFileError(displayPath, `Failed to read file: ${message}`);
      const blockBytes = Buffer.byteLength(block, "utf8");
      if (totalBytes + blockBytes > MAX_TOTAL_BYTES) {
        break;
      }
      blocks.push(block);
      totalBytes += blockBytes;
      continue;
    }

    if (content.includes("\u0000")) {
      const block = renderMuxFileError(displayPath, "Binary file detected (NUL byte). Skipping.");
      const blockBytes = Buffer.byteLength(block, "utf8");
      if (totalBytes + blockBytes > MAX_TOTAL_BYTES) {
        break;
      }
      blocks.push(block);
      totalBytes += blockBytes;
      continue;
    }

    const rawLines = content === "" ? [] : content.split("\n");
    const lines = rawLines.map((line) => line.replace(/\r$/, ""));

    const requestedStart = mention.range?.startLine ?? 1;
    const requestedEnd = mention.range?.endLine ?? Math.max(1, lines.length);

    if (lines.length > 0 && requestedStart > lines.length) {
      const block = renderMuxFileError(
        displayPath,
        `Range starts beyond end of file: requested L${requestedStart}, file has ${lines.length} lines.`
      );
      const blockBytes = Buffer.byteLength(block, "utf8");
      if (totalBytes + blockBytes > MAX_TOTAL_BYTES) {
        break;
      }
      blocks.push(block);
      totalBytes += blockBytes;
      continue;
    }

    const unclampedEnd = requestedEnd;
    const end = Math.min(unclampedEnd, Math.max(0, lines.length));

    const startIndex = Math.max(0, requestedStart - 1);
    const endIndex = Math.max(startIndex, end);

    let snippetLines = lines.slice(startIndex, endIndex);

    let truncated = false;
    if (snippetLines.length > MAX_LINES_PER_FILE) {
      snippetLines = snippetLines.slice(0, MAX_LINES_PER_FILE);
      truncated = true;
    }

    const processedLines: string[] = [];
    for (const line of snippetLines) {
      const res = truncateLine(line);
      processedLines.push(res.line);
      if (res.truncated) truncated = true;
    }

    // Apply total + per-file byte limits.
    const remainingTotalBytes = MAX_TOTAL_BYTES - totalBytes;

    // Compute an upper bound for overhead before we decide how many lines to include.
    // This isn't perfect, but it's good enough to prevent runaway context growth.
    const rangeStart = requestedStart;
    const rangeEnd = processedLines.length > 0 ? requestedStart + processedLines.length - 1 : 0;
    const rangeLabel = formatRange(rangeStart, rangeEnd, processedLines.length);
    const header = renderMuxFileBlock({
      filePath: displayPath,
      rangeLabel,
      content: "",
      truncated,
    });
    const overheadBytes = Buffer.byteLength(header, "utf8");

    if (overheadBytes > remainingTotalBytes) {
      break;
    }

    const contentBudget = Math.min(MAX_BYTES_PER_FILE, remainingTotalBytes - overheadBytes);
    const limited = takeLinesWithinByteLimit(processedLines, contentBudget);

    const finalLines = limited.lines;
    if (limited.truncated) truncated = true;

    const finalRangeEnd = finalLines.length > 0 ? requestedStart + finalLines.length - 1 : 0;
    const finalRangeLabel = formatRange(requestedStart, finalRangeEnd, finalLines.length);

    const block = renderMuxFileBlock({
      filePath: displayPath,
      rangeLabel: finalRangeLabel,
      content: finalLines.join("\n"),
      truncated,
    });
    const blockBytes = Buffer.byteLength(block, "utf8");

    if (blockBytes > remainingTotalBytes) {
      // If our earlier overhead estimate was too optimistic, bail.
      break;
    }

    blocks.push(block);
    totalBytes += blockBytes;
  }

  if (blocks.length === 0) {
    return messages;
  }

  const injected = createMuxMessage(`file-at-mentions-${Date.now()}`, "user", blocks.join("\n\n"), {
    timestamp: Date.now(),
    synthetic: true,
  });

  const result = [...messages];
  result.splice(targetIndex, 0, injected);
  return result;
}
