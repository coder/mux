import { describe, expect, test } from "bun:test";
import { DisposableTempDir } from "@/node/services/tempDir";
import { DurableEventJournal, sharedDurableEventJournal } from "./durableEventJournal";

describe("DurableEventJournal", () => {
  test("appends drafts for every schema kind and reads them back in order", async () => {
    using tmp = new DisposableTempDir("durable-journal-test");
    const journal = new DurableEventJournal(tmp.path);

    // Content-address a system prompt, then reference it from a turn envelope.
    const { ref: promptRef } = await journal.blobs.put("You are a helpful agent.");
    const envelope = await journal.append({
      workspaceId: "ws-1",
      kind: "turn-envelope",
      data: {
        systemPromptHash: promptRef,
        toolsetManifest: [
          { name: "bash", schemaHash: "abc" },
          { name: "file_read", schemaHash: "def" },
        ],
        modelString: "anthropic:claude-test",
        providerOptionsHash: "opts-hash",
        thinkingLevel: "medium",
      },
    });
    expect(envelope.seq).toBe(0);
    expect(envelope.v).toBe(1);

    const { ref: valueRef, size } = await journal.blobs.put("x".repeat(1024));
    await journal.append({
      workspaceId: "ws-1",
      kind: "result-handle",
      data: { handle: "vars.searchResults", preview: "xxxx…", blobHash: valueRef, size },
    });

    await journal.append({
      workspaceId: "ws-1",
      kind: "refinement",
      id: "refinement-1",
      data: { kind: "skill-edit", action: { file: "SKILL.md" }, inverse: { revert: true } },
    });

    await journal.append({
      workspaceId: "ws-1",
      kind: "hook-context",
      data: { hookId: "plugin:demo", placement: "system-prompt", text: "extra context" },
    });

    await journal.append({
      workspaceId: "ws-1",
      kind: "sandbox-vars-snapshot",
      data: { scopeKey: "ws-1", blobHash: valueRef, size },
    });

    const events = await journal.read();
    expect(events.map((e) => e.kind)).toEqual([
      "turn-envelope",
      "result-handle",
      "refinement",
      "hook-context",
      "sandbox-vars-snapshot",
    ]);
    expect(events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4]);
    // Caller-supplied stable id is preserved.
    expect(events[2].id).toBe("refinement-1");
    // Blob referenced from the envelope resolves back to the original text.
    const first = events[0];
    expect(first.kind).toBe("turn-envelope");
    if (first.kind === "turn-envelope") {
      expect(await journal.blobs.getText(first.data.systemPromptHash)).toBe(
        "You are a helpful agent."
      );
    }
  });

  test("rejects drafts violating kind-specific invariants", async () => {
    using tmp = new DisposableTempDir("durable-journal-test");
    const journal = new DurableEventJournal(tmp.path);
    // hook-context requires exactly one of text/blobHash.
    try {
      await journal.append({
        workspaceId: "ws-1",
        kind: "hook-context",
        data: {
          hookId: "plugin:demo",
          placement: "system-prompt",
          text: "both",
          blobHash: `sha256:${"0".repeat(64)}`,
        },
      });
      expect.unreachable("Should have thrown");
    } catch (e) {
      expect(String(e)).toContain("failed schema validation");
    }
  });

  test("interleaved writers through the shared registry keep seq strictly increasing", async () => {
    using tmp = new DisposableTempDir("shared-journal");
    // Two producers (turn envelopes + sandbox snapshots) obtaining the journal
    // independently for the same session dir must share one seq counter.
    const writerA = sharedDurableEventJournal(tmp.path);
    const writerB = sharedDurableEventJournal(tmp.path);
    expect(writerB).toBe(writerA);

    const draft = (text: string) =>
      ({
        workspaceId: "ws",
        kind: "hook-context",
        data: { hookId: "plugin:demo", placement: "system-prompt", text },
      }) as const;
    await writerA.append(draft("a1"));
    await writerB.append(draft("b1"));
    await writerA.append(draft("a2"));

    const rows = await writerA.read();
    expect(rows.map((row) => row.seq)).toEqual([0, 1, 2]);
  });
});
