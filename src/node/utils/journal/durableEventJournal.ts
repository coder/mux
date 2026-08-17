/**
 * DurableEventJournal: the concrete per-session journal for the shared
 * durable-event schema (src/common/types/durableEvent.ts), pairing the generic
 * Journal with a content-addressed BlobStore.
 *
 * Layout inside a session dir:
 * - `durable-events.jsonl` — one DurableEvent per line
 * - `blobs/<hash[0:2]>/<hash>` — content-addressed payloads
 *
 * This is the durable leg of the event spine's three-way split. New consumers
 * (turn envelopes, refinement journal, result handles) append here; the
 * HistoryService/chat.jsonl family intentionally stays as-is.
 */

import crypto from "node:crypto";
import * as path from "path";
import {
  DurableEventSchema,
  DURABLE_EVENT_VERSION,
  type DurableEvent,
  type DurableEventDraft,
} from "@/common/types/durableEvent";
import { Journal } from "./journal";
import { BlobStore } from "./blobStore";

export const DURABLE_EVENTS_FILE_NAME = "durable-events.jsonl";
export const BLOBS_DIR_NAME = "blobs";

export class DurableEventJournal {
  private readonly journal: Journal<DurableEvent>;
  /** Blob store for content-addressed payloads referenced from rows. */
  public readonly blobs: BlobStore;

  constructor(sessionDir: string) {
    this.journal = new Journal<DurableEvent>({
      filePath: path.join(sessionDir, DURABLE_EVENTS_FILE_NAME),
      schema: DurableEventSchema,
      getSeq: (row) => row.seq,
      getId: (row) => row.id,
    });
    this.blobs = new BlobStore(path.join(sessionDir, BLOBS_DIR_NAME));
  }

  /** Append a draft; the journal assigns v/seq/ts (and id unless provided). */
  async append(draft: DurableEventDraft): Promise<DurableEvent> {
    return this.journal.append((seq) => {
      const row = {
        ...draft,
        v: DURABLE_EVENT_VERSION,
        seq,
        id: draft.id ?? crypto.randomUUID(),
        ts: Date.now(),
      };
      // The spread of a distributive draft union does not re-narrow to the
      // discriminated union; the journal schema-validates the row on append.
      return row as DurableEvent;
    });
  }

  /** Read all events (self-healed: malformed/duplicate rows dropped, seq order). */
  async read(): Promise<DurableEvent[]> {
    return this.journal.read();
  }
}
