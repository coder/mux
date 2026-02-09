import * as fs from "fs/promises";
import * as path from "path";
import writeFileAtomic from "write-file-atomic";
import assert from "node:assert";
import type { Result } from "@/common/types/result";
import { Ok, Err } from "@/common/types/result";
import {
  isCompactionSummaryMetadata,
  type MuxMessage,
  type MuxMetadata,
} from "@/common/types/message";
import type { Config } from "@/node/config";
import { workspaceFileLocks } from "@/node/utils/concurrency/workspaceFileLocks";
import { log } from "./log";
import { getTokenizerForModel } from "@/node/utils/main/tokenizer";
import { KNOWN_MODELS } from "@/common/constants/knownModels";
import { safeStringifyForCounting } from "@/common/utils/tokens/safeStringifyForCounting";
import { normalizeLegacyMuxMetadata } from "@/node/utils/messages/legacy";
import { isDurableCompactionBoundaryMarker } from "@/common/utils/messages/compactionBoundary";

function isPositiveInteger(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value > 0
  );
}

function isNonNegativeInteger(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0
  );
}

function hasDurableCompactedMarker(value: unknown): value is true | "user" | "idle" {
  return value === true || value === "user" || value === "idle";
}

function hasDurableCompactionBoundary(metadata: MuxMetadata | undefined): boolean {
  if (metadata?.compactionBoundary !== true) {
    return false;
  }

  // Self-healing read path: malformed boundary markers should be ignored.
  if (!hasDurableCompactedMarker(metadata.compacted)) {
    return false;
  }

  return isPositiveInteger(metadata.compactionEpoch);
}

function getCompactionMetadataToPreserve(
  workspaceId: string,
  existingMessage: MuxMessage,
  incomingMessage: MuxMessage
): Partial<MuxMetadata> | null {
  const existingMetadata = existingMessage.metadata;
  if (existingMetadata?.compactionBoundary !== true) {
    return null;
  }

  if (existingMessage.role !== "assistant") {
    // Self-healing read path: boundary metadata on non-assistant rows is invalid.
    log.warn("Skipping malformed persisted compaction boundary during history update", {
      workspaceId,
      messageId: existingMessage.id,
      reason: "compactionBoundary set on non-assistant message",
    });
    return null;
  }

  if (incomingMessage.role !== "assistant") {
    return null;
  }

  if (!hasDurableCompactionBoundary(existingMetadata)) {
    // Self-healing read path: malformed boundary metadata should not be propagated.
    log.warn("Skipping malformed persisted compaction boundary during history update", {
      workspaceId,
      messageId: existingMessage.id,
      reason: "compactionBoundary missing valid compacted+compactionEpoch metadata",
    });
    return null;
  }

  if (hasDurableCompactionBoundary(incomingMessage.metadata)) {
    return null;
  }

  const preserved: Partial<MuxMetadata> = {
    compacted: existingMetadata.compacted,
    compactionBoundary: true,
    compactionEpoch: existingMetadata.compactionEpoch,
  };

  if (
    isCompactionSummaryMetadata(existingMetadata.muxMetadata) &&
    !isCompactionSummaryMetadata(incomingMessage.metadata?.muxMetadata)
  ) {
    preserved.muxMetadata = existingMetadata.muxMetadata;
  }

  return preserved;
}
/**
 * HistoryService - Manages chat history persistence and sequence numbering
 *
 * Responsibilities:
 * - Read/write chat history to disk (JSONL format)
 * - Assign sequence numbers to messages (single source of truth)
 * - Track next sequence number per workspace
 */
export class HistoryService {
  private readonly CHAT_FILE = "chat.jsonl";
  // Track next sequence number per workspace in memory
  private sequenceCounters = new Map<string, number>();
  // Shared file operation lock across all workspace file services
  // This prevents deadlocks when services call each other (e.g., PartialService → HistoryService)
  private readonly fileLocks = workspaceFileLocks;
  private readonly config: Pick<Config, "getSessionDir">;

  constructor(config: Pick<Config, "getSessionDir">) {
    this.config = config;
  }

  private getChatHistoryPath(workspaceId: string): string {
    return path.join(this.config.getSessionDir(workspaceId), this.CHAT_FILE);
  }

  // ── Reverse-read infrastructure ─────────────────────────────────────────────
  // Reads chat.jsonl from the tail to avoid O(total-history) parsing on hot paths.
  // \n (0x0A) never appears inside multi-byte UTF-8 sequences, so chunked reverse
  // reading is byte-safe. JSON.stringify escapes prevent false positives for the
  // needle inside user-content strings.

  /** Size of each chunk when scanning the file in reverse (256KB covers typical post-compaction content). */
  private static readonly REVERSE_READ_CHUNK_SIZE = 256 * 1024;
  /** String-search needle for compaction boundary lines. */
  private static readonly BOUNDARY_NEEDLE = '"compactionBoundary":true';

  /**
   * Scan chat.jsonl in reverse to find the byte offset of a durable compaction boundary.
   * Returns `null` when no (matching) boundary exists.
   *
   * @param skip How many boundaries to skip before returning. 0 = last boundary,
   *             1 = second-to-last (penultimate), etc.
   *
   * Byte offsets are computed from raw \n positions in the buffer (not from decoded string
   * lengths) so that chunk boundaries splitting multi-byte UTF-8 sequences don't corrupt
   * the returned offset.
   */
  private async findLastBoundaryByteOffset(workspaceId: string, skip = 0): Promise<number | null> {
    const filePath = this.getChatHistoryPath(workspaceId);

    let fileSize: number;
    try {
      const stat = await fs.stat(filePath);
      fileSize = stat.size;
    } catch {
      return null;
    }
    if (fileSize === 0) return null;

    const fh = await fs.open(filePath, "r");
    try {
      let readEnd = fileSize;
      // Raw bytes of the incomplete first line from the previous (rightward) chunk.
      // Kept as Buffer (not string) so multi-byte chars split at chunk boundaries
      // don't corrupt byte offsets via UTF-8 replacement characters.
      let carryoverBytes = Buffer.alloc(0);
      let skipped = 0;

      while (readEnd > 0) {
        const readStart = Math.max(0, readEnd - HistoryService.REVERSE_READ_CHUNK_SIZE);
        const chunkSize = readEnd - readStart;
        const rawChunk = Buffer.alloc(chunkSize);
        await fh.read(rawChunk, 0, chunkSize, readStart);

        // Combine with carryover (the start of a line whose tail was in the previous chunk).
        // The combined buffer represents contiguous file bytes [readStart, readStart + buffer.length).
        const buffer =
          carryoverBytes.length > 0 ? Buffer.concat([rawChunk, carryoverBytes]) : rawChunk;

        // Find \n byte positions in the raw buffer for accurate byte offsets.
        // 0x0A never appears inside multi-byte UTF-8 sequences, so this is byte-safe
        // even when a chunk boundary splits a multibyte character.
        const newlinePositions: number[] = [];
        for (let b = 0; b < buffer.length; b++) {
          if (buffer[b] === 0x0a) {
            newlinePositions.push(b);
          }
        }

        if (newlinePositions.length === 0) {
          // No newlines — entire buffer is one partial line, carry it all forward
          carryoverBytes = Buffer.from(buffer);
          readEnd = readStart;
          continue;
        }

        // Bytes before the first \n are an incomplete line — carry forward
        carryoverBytes = Buffer.from(buffer.subarray(0, newlinePositions[0]));

        // Scan complete lines in reverse. Each line occupies
        // [newlinePositions[nl] + 1, nextNewline) in the buffer.
        for (let nl = newlinePositions.length - 1; nl >= 0; nl--) {
          const lineStart = newlinePositions[nl] + 1;
          const lineEnd =
            nl < newlinePositions.length - 1 ? newlinePositions[nl + 1] : buffer.length;
          if (lineEnd <= lineStart) continue; // empty line

          const line = buffer.subarray(lineStart, lineEnd).toString("utf-8");
          if (line.includes(HistoryService.BOUNDARY_NEEDLE)) {
            try {
              const msg = JSON.parse(line) as MuxMessage;
              if (isDurableCompactionBoundaryMarker(msg)) {
                if (skipped < skip) {
                  skipped++;
                } else {
                  return readStart + lineStart;
                }
              }
            } catch {
              // Malformed line — not a real boundary, skip
            }
          }
        }

        readEnd = readStart;
      }

      // Check the very first line (accumulated in carryover)
      if (carryoverBytes.length > 0) {
        const line = carryoverBytes.toString("utf-8");
        if (line.includes(HistoryService.BOUNDARY_NEEDLE)) {
          try {
            const msg = JSON.parse(line) as MuxMessage;
            if (isDurableCompactionBoundaryMarker(msg)) {
              if (skipped < skip) {
                // Not enough boundaries in the file to satisfy skip
                return null;
              }
              return 0;
            }
          } catch {
            // skip
          }
        }
      }

      return null;
    } finally {
      await fh.close();
    }
  }

  /**
   * Read and parse messages from a byte offset to the end of chat.jsonl.
   * Self-healing: skips malformed JSON lines the same way readChatHistory does.
   */
  private async readHistoryFromOffset(
    workspaceId: string,
    byteOffset: number
  ): Promise<MuxMessage[]> {
    const filePath = this.getChatHistoryPath(workspaceId);
    const stat = await fs.stat(filePath);
    const tailSize = stat.size - byteOffset;
    if (tailSize <= 0) return [];

    const fh = await fs.open(filePath, "r");
    try {
      const buffer = Buffer.alloc(tailSize);
      await fh.read(buffer, 0, tailSize, byteOffset);
      const lines = buffer
        .toString("utf-8")
        .split("\n")
        .filter((l) => l.trim());
      const messages: MuxMessage[] = [];
      for (const line of lines) {
        try {
          messages.push(normalizeLegacyMuxMetadata(JSON.parse(line) as MuxMessage));
        } catch {
          // Skip malformed lines — same self-healing behavior as readChatHistory
        }
      }
      return messages;
    } finally {
      await fh.close();
    }
  }

  /**
   * Read the last N messages from chat.jsonl by scanning the file in reverse.
   * Much cheaper than a full read when only the tail is needed.
   *
   * Uses raw byte scanning for \n positions (same approach as findLastBoundaryByteOffset)
   * so that chunk boundaries splitting multi-byte UTF-8 sequences don't corrupt lines.
   */
  private async readLastMessages(workspaceId: string, n: number): Promise<MuxMessage[]> {
    const filePath = this.getChatHistoryPath(workspaceId);

    let fileSize: number;
    try {
      const stat = await fs.stat(filePath);
      fileSize = stat.size;
    } catch {
      return [];
    }
    if (fileSize === 0) return [];

    const fh = await fs.open(filePath, "r");
    try {
      const collected: MuxMessage[] = [];
      let readEnd = fileSize;
      let carryoverBytes = Buffer.alloc(0);

      while (readEnd > 0 && collected.length < n) {
        const readStart = Math.max(0, readEnd - HistoryService.REVERSE_READ_CHUNK_SIZE);
        const chunkSize = readEnd - readStart;
        const rawChunk = Buffer.alloc(chunkSize);
        await fh.read(rawChunk, 0, chunkSize, readStart);

        const buffer =
          carryoverBytes.length > 0 ? Buffer.concat([rawChunk, carryoverBytes]) : rawChunk;

        const newlinePositions: number[] = [];
        for (let b = 0; b < buffer.length; b++) {
          if (buffer[b] === 0x0a) {
            newlinePositions.push(b);
          }
        }

        if (newlinePositions.length === 0) {
          carryoverBytes = Buffer.from(buffer);
          readEnd = readStart;
          continue;
        }

        carryoverBytes = Buffer.from(buffer.subarray(0, newlinePositions[0]));

        // Parse complete lines in reverse, stopping once we have enough
        for (let nl = newlinePositions.length - 1; nl >= 0 && collected.length < n; nl--) {
          const lineStart = newlinePositions[nl] + 1;
          const lineEnd =
            nl < newlinePositions.length - 1 ? newlinePositions[nl + 1] : buffer.length;
          if (lineEnd <= lineStart) continue;

          const line = buffer.subarray(lineStart, lineEnd).toString("utf-8").trim();
          if (line.length === 0) continue;
          try {
            collected.push(normalizeLegacyMuxMetadata(JSON.parse(line) as MuxMessage));
          } catch {
            // Skip malformed lines
          }
        }

        readEnd = readStart;
      }

      // Check the very first line if we still need more
      if (collected.length < n && carryoverBytes.length > 0) {
        const line = carryoverBytes.toString("utf-8").trim();
        if (line.length > 0) {
          try {
            collected.push(normalizeLegacyMuxMetadata(JSON.parse(line) as MuxMessage));
          } catch {
            // skip
          }
        }
      }

      // Reverse to restore chronological order
      collected.reverse();
      return collected;
    } finally {
      await fh.close();
    }
  }

  /**
   * Read raw messages from chat.jsonl (does not include partial.json)
   * Returns empty array if file doesn't exist
   * Skips malformed JSON lines to prevent data loss from corruption
   */
  private async readChatHistory(workspaceId: string): Promise<MuxMessage[]> {
    try {
      const chatHistoryPath = this.getChatHistoryPath(workspaceId);
      const data = await fs.readFile(chatHistoryPath, "utf-8");
      if (data.length > 5 * 1024 * 1024) {
        log.warn("chat.jsonl exceeds 5MB — full read may be slow, consider compaction", {
          workspaceId,
          sizeBytes: data.length,
        });
      }
      const lines = data.split("\n").filter((line) => line.trim());
      const messages: MuxMessage[] = [];

      for (let i = 0; i < lines.length; i++) {
        try {
          const message = JSON.parse(lines[i]) as MuxMessage;
          messages.push(normalizeLegacyMuxMetadata(message));
        } catch (parseError) {
          // Skip malformed lines but log error for debugging
          log.warn(
            `Skipping malformed JSON at line ${i + 1} in ${workspaceId}/chat.jsonl:`,
            parseError instanceof Error ? parseError.message : String(parseError),
            "\nLine content:",
            lines[i].substring(0, 100) + (lines[i].length > 100 ? "..." : "")
          );
        }
      }

      return messages;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return []; // No history yet
      }
      throw error; // Re-throw non-ENOENT errors
    }
  }

  // ── Forward/backward iteration infrastructure ────────────────────────────
  // Chunked iteration over chat.jsonl that yields messages to a visitor callback.
  // Supports early exit (return false) and reduces memory pressure vs. loading
  // the entire file into an array.

  /**
   * Read chat.jsonl from start to end in chunks, calling visitor with each
   * batch of parsed messages. Uses raw byte scanning for \n to handle
   * multi-byte UTF-8 safely at chunk boundaries.
   */
  private async iterateForward(
    workspaceId: string,
    visitor: (messages: MuxMessage[]) => boolean | void | Promise<boolean | void>
  ): Promise<void> {
    const filePath = this.getChatHistoryPath(workspaceId);

    let fileSize: number;
    try {
      const stat = await fs.stat(filePath);
      fileSize = stat.size;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return; // No history
      }
      throw error;
    }
    if (fileSize === 0) return;

    const fh = await fs.open(filePath, "r");
    try {
      let readPos = 0;
      // Incomplete last line from the previous chunk, kept as Buffer to
      // preserve split multi-byte UTF-8 sequences.
      let carryoverBytes = Buffer.alloc(0);

      while (readPos < fileSize) {
        const remaining = fileSize - readPos;
        const toRead = Math.min(HistoryService.REVERSE_READ_CHUNK_SIZE, remaining);
        const rawChunk = Buffer.alloc(toRead);
        await fh.read(rawChunk, 0, toRead, readPos);
        readPos += toRead;

        const buffer =
          carryoverBytes.length > 0 ? Buffer.concat([carryoverBytes, rawChunk]) : rawChunk;

        // Find the last \n to split complete lines from the trailing incomplete line.
        // 0x0A is byte-safe (never inside multi-byte UTF-8 sequences).
        let lastNewline = -1;
        for (let b = buffer.length - 1; b >= 0; b--) {
          if (buffer[b] === 0x0a) {
            lastNewline = b;
            break;
          }
        }

        if (lastNewline === -1) {
          // No newline in entire buffer — carry everything forward
          carryoverBytes = Buffer.from(buffer);
          continue;
        }

        // Decode only complete lines (up to and including the last \n)
        const completeText = buffer.subarray(0, lastNewline).toString("utf-8");
        carryoverBytes = Buffer.from(buffer.subarray(lastNewline + 1));

        const messages: MuxMessage[] = [];
        for (const line of completeText.split("\n")) {
          const trimmed = line.trim();
          if (trimmed.length === 0) continue;
          try {
            messages.push(normalizeLegacyMuxMetadata(JSON.parse(trimmed) as MuxMessage));
          } catch {
            // Skip malformed lines — same self-healing behavior as readChatHistory
          }
        }

        if (messages.length > 0) {
          const shouldContinue = await visitor(messages);
          if (shouldContinue === false) return;
        }
      }

      // Handle remaining carryover (last line without trailing newline)
      if (carryoverBytes.length > 0) {
        const line = carryoverBytes.toString("utf-8").trim();
        if (line.length > 0) {
          try {
            const msg = normalizeLegacyMuxMetadata(JSON.parse(line) as MuxMessage);
            await visitor([msg]);
          } catch {
            // Skip malformed line
          }
        }
      }
    } finally {
      await fh.close();
    }
  }

  /**
   * Read chat.jsonl from end to start in chunks, calling visitor with each
   * batch of parsed messages (newest first within each chunk). Uses the same
   * raw-byte \n scanning as findLastBoundaryByteOffset.
   */
  private async iterateBackward(
    workspaceId: string,
    visitor: (messages: MuxMessage[]) => boolean | void | Promise<boolean | void>
  ): Promise<void> {
    const filePath = this.getChatHistoryPath(workspaceId);

    let fileSize: number;
    try {
      const stat = await fs.stat(filePath);
      fileSize = stat.size;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return; // No history
      }
      throw error;
    }
    if (fileSize === 0) return;

    const fh = await fs.open(filePath, "r");
    try {
      let readEnd = fileSize;
      let carryoverBytes = Buffer.alloc(0);

      while (readEnd > 0) {
        const readStart = Math.max(0, readEnd - HistoryService.REVERSE_READ_CHUNK_SIZE);
        const chunkSize = readEnd - readStart;
        const rawChunk = Buffer.alloc(chunkSize);
        await fh.read(rawChunk, 0, chunkSize, readStart);

        const buffer =
          carryoverBytes.length > 0 ? Buffer.concat([rawChunk, carryoverBytes]) : rawChunk;

        const newlinePositions: number[] = [];
        for (let b = 0; b < buffer.length; b++) {
          if (buffer[b] === 0x0a) {
            newlinePositions.push(b);
          }
        }

        if (newlinePositions.length === 0) {
          carryoverBytes = Buffer.from(buffer);
          readEnd = readStart;
          continue;
        }

        carryoverBytes = Buffer.from(buffer.subarray(0, newlinePositions[0]));

        // Parse complete lines in reverse (newest → oldest for backward iteration)
        const messages: MuxMessage[] = [];
        for (let nl = newlinePositions.length - 1; nl >= 0; nl--) {
          const lineStart = newlinePositions[nl] + 1;
          const lineEnd =
            nl < newlinePositions.length - 1 ? newlinePositions[nl + 1] : buffer.length;
          if (lineEnd <= lineStart) continue;

          const line = buffer.subarray(lineStart, lineEnd).toString("utf-8").trim();
          if (line.length === 0) continue;
          try {
            messages.push(normalizeLegacyMuxMetadata(JSON.parse(line) as MuxMessage));
          } catch {
            // Skip malformed lines
          }
        }

        if (messages.length > 0) {
          const shouldContinue = await visitor(messages);
          if (shouldContinue === false) return;
        }

        readEnd = readStart;
      }

      // Check the very first line (accumulated in carryover)
      if (carryoverBytes.length > 0) {
        const line = carryoverBytes.toString("utf-8").trim();
        if (line.length > 0) {
          try {
            const msg = normalizeLegacyMuxMetadata(JSON.parse(line) as MuxMessage);
            await visitor([msg]);
          } catch {
            // Skip malformed line
          }
        }
      }
    } finally {
      await fh.close();
    }
  }

  /**
   * Iterate over ALL messages in chat.jsonl — O(file-size) I/O + parse.
   *
   * ⚠️  Prefer targeted alternatives for hot paths:
   *   - getHistoryFromLatestBoundary() — for provider-request assembly
   *   - getLastMessages(n)            — when only the tail matters
   *   - hasHistory()                  — for emptiness checks
   *
   * Yields chunks of parsed messages to the visitor callback. The visitor may
   * return `false` to stop iteration early (e.g., after finding a target message).
   *
   * @param direction - 'forward' reads oldest→newest, 'backward' reads newest→oldest
   * @param visitor - Called with each chunk of messages. Return false to stop early.
   */
  async iterateFullHistory(
    workspaceId: string,
    direction: "forward" | "backward",
    visitor: (messages: MuxMessage[]) => boolean | void | Promise<boolean | void>
  ): Promise<Result<void>> {
    try {
      if (direction === "forward") {
        await this.iterateForward(workspaceId, visitor);
      } else {
        await this.iterateBackward(workspaceId, visitor);
      }
      return Ok(undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Err(`Failed to iterate history: ${message}`);
    }
  }

  /**
   * Read messages from a compaction boundary onward.
   * Falls back to full history if no boundary exists (new/uncompacted workspace).
   *
   * @param skip How many boundaries to skip (counting from the latest). 0 = read
   *             from the latest boundary, 1 = from the penultimate, etc. When the
   *             requested boundary doesn't exist, falls back to the next-available
   *             boundary, then to full history.
   *
   * Prefer this over iterateFullHistory() for provider-request assembly and any path
   * that only needs the active compaction epoch.
   */
  async getHistoryFromLatestBoundary(workspaceId: string, skip = 0): Promise<Result<MuxMessage[]>> {
    try {
      // Try the requested boundary, falling back to less-skipped boundaries
      for (let s = skip; s >= 0; s--) {
        const offset = await this.findLastBoundaryByteOffset(workspaceId, s);
        if (offset !== null) {
          const messages = await this.readHistoryFromOffset(workspaceId, offset);
          return Ok(messages);
        }
      }

      // No boundaries at all — workspace is uncompacted, full read is the only option
      const messages = await this.readChatHistory(workspaceId);
      return Ok(messages);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Err(`Failed to read history from boundary: ${message}`);
    }
  }

  /**
   * Read the last N messages from chat.jsonl by reading the file in reverse.
   * Much cheaper than iterateFullHistory() when only the tail is needed.
   */
  async getLastMessages(workspaceId: string, n: number): Promise<Result<MuxMessage[]>> {
    try {
      const messages = await this.readLastMessages(workspaceId, n);
      return Ok(messages);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Err(`Failed to read last ${n} messages: ${message}`);
    }
  }

  /**
   * Check if a workspace has any chat history without parsing the file.
   * Much cheaper than iterateFullHistory() when only an emptiness check is needed.
   */
  async hasHistory(workspaceId: string): Promise<boolean> {
    const filePath = this.getChatHistoryPath(workspaceId);
    try {
      const stat = await fs.stat(filePath);
      return stat.size > 0;
    } catch {
      return false;
    }
  }

  /**
   * Get or initialize the next history sequence number for a workspace
   */
  private async getNextHistorySequence(workspaceId: string): Promise<number> {
    // Check if we already have it in memory
    if (this.sequenceCounters.has(workspaceId)) {
      return this.sequenceCounters.get(workspaceId)!;
    }

    // Initialize from history — sequence numbers are monotonically increasing,
    // so the last message always holds the max. Use getLastMessages(1) to avoid
    // reading the entire file.
    const lastResult = await this.getLastMessages(workspaceId, 1);
    if (lastResult.success && lastResult.data.length > 0) {
      const lastMsg = lastResult.data[0];
      const seqNum = lastMsg.metadata?.historySequence;
      if (isNonNegativeInteger(seqNum)) {
        const nextSeqNum = seqNum + 1;
        this.sequenceCounters.set(workspaceId, nextSeqNum);
        return nextSeqNum;
      }
      // Last message has no valid sequence — fall back to scanning backward
      // through all messages to find the max (handles legacy data).
      let maxSeqNum = -1;
      const scanResult = await this.iterateFullHistory(workspaceId, "backward", (chunk) => {
        for (const msg of chunk) {
          const seq = msg.metadata?.historySequence;
          if (isNonNegativeInteger(seq)) {
            maxSeqNum = Math.max(maxSeqNum, seq);
            // Found a valid sequence — it's the max since we're scanning backward
            return false;
          }
        }
      });
      if (scanResult.success) {
        const nextSeqNum = maxSeqNum + 1;
        assert(
          isNonNegativeInteger(nextSeqNum),
          "next history sequence counter must be a non-negative integer"
        );
        this.sequenceCounters.set(workspaceId, nextSeqNum);
        return nextSeqNum;
      }
    }

    // No history yet, start from 0
    this.sequenceCounters.set(workspaceId, 0);
    return 0;
  }

  /**
   * Internal helper for appending to history without acquiring lock
   * Used by both appendToHistory and commitPartial to avoid deadlock
   */
  private async _appendToHistoryUnlocked(
    workspaceId: string,
    message: MuxMessage
  ): Promise<Result<void>> {
    try {
      const workspaceDir = this.config.getSessionDir(workspaceId);
      await fs.mkdir(workspaceDir, { recursive: true });
      const historyPath = this.getChatHistoryPath(workspaceId);

      // DEBUG: Log message append with caller stack trace
      const stack = new Error().stack?.split("\n").slice(2, 6).join("\n") ?? "no stack";
      log.debug(
        `[HISTORY APPEND] workspaceId=${workspaceId} role=${message.role} id=${message.id}`
      );
      log.debug(`[HISTORY APPEND] Call stack:\n${stack}`);

      // Ensure message has a history sequence number
      if (!message.metadata) {
        // Create metadata with history sequence
        const nextSeqNum = await this.getNextHistorySequence(workspaceId);
        assert(
          isNonNegativeInteger(nextSeqNum),
          "getNextHistorySequence must return a non-negative integer"
        );
        message.metadata = {
          historySequence: nextSeqNum,
        };
        this.sequenceCounters.set(workspaceId, nextSeqNum + 1);
      } else {
        // Message already has metadata, but may need historySequence assigned
        const existingSeqNum = message.metadata.historySequence;
        if (existingSeqNum !== undefined) {
          assert(
            isNonNegativeInteger(existingSeqNum),
            "appendToHistory requires historySequence to be a non-negative integer when provided"
          );

          // Already has history sequence, update counter if needed
          const currentCounter = this.sequenceCounters.get(workspaceId) ?? 0;
          assert(
            isNonNegativeInteger(currentCounter),
            "history sequence counter must remain a non-negative integer"
          );
          if (existingSeqNum >= currentCounter) {
            this.sequenceCounters.set(workspaceId, existingSeqNum + 1);
          }
        } else {
          // Has metadata but no historySequence, assign one
          const nextSeqNum = await this.getNextHistorySequence(workspaceId);
          assert(
            isNonNegativeInteger(nextSeqNum),
            "getNextHistorySequence must return a non-negative integer"
          );
          message.metadata = {
            ...message.metadata,
            historySequence: nextSeqNum,
          };
          this.sequenceCounters.set(workspaceId, nextSeqNum + 1);
        }
      }

      // Store the message with workspace context
      const historyEntry = {
        ...message,
        workspaceId,
      };

      // DEBUG: Log assigned sequence number
      log.debug(
        `[HISTORY APPEND] Assigned historySequence=${message.metadata.historySequence ?? "unknown"} role=${message.role}`
      );

      await fs.appendFile(historyPath, JSON.stringify(historyEntry) + "\n");
      return Ok(undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Err(`Failed to append to history: ${message}`);
    }
  }

  async appendToHistory(workspaceId: string, message: MuxMessage): Promise<Result<void>> {
    return this.fileLocks.withLock(workspaceId, async () => {
      return this._appendToHistoryUnlocked(workspaceId, message);
    });
  }

  /**
   * Update an existing message in history by historySequence
   * Reads entire history, replaces the matching message, and rewrites the file
   */
  async updateHistory(workspaceId: string, message: MuxMessage): Promise<Result<void>> {
    return this.fileLocks.withLock(workspaceId, async () => {
      try {
        const historyPath = this.getChatHistoryPath(workspaceId);

        // Read all messages — structural rewrite requires full file content
        const messages = await this.readChatHistory(workspaceId);
        const targetSequence = message.metadata?.historySequence;

        if (targetSequence === undefined) {
          return Err("Cannot update message without historySequence");
        }

        assert(
          isNonNegativeInteger(targetSequence),
          "updateHistory requires historySequence to be a non-negative integer"
        );

        // Find and replace the message with matching historySequence
        let found = false;
        for (let i = 0; i < messages.length; i++) {
          if (messages[i].metadata?.historySequence === targetSequence) {
            const existingMessage = messages[i];
            assert(existingMessage, "updateHistory matched message must exist");

            // Preserve compaction boundary metadata during late in-place rewrites.
            // Compaction may update an assistant row first, then a late stream rewrite can
            // update that same historySequence and accidentally drop compaction markers.
            const preservedCompactionMetadata = getCompactionMetadataToPreserve(
              workspaceId,
              existingMessage,
              message
            );

            // Preserve the historySequence, update everything else.
            messages[i] = {
              ...message,
              metadata: {
                ...message.metadata,
                ...(preservedCompactionMetadata ?? {}),
                historySequence: targetSequence,
              },
            };
            found = true;
            break;
          }
        }

        if (!found) {
          return Err(`No message found with historySequence ${targetSequence}`);
        }

        // Rewrite entire file
        const historyEntries = messages
          .map((msg) => JSON.stringify({ ...msg, workspaceId }) + "\n")
          .join("");

        // Atomic write prevents corruption if app crashes mid-write
        await writeFileAtomic(historyPath, historyEntries);
        return Ok(undefined);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return Err(`Failed to update history: ${message}`);
      }
    });
  }

  /**
   * Delete a single message by ID while preserving the rest of the history.
   *
   * This is safer than truncateAfterMessage for cleanup paths where subsequent
   * messages may already have been appended.
   */
  async deleteMessage(workspaceId: string, messageId: string): Promise<Result<void>> {
    return this.fileLocks.withLock(workspaceId, async () => {
      try {
        // Structural rewrite requires full file content
        const messages = await this.readChatHistory(workspaceId);
        const filteredMessages = messages.filter((msg) => msg.id !== messageId);

        if (filteredMessages.length === messages.length) {
          return Err(`Message with ID ${messageId} not found in history`);
        }

        const historyPath = this.getChatHistoryPath(workspaceId);
        const historyEntries = filteredMessages
          .map((msg) => JSON.stringify({ ...msg, workspaceId }) + "\n")
          .join("");

        // Atomic write prevents corruption if app crashes mid-write
        await writeFileAtomic(historyPath, historyEntries);

        // Keep the in-memory sequence counter monotonic. It's okay to reuse deleted sequence
        // numbers on restart, but we must not regress within a running process.
        const maxSeq = filteredMessages.reduce((max, msg) => {
          const seq = msg.metadata?.historySequence;
          if (seq === undefined) {
            return max;
          }

          if (!isNonNegativeInteger(seq)) {
            log.warn(
              "Ignoring malformed persisted historySequence while updating sequence counter after delete",
              {
                workspaceId,
                messageId: msg.id,
                historySequence: seq,
              }
            );
            return max;
          }

          return seq > max ? seq : max;
        }, -1);
        const nextSeq = maxSeq + 1;
        assert(
          isNonNegativeInteger(nextSeq),
          "next history sequence counter after delete must be a non-negative integer"
        );
        const currentCounter = this.sequenceCounters.get(workspaceId);
        if (currentCounter === undefined || currentCounter < nextSeq) {
          this.sequenceCounters.set(workspaceId, nextSeq);
        }

        return Ok(undefined);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return Err(`Failed to delete message: ${message}`);
      }
    });
  }

  /**
   * Truncate history after a specific message ID
   * Removes the message with the given ID and all subsequent messages
   */
  async truncateAfterMessage(workspaceId: string, messageId: string): Promise<Result<void>> {
    return this.fileLocks.withLock(workspaceId, async () => {
      try {
        // Structural rewrite requires full file content
        const messages = await this.readChatHistory(workspaceId);
        const messageIndex = messages.findIndex((msg) => msg.id === messageId);

        if (messageIndex === -1) {
          return Err(`Message with ID ${messageId} not found in history`);
        }

        // Keep only messages before the target message
        const truncatedMessages = messages.slice(0, messageIndex);

        // Rewrite the history file with truncated messages
        const historyPath = this.getChatHistoryPath(workspaceId);
        const historyEntries = truncatedMessages
          .map((msg) => JSON.stringify({ ...msg, workspaceId }) + "\n")
          .join("");

        // Atomic write prevents corruption if app crashes mid-write
        await writeFileAtomic(historyPath, historyEntries);

        // Update sequence counter to continue from where we truncated.
        // Self-healing read path: skip malformed persisted historySequence values.
        const maxTruncatedSeq = truncatedMessages.reduce((max, msg) => {
          const seq = msg.metadata?.historySequence;
          if (seq === undefined) {
            return max;
          }

          if (!isNonNegativeInteger(seq)) {
            log.warn(
              "Ignoring malformed persisted historySequence while updating sequence counter after truncation",
              {
                workspaceId,
                messageId: msg.id,
                historySequence: seq,
              }
            );
            return max;
          }

          return seq > max ? seq : max;
        }, -1);
        const nextSeq = maxTruncatedSeq + 1;
        assert(
          isNonNegativeInteger(nextSeq),
          "next history sequence counter after truncation must be a non-negative integer"
        );
        this.sequenceCounters.set(workspaceId, nextSeq);

        return Ok(undefined);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return Err(`Failed to truncate history: ${message}`);
      }
    });
  }

  /**
   * Truncate history by removing approximately the given percentage of tokens from the beginning
   * @param workspaceId The workspace ID
   * @param percentage Percentage to truncate (0.0 to 1.0). 1.0 = delete all
   * @returns Result containing array of deleted historySequence numbers
   */
  async truncateHistory(
    workspaceId: string,
    percentage: number
  ): Promise<Result<number[], string>> {
    return this.fileLocks.withLock(workspaceId, async () => {
      try {
        const historyPath = this.getChatHistoryPath(workspaceId);

        // Fast path: 100% truncation = delete entire file
        if (percentage >= 1.0) {
          // Need sequence numbers for return value before deleting
          const messages = await this.readChatHistory(workspaceId);
          const deletedSequences = messages
            .map((msg) => msg.metadata?.historySequence)
            .filter((s): s is number => isNonNegativeInteger(s));

          try {
            await fs.unlink(historyPath);
          } catch (error) {
            // Ignore ENOENT - file already deleted
            if (
              !(error && typeof error === "object" && "code" in error && error.code === "ENOENT")
            ) {
              throw error;
            }
          }

          // Reset sequence counter when clearing history
          this.sequenceCounters.set(workspaceId, 0);
          return Ok(deletedSequences);
        }

        // Structural rewrite requires full file content
        const messages = await this.readChatHistory(workspaceId);
        if (messages.length === 0) {
          return Ok([]); // Nothing to truncate
        }

        // Get tokenizer for counting (use a default model)
        const tokenizer = await getTokenizerForModel(KNOWN_MODELS.SONNET.id);

        // Count tokens for each message
        // We stringify the entire message for simplicity - only relative weights matter
        const messageTokens: Array<{ message: MuxMessage; tokens: number }> = await Promise.all(
          messages.map(async (msg) => {
            const tokens = await tokenizer.countTokens(safeStringifyForCounting(msg));
            return { message: msg, tokens };
          })
        );

        // Calculate total tokens and target to remove
        const totalTokens = messageTokens.reduce((sum, mt) => sum + mt.tokens, 0);
        const tokensToRemove = Math.floor(totalTokens * percentage);

        // Remove messages from beginning until we've removed enough tokens
        let tokensRemoved = 0;
        let removeCount = 0;
        for (const mt of messageTokens) {
          if (tokensRemoved >= tokensToRemove) {
            break;
          }
          tokensRemoved += mt.tokens;
          removeCount++;
        }

        // If we're removing all messages, use fast path
        if (removeCount >= messages.length) {
          try {
            await fs.unlink(historyPath);
          } catch (error) {
            // Ignore ENOENT
            if (
              !(error && typeof error === "object" && "code" in error && error.code === "ENOENT")
            ) {
              throw error;
            }
          }
          this.sequenceCounters.set(workspaceId, 0);
          const deletedSequences = messages
            .map((msg) => msg.metadata?.historySequence)
            .filter((s): s is number => isNonNegativeInteger(s));
          return Ok(deletedSequences);
        }

        // Keep messages after removeCount
        const remainingMessages = messages.slice(removeCount);
        const deletedMessages = messages.slice(0, removeCount);
        const deletedSequences = deletedMessages
          .map((msg) => msg.metadata?.historySequence)
          .filter((s): s is number => isNonNegativeInteger(s));

        // Rewrite the history file with remaining messages
        const historyEntries = remainingMessages
          .map((msg) => JSON.stringify({ ...msg, workspaceId }) + "\n")
          .join("");

        // Atomic write prevents corruption if app crashes mid-write
        await writeFileAtomic(historyPath, historyEntries);

        // Update sequence counter to continue from where we are.
        // Self-healing read path: skip malformed persisted historySequence values.
        const maxRemainingSeq = remainingMessages.reduce((max, msg) => {
          const seq = msg.metadata?.historySequence;
          if (seq === undefined) {
            return max;
          }

          if (!isNonNegativeInteger(seq)) {
            log.warn(
              "Ignoring malformed persisted historySequence while updating sequence counter after truncateHistory",
              {
                workspaceId,
                messageId: msg.id,
                historySequence: seq,
              }
            );
            return max;
          }

          return seq > max ? seq : max;
        }, -1);
        const nextSeq = maxRemainingSeq + 1;
        assert(
          isNonNegativeInteger(nextSeq),
          "next history sequence counter after truncateHistory must be a non-negative integer"
        );
        this.sequenceCounters.set(workspaceId, nextSeq);

        return Ok(deletedSequences);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return Err(`Failed to truncate history: ${message}`);
      }
    });
  }

  async clearHistory(workspaceId: string): Promise<Result<number[], string>> {
    const result = await this.truncateHistory(workspaceId, 1.0);
    if (!result.success) {
      return Err(result.error);
    }
    return Ok(result.data);
  }

  /**
   * Migrate all messages in chat.jsonl to use a new workspace ID
   * This is used during workspace rename to update the workspaceId field in all historical messages
   * IMPORTANT: Should be called AFTER the session directory has been renamed
   */
  async migrateWorkspaceId(oldWorkspaceId: string, newWorkspaceId: string): Promise<Result<void>> {
    return this.fileLocks.withLock(newWorkspaceId, async () => {
      try {
        // Read messages from the NEW workspace location (directory was already renamed).
        // Structural rewrite requires full file content.
        const messages = await this.readChatHistory(newWorkspaceId);
        if (messages.length === 0) {
          // No messages to migrate, just transfer sequence counter
          const oldCounter = this.sequenceCounters.get(oldWorkspaceId) ?? 0;
          this.sequenceCounters.set(newWorkspaceId, oldCounter);
          this.sequenceCounters.delete(oldWorkspaceId);
          return Ok(undefined);
        }

        // Rewrite all messages with new workspace ID
        const newHistoryPath = this.getChatHistoryPath(newWorkspaceId);
        const historyEntries = messages
          .map((msg) => JSON.stringify({ ...msg, workspaceId: newWorkspaceId }) + "\n")
          .join("");

        // Atomic write prevents corruption if app crashes mid-write
        await writeFileAtomic(newHistoryPath, historyEntries);

        // Transfer sequence counter to new workspace ID
        const oldCounter = this.sequenceCounters.get(oldWorkspaceId) ?? 0;
        this.sequenceCounters.set(newWorkspaceId, oldCounter);
        this.sequenceCounters.delete(oldWorkspaceId);

        log.debug(
          `Migrated ${messages.length} messages from ${oldWorkspaceId} to ${newWorkspaceId}`
        );

        return Ok(undefined);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return Err(`Failed to migrate workspace ID: ${message}`);
      }
    });
  }
}
