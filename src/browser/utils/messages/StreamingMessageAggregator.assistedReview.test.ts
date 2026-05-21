/**
 * Tests for `review_pane_update` -> assistedReviewHunks bookkeeping.
 *
 * These cover the new metadata bits added when implementing the assisted-review
 * UX fixes:
 *   - sourceMessageId: the assistant turn id is recorded with each pin so the
 *     UI can offer a "jump to source turn" affordance.
 *   - addedAt: set on first sight of each pin's path[:range] key during a
 *     live update, used to drive the transient "new" badge. Replay
 *     intentionally skips this so historical pins don't flash as "new" on
 *     initial load.
 *   - Carryover: re-flagging an existing key (typical with `operation: "add"`
 *     when an agent refines a comment) preserves the original metadata so a
 *     refined comment does not make the pin look brand-new.
 */

import { describe, test, expect } from "bun:test";
import { createMuxMessage } from "@/common/types/message";
import { StreamingMessageAggregator } from "./StreamingMessageAggregator";

const TEST_CREATED_AT = "2024-01-01T00:00:00.000Z";
const TEST_MODEL = "openai:gpt-4o-mini";

function historicalReviewPaneUpdateMessage(
  id: string,
  hunks: Array<{ path: string; comment?: string | null }>,
  operation: "add" | "replace" = "replace",
  options: { historySequence?: number; toolCallId?: string } = {}
) {
  const message = createMuxMessage(id, "assistant", "", {
    historySequence: options.historySequence ?? 1,
    timestamp: Date.now(),
    muxMetadata: { type: "normal", requestedModel: TEST_MODEL },
  });
  message.parts.push({
    type: "dynamic-tool",
    toolCallId: options.toolCallId ?? `tc-${id}`,
    toolName: "review_pane_update",
    state: "output-available",
    input: { operation, hunks: hunks.map((h) => ({ path: h.path })) },
    output: { success: true, operation, hunks },
  });
  return message;
}

describe("review_pane_update -> assistedReviewHunks", () => {
  test("replay tags pins with sourceMessageId but skips addedAt", () => {
    // Initial-load case: we never want replayed history to light up the
    // transient "new" badge. The aggregator deliberately omits the timestamp
    // on replay, so addedAt stays undefined while sourceMessageId is set.
    const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);
    aggregator.loadHistoricalMessages([
      historicalReviewPaneUpdateMessage("assistant-1", [
        { path: "src/foo.ts:10-12", comment: "double-check" },
        { path: "src/bar.ts", comment: null },
      ]),
    ]);

    const pins = aggregator.getAssistedReviewHunks();
    expect(pins).toHaveLength(2);
    expect(pins[0].path).toBe("src/foo.ts");
    expect(pins[0].sourceMessageId).toBe("assistant-1");
    expect(pins[0].addedAt).toBeUndefined();

    expect(pins[1].path).toBe("src/bar.ts");
    expect(pins[1].sourceMessageId).toBe("assistant-1");
    expect(pins[1].addedAt).toBeUndefined();
  });

  test("carryover: re-flagging an existing path:range preserves sourceMessageId", () => {
    const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);
    aggregator.loadHistoricalMessages([
      historicalReviewPaneUpdateMessage(
        "assistant-1",
        [{ path: "src/foo.ts:10-12", comment: "look at parser" }],
        "replace",
        { historySequence: 1 }
      ),
      historicalReviewPaneUpdateMessage(
        "assistant-2",
        [{ path: "src/foo.ts:10-12", comment: "look at parser (revised)" }],
        "add",
        { historySequence: 2, toolCallId: "tc-2" }
      ),
    ]);

    const refreshed = aggregator.getAssistedReviewHunks();
    expect(refreshed).toHaveLength(1);
    // Carry-over: sourceMessageId sticks to the first turn that introduced
    // this path:range key so "jump to source" still points at the original
    // rationale, even after an `add` refined the comment.
    expect(refreshed[0].sourceMessageId).toBe("assistant-1");
    // But the refined comment wins, mirroring the tool's last-writer-wins
    // behavior on duplicate keys.
    expect(refreshed[0].comment).toBe("look at parser (revised)");
  });

  test("brand-new pins during a later turn get that turn's sourceMessageId", () => {
    const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);
    aggregator.loadHistoricalMessages([
      historicalReviewPaneUpdateMessage(
        "assistant-1",
        [{ path: "src/foo.ts", comment: null }],
        "replace",
        { historySequence: 1 }
      ),
      historicalReviewPaneUpdateMessage(
        "assistant-2",
        [
          { path: "src/foo.ts", comment: null }, // existing — carryover
          { path: "src/baz.ts:5", comment: "new turn introduced this" },
        ],
        "add",
        { historySequence: 2, toolCallId: "tc-2" }
      ),
    ]);

    const pins = aggregator.getAssistedReviewHunks();
    expect(pins).toHaveLength(2);
    const foo = pins.find((p) => p.path === "src/foo.ts");
    const baz = pins.find((p) => p.path === "src/baz.ts");
    expect(foo?.sourceMessageId).toBe("assistant-1");
    expect(baz?.sourceMessageId).toBe("assistant-2");
  });

  test("a `replace` with a fresh key drops sourceMessageId of dropped entries", () => {
    // Sanity check: when the agent replaces the set, dropped keys vanish.
    // We don't carry forward sourceMessageId for entries that the replace
    // didn't reinclude.
    const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);
    aggregator.loadHistoricalMessages([
      historicalReviewPaneUpdateMessage(
        "assistant-1",
        [{ path: "src/foo.ts", comment: null }],
        "replace",
        { historySequence: 1 }
      ),
      historicalReviewPaneUpdateMessage(
        "assistant-2",
        [{ path: "src/bar.ts", comment: null }],
        "replace",
        { historySequence: 2, toolCallId: "tc-2" }
      ),
    ]);

    const pins = aggregator.getAssistedReviewHunks();
    expect(pins).toHaveLength(1);
    expect(pins[0].path).toBe("src/bar.ts");
    expect(pins[0].sourceMessageId).toBe("assistant-2");
  });
});
