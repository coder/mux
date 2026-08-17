import { describe, expect, test } from "bun:test";
import * as fs from "fs/promises";
import * as path from "path";
import { z } from "zod";
import { DisposableTempDir } from "@/node/services/tempDir";
import { Journal } from "./journal";

const RowSchema = z.object({
  seq: z.number().int().nonnegative(),
  id: z.string().min(1),
  value: z.string(),
});
type Row = z.infer<typeof RowSchema>;

function makeJournal(dir: string): Journal<Row> {
  return new Journal<Row>({
    filePath: path.join(dir, "test.jsonl"),
    schema: RowSchema,
    getSeq: (row) => row.seq,
    getId: (row) => row.id,
  });
}

describe("Journal", () => {
  test("appends rows with monotonic sequence and reads them back", async () => {
    using tmp = new DisposableTempDir("journal-test");
    const journal = makeJournal(tmp.path);

    const a = await journal.append((seq) => ({ seq, id: "a", value: "first" }));
    const b = await journal.append((seq) => ({ seq, id: "b", value: "second" }));
    expect(a.seq).toBe(0);
    expect(b.seq).toBe(1);

    const rows = await journal.read();
    expect(rows.map((r) => r.value)).toEqual(["first", "second"]);
  });

  test("resumes the sequence counter from existing rows (fresh instance)", async () => {
    using tmp = new DisposableTempDir("journal-test");
    await makeJournal(tmp.path).append((seq) => ({ seq, id: "a", value: "x" }));
    const reopened = makeJournal(tmp.path);
    const next = await reopened.append((seq) => ({ seq, id: "b", value: "y" }));
    expect(next.seq).toBe(1);
  });

  test("self-heals: corrupted lines never brick the journal", async () => {
    using tmp = new DisposableTempDir("journal-test");
    const filePath = path.join(tmp.path, "test.jsonl");
    const journal = makeJournal(tmp.path);
    await journal.append((seq) => ({ seq, id: "a", value: "good-1" }));
    await journal.append((seq) => ({ seq, id: "b", value: "good-2" }));

    // Inject: malformed JSON, schema-invalid row, duplicate id, torn tail.
    await fs.appendFile(filePath, "{not json at all\n");
    await fs.appendFile(filePath, `${JSON.stringify({ seq: "NaN", id: 5 })}\n`);
    await fs.appendFile(filePath, `${JSON.stringify({ seq: 0, id: "a", value: "dupe" })}\n`);
    await fs.appendFile(filePath, '{"seq":99,"id":"torn","va'); // no newline - torn write

    const reopened = makeJournal(tmp.path);
    const rows = await reopened.read();
    expect(rows.map((r) => r.value)).toEqual(["good-1", "good-2"]); // first id wins, garbage dropped

    // Appending after a torn tail heals the file (new row lands on a fresh line).
    const next = await reopened.append((seq) => ({ seq, id: "c", value: "good-3" }));
    expect(next.seq).toBe(2);
    const healed = await reopened.read();
    expect(healed.map((r) => r.value)).toEqual(["good-1", "good-2", "good-3"]);
  });

  test("read sorts by seq and returns [] for a missing file", async () => {
    using tmp = new DisposableTempDir("journal-test");
    const filePath = path.join(tmp.path, "test.jsonl");
    expect(await makeJournal(tmp.path).read()).toEqual([]);

    // Out-of-order rows on disk (e.g. merged files) come back seq-sorted.
    await fs.mkdir(tmp.path, { recursive: true });
    await fs.writeFile(
      filePath,
      `${JSON.stringify({ seq: 2, id: "c", value: "third" })}\n` +
        `${JSON.stringify({ seq: 0, id: "a", value: "first" })}\n` +
        `${JSON.stringify({ seq: 1, id: "b", value: "second" })}\n`
    );
    const rows = await makeJournal(tmp.path).read();
    expect(rows.map((r) => r.value)).toEqual(["first", "second", "third"]);
  });

  test("append rejects rows that fail schema validation", async () => {
    using tmp = new DisposableTempDir("journal-test");
    const journal = makeJournal(tmp.path);
    try {
      await journal.append((seq) => ({ seq, id: "", value: "empty id" }));
      expect.unreachable("Should have thrown");
    } catch (e) {
      expect(String(e)).toContain("failed schema validation");
    }
    // The failed append must not poison subsequent appends.
    const ok = await journal.append((seq) => ({ seq, id: "a", value: "fine" }));
    expect(ok.seq).toBe(0);
  });
});
