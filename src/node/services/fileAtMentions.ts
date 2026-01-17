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

/**
 * Result of materializing a single @file mention.
 */
export interface MaterializedFileMention {
  /** The @mention token (e.g., "src/foo.ts#L1-20"). */
  token: string;
  /** Resolved absolute path (for recordFileState). */
  resolvedPath: string;
  /** The rendered <mux-file> block. */
  block: string;
  /** File content (for recordFileState). Only set for successful reads. */
  content?: string;
  /** File modification time in ms (for recordFileState). Only set for successful reads. */
  modifiedTimeMs?: number;
}

/**
 * Materialize @file mentions from a single user message into persisted snapshot blocks.
 *
 * This reads files and produces stable <mux-file> blocks that can be persisted to history.
 * Unlike injectFileAtMentions (which injects ephemeral synthetic messages), this produces
 * data suitable for persisting so that:
 * 1. Future sends don't re-read the same files (prompt-cache stability)
 * 2. File changes are detected via recordFileState and shown as diffs
 *
 * @returns Array of materialized mentions (may be empty if no valid @file mentions found)
 */
export async function materializeFileAtMentions(
  messageText: string,
  options: {
    runtime: Runtime;
    workspacePath: string;
    abortSignal?: AbortSignal;
  }
): Promise<MaterializedFileMention[]> {
  const mentions = extractAtMentions(messageText);
  if (mentions.length === 0) {
    return [];
  }

  const results: MaterializedFileMention[] = [];
  const seenTokens = new Set<string>();
  let totalBytes = 0;
  let totalBlocks = 0;

  for (const mention of mentions) {
    if (totalBlocks >= MAX_MENTION_FILES || totalBytes >= MAX_TOTAL_BYTES) {
      break;
    }

    if (seenTokens.has(mention.token)) {
      continue;
    }

    const displayPath = mention.path;

    if (mention.rangeError) {
      seenTokens.add(mention.token);
      continue;
    }

    // Resolve the path
    let resolvedPath: string;
    try {
      resolvedPath = resolveWorkspaceFilePath(options.runtime, options.workspacePath, mention.path);
    } catch {
      seenTokens.add(mention.token);
      continue;
    }

    // Stat the file
    let stat;
    try {
      stat = await options.runtime.stat(resolvedPath, options.abortSignal);
    } catch {
      seenTokens.add(mention.token);
      continue;
    }

    if (stat.isDirectory) {
      seenTokens.add(mention.token);
      continue;
    }

    if (stat.size > MAX_FILE_SIZE) {
      seenTokens.add(mention.token);
      continue;
    }

    // Read the file
    let content: string;
    try {
      content = await readFileString(options.runtime, resolvedPath, options.abortSignal);
    } catch {
      seenTokens.add(mention.token);
      continue;
    }

    if (content.includes("\u0000")) {
      seenTokens.add(mention.token);
      continue;
    }

    // Process lines
    const rawLines = content === "" ? [] : content.split("\n");
    const lines = rawLines.map((line) => line.replace(/\r$/, ""));

    const requestedStart = mention.range?.startLine ?? 1;
    const requestedEnd = mention.range?.endLine ?? Math.max(1, lines.length);

    if (lines.length > 0 && requestedStart > lines.length) {
      seenTokens.add(mention.token);
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

    // Apply byte limits
    const remainingTotalBytes = MAX_TOTAL_BYTES - totalBytes;
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
      break;
    }

    results.push({
      token: mention.token,
      resolvedPath,
      block,
      content,
      modifiedTimeMs: stat.modifiedTime.getTime(),
    });
    seenTokens.add(mention.token);
    totalBlocks++;
    totalBytes += blockBytes;
  }

  return results;
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

  // Expand @file mentions across *all* user-authored messages (not just the last).
  //
  // Why:
  // - Injected content isn't persisted to history.
  // - If we only expand the last user message, a subsequent message with no @mentions
  //   would drop previously-injected files from the provider context.
  // - Re-injecting in place preserves prompt-caching prefixes across turns.
  //
  // NOTE: Tokens that have already been materialized to history (via fileAtMentionSnapshot
  // metadata) are pre-populated into seenTokens. This ensures we don't re-read those files,
  // preserving prompt-cache stability even if the file has since changed on disk.
  // File changes are surfaced via the <system-file-update> mechanism instead.

  // Map from message index -> blocks to inject before it.
  const blocksByTargetIndex = new Map<number, string[]>();

  // Deduplicate by token (path + optional range) across the full conversation.
  // Pre-populate with tokens that already have persisted snapshots in history.
  const seenTokens = new Set<string>();
  for (const msg of messages) {
    const snapshotTokens = msg.metadata?.fileAtMentionSnapshot;
    if (snapshotTokens && Array.isArray(snapshotTokens)) {
      for (const token of snapshotTokens) {
        seenTokens.add(token);
      }
    }
  }

  let totalBlocks = 0;
  let totalBytes = 0;

  const createdAt = Date.now();

  const addBlock = (targetIndex: number, block: string): boolean => {
    const blockBytes = Buffer.byteLength(block, "utf8");
    if (totalBytes + blockBytes > MAX_TOTAL_BYTES) {
      return false;
    }

    const existing = blocksByTargetIndex.get(targetIndex) ?? [];
    existing.push(block);
    blocksByTargetIndex.set(targetIndex, existing);

    totalBlocks += 1;
    totalBytes += blockBytes;
    return true;
  };

  // Iterate newest → oldest so the current turn wins if we hit caps.
  for (let targetIndex = messages.length - 1; targetIndex >= 0; targetIndex--) {
    if (totalBlocks >= MAX_MENTION_FILES || totalBytes >= MAX_TOTAL_BYTES) {
      break;
    }

    const target = messages[targetIndex];
    if (target?.role !== "user" || target.metadata?.synthetic === true) {
      continue;
    }

    const textParts = (target.parts ?? [])
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .filter((t) => typeof t === "string" && t.length > 0);

    if (textParts.length === 0) {
      continue;
    }

    const mentionCandidates = extractAtMentions(textParts.join("\n")).slice(
      0,
      MAX_MENTION_FILES * 5
    );

    if (mentionCandidates.length === 0) {
      continue;
    }

    // Deduplicate within this message to keep ordering stable.
    const seenTokensInMessage = new Set<string>();
    const mentions = mentionCandidates.filter((m) => {
      if (seenTokensInMessage.has(m.token)) return false;
      seenTokensInMessage.add(m.token);
      return true;
    });

    for (const mention of mentions) {
      if (totalBlocks >= MAX_MENTION_FILES || totalBytes >= MAX_TOTAL_BYTES) {
        break;
      }

      if (seenTokens.has(mention.token)) {
        continue;
      }

      const displayPath = mention.path;

      if (mention.rangeError) {
        seenTokens.add(mention.token);
        continue;
      }

      let resolvedPath: string;
      try {
        resolvedPath = resolveWorkspaceFilePath(
          options.runtime,
          options.workspacePath,
          mention.path
        );
      } catch {
        seenTokens.add(mention.token);
        continue;
      }

      let stat;
      try {
        stat = await options.runtime.stat(resolvedPath, options.abortSignal);
      } catch {
        seenTokens.add(mention.token);
        continue;
      }

      if (stat.isDirectory) {
        seenTokens.add(mention.token);
        continue;
      }

      if (stat.size > MAX_FILE_SIZE) {
        seenTokens.add(mention.token);
        continue;
      }

      let content: string;
      try {
        content = await readFileString(options.runtime, resolvedPath, options.abortSignal);
      } catch {
        seenTokens.add(mention.token);
        continue;
      }

      if (content.includes("\u0000")) {
        seenTokens.add(mention.token);
        continue;
      }

      const rawLines = content === "" ? [] : content.split("\n");
      const lines = rawLines.map((line) => line.replace(/\r$/, ""));

      const requestedStart = mention.range?.startLine ?? 1;
      const requestedEnd = mention.range?.endLine ?? Math.max(1, lines.length);

      if (lines.length > 0 && requestedStart > lines.length) {
        seenTokens.add(mention.token);
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

      if (!addBlock(targetIndex, block)) {
        break;
      }

      seenTokens.add(mention.token);
    }
  }

  if (blocksByTargetIndex.size === 0) {
    return messages;
  }

  const result: MuxMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const blocks = blocksByTargetIndex.get(i);
    if (blocks && blocks.length > 0) {
      result.push(
        createMuxMessage(`file-at-mentions-${createdAt}-${i}`, "user", blocks.join("\n\n"), {
          timestamp: createdAt,
          synthetic: true,
        })
      );
    }

    const msg = messages[i];
    assert(msg, "message must exist");
    result.push(msg);
  }

  return result;
}
