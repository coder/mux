import { describe, expect, it } from "bun:test";

import { createMuxMessage } from "@/common/types/message";

import {
  findLatestCompactionBoundaryIndex,
  sliceMessagesFromLatestCompactionBoundary,
} from "./compactionBoundary";

describe("findLatestCompactionBoundaryIndex", () => {
  it("returns the newest compaction boundary via reverse scan", () => {
    const messages = [
      createMuxMessage("u0", "user", "before"),
      createMuxMessage("summary-1", "assistant", "first summary", {
        compacted: "user",
        compactionBoundary: true,
        compactionEpoch: 1,
      }),
      createMuxMessage("u1", "user", "middle"),
      createMuxMessage("summary-2", "assistant", "second summary", {
        compacted: "user",
        compactionBoundary: true,
        compactionEpoch: 2,
      }),
      createMuxMessage("u2", "user", "latest"),
    ];

    expect(findLatestCompactionBoundaryIndex(messages)).toBe(3);
  });

  it("returns -1 when only legacy compacted summaries exist", () => {
    const messages = [
      createMuxMessage("u0", "user", "before"),
      createMuxMessage("legacy-summary", "assistant", "legacy summary", {
        compacted: "user",
      }),
      createMuxMessage("u1", "user", "after"),
    ];

    expect(findLatestCompactionBoundaryIndex(messages)).toBe(-1);
  });
});

describe("sliceMessagesFromLatestCompactionBoundary", () => {
  it("slices request payload history from the latest compaction boundary", () => {
    const messages = [
      createMuxMessage("u0", "user", "before"),
      createMuxMessage("summary-1", "assistant", "first summary", {
        compacted: "user",
        compactionBoundary: true,
        compactionEpoch: 1,
      }),
      createMuxMessage("u1", "user", "middle"),
      createMuxMessage("summary-2", "assistant", "second summary", {
        compacted: "user",
        compactionBoundary: true,
        compactionEpoch: 2,
      }),
      createMuxMessage("u2", "user", "latest"),
      createMuxMessage("a2", "assistant", "reply"),
    ];

    const sliced = sliceMessagesFromLatestCompactionBoundary(messages);

    expect(sliced.map((msg) => msg.id)).toEqual(["summary-2", "u2", "a2"]);
    expect(sliced[0]?.metadata?.compactionBoundary).toBe(true);
  });

  it("falls back to full history when no durable boundary exists", () => {
    const messages = [
      createMuxMessage("u0", "user", "before"),
      createMuxMessage("legacy-summary", "assistant", "legacy summary", {
        compacted: "user",
      }),
      createMuxMessage("u1", "user", "after"),
    ];

    const sliced = sliceMessagesFromLatestCompactionBoundary(messages);

    expect(sliced).toBe(messages);
    expect(sliced.map((msg) => msg.id)).toEqual(["u0", "legacy-summary", "u1"]);
  });
});
