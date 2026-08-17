/**
 * Journal kit: append-only JSONL journal with monotonic sequence assignment,
 * stable-ID dedupe, and self-healing reads (substrate 2 of the shared agent
 * foundation).
 *
 * Doctrine (matches HistoryService/TimelineService): one malformed or
 * duplicated line must never brick the log. Appends are single-write JSONL
 * lines; torn tails from crashes are healed by prepending a separator on the
 * next append and by skipping unparseable lines on read.
 *
 * Single-writer expectation: one Journal instance owns a file at a time.
 * Appends are serialized through an internal promise queue so sequence
 * assignment is race-free within the instance.
 */

import assert from "node:assert";
import * as fs from "fs/promises";
import * as path from "path";
import { log } from "@/node/services/log";

/** Minimal schema contract (zod-compatible) so the kit stays dependency-light. */
export interface JournalRowSchema<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false; error?: unknown };
}

export interface JournalOptions<T> {
  filePath: string;
  schema: JournalRowSchema<T>;
  /** Extract the monotonic sequence from a row. */
  getSeq: (row: T) => number;
  /** Extract the stable unique id from a row (dedupe key on read). */
  getId: (row: T) => string;
}

export class Journal<T> {
  private readonly filePath: string;
  private readonly schema: JournalRowSchema<T>;
  private readonly getSeq: (row: T) => number;
  private readonly getId: (row: T) => string;
  /** Next sequence to assign; null until the file has been scanned once. */
  private nextSeq: number | null = null;
  /** Serializes appends so seq assignment and tail-healing are race-free. */
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(options: JournalOptions<T>) {
    assert(options.filePath.length > 0, "Journal requires a file path");
    this.filePath = options.filePath;
    this.schema = options.schema;
    this.getSeq = options.getSeq;
    this.getId = options.getId;
  }

  /**
   * Append one row built from the next monotonic sequence number. The build
   * result is validated against the schema before hitting disk (crash-fast on
   * programmer error rather than persisting garbage).
   */
  async append(build: (seq: number) => T): Promise<T> {
    const task = this.writeQueue.then(async () => {
      const seq = await this.ensureNextSeq();
      const row = build(seq);
      assert(
        this.getSeq(row) === seq,
        `Journal append: row seq ${this.getSeq(row)} must equal assigned seq ${seq}`
      );
      const parsed = this.schema.safeParse(row);
      assert(
        parsed.success,
        `Journal append: row failed schema validation: ${JSON.stringify(row)}`
      );

      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      // Heal a torn tail (crash mid-append): start on a fresh line so this row
      // stays parseable even if the previous write was truncated.
      const separator = (await this.hasUnterminatedTail()) ? "\n" : "";
      const line = JSON.stringify(row);
      assert(!line.includes("\n"), "Journal rows must serialize to a single line");
      await fs.appendFile(this.filePath, `${separator}${line}\n`, "utf-8");
      this.nextSeq = seq + 1;
      return row;
    });
    // Keep the queue alive even if this append fails.
    this.writeQueue = task.catch(() => undefined);
    return task;
  }

  /**
   * Read all rows, self-healing as we go:
   * - unparseable / schema-invalid lines are skipped (warn-logged),
   * - duplicate ids are dropped (first occurrence wins),
   * - rows are stable-sorted by seq (ties keep file order).
   */
  async read(): Promise<T[]> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }

    const rows: T[] = [];
    const seenIds = new Set<string>();
    const lines = raw.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        log.warn(`Journal: skipping malformed JSON at line ${i + 1} in ${this.filePath}`);
        continue;
      }
      const parsed = this.schema.safeParse(value);
      if (!parsed.success) {
        log.warn(`Journal: skipping schema-invalid row at line ${i + 1} in ${this.filePath}`);
        continue;
      }
      const id = this.getId(parsed.data);
      if (seenIds.has(id)) {
        log.warn(`Journal: dropping duplicate row id '${id}' at line ${i + 1} in ${this.filePath}`);
        continue;
      }
      seenIds.add(id);
      rows.push(parsed.data);
    }

    // Stable sort by seq; JS Array.prototype.sort is stable, so file order is
    // preserved for equal sequence numbers.
    rows.sort((a, b) => this.getSeq(a) - this.getSeq(b));
    return rows;
  }

  /** Scan once to initialize the monotonic counter (max valid seq + 1). */
  private async ensureNextSeq(): Promise<number> {
    if (this.nextSeq !== null) {
      return this.nextSeq;
    }
    const rows = await this.read();
    const maxSeq = rows.reduce((max, row) => Math.max(max, this.getSeq(row)), -1);
    this.nextSeq = maxSeq + 1;
    return this.nextSeq;
  }

  /** True when the file exists, is non-empty, and does not end with "\n". */
  private async hasUnterminatedTail(): Promise<boolean> {
    let handle: fs.FileHandle;
    try {
      handle = await fs.open(this.filePath, "r");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return false;
      }
      throw error;
    }
    try {
      const { size } = await handle.stat();
      if (size === 0) {
        return false;
      }
      const buffer = Buffer.alloc(1);
      await handle.read(buffer, 0, 1, size - 1);
      return buffer.toString("utf-8") !== "\n";
    } finally {
      await handle.close();
    }
  }
}
