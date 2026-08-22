import { computeRecencyTimestamp } from "./recency";
import { createXumMessage } from "@/common/types/message";

describe("computeRecencyTimestamp", () => {
  it("returns null for empty messages array", () => {
    expect(computeRecencyTimestamp([])).toBeNull();
  });

  it("returns null when no messages have timestamps", () => {
    const messages = [
      createXumMessage("1", "user", "hello"),
      createXumMessage("2", "assistant", "hi"),
    ];
    expect(computeRecencyTimestamp(messages)).toBeNull();
  });

  it("returns last user message timestamp", () => {
    const messages = [
      createXumMessage("1", "user", "first", { timestamp: 100 }),
      createXumMessage("2", "assistant", "reply", { timestamp: 200 }),
      createXumMessage("3", "user", "second", { timestamp: 300 }),
    ];
    expect(computeRecencyTimestamp(messages)).toBe(300);
  });

  it("returns max of user message and compacted message timestamps", () => {
    const messages = [
      createXumMessage("1", "user", "user msg", { timestamp: 100 }),
      createXumMessage("2", "assistant", "compacted", {
        timestamp: 200,
        compacted: true,
      }),
    ];
    // Now uses max() instead of priority order
    expect(computeRecencyTimestamp(messages)).toBe(200);
  });

  it("falls back to compacted message when no user messages", () => {
    const messages = [
      createXumMessage("1", "assistant", "response"),
      createXumMessage("2", "assistant", "compacted summary", {
        timestamp: 150,
        compacted: true,
      }),
    ];
    expect(computeRecencyTimestamp(messages)).toBe(150);
  });

  it("uses most recent user message when multiple exist", () => {
    const messages = [
      createXumMessage("1", "user", "old", { timestamp: 100 }),
      createXumMessage("2", "user", "middle", { timestamp: 200 }),
      createXumMessage("3", "assistant", "reply"),
      createXumMessage("4", "user", "newest", { timestamp: 300 }),
    ];
    expect(computeRecencyTimestamp(messages)).toBe(300);
  });

  it("uses most recent compacted message as fallback", () => {
    const messages = [
      createXumMessage("1", "assistant", "old summary", {
        timestamp: 100,
        compacted: true,
      }),
      createXumMessage("2", "assistant", "response"),
      createXumMessage("3", "assistant", "newer summary", {
        timestamp: 200,
        compacted: true,
      }),
    ];
    expect(computeRecencyTimestamp(messages)).toBe(200);
  });

  it("handles messages with metadata but no timestamp", () => {
    const messages = [
      createXumMessage("1", "user", "hello", { model: "claude" }),
      createXumMessage("2", "assistant", "hi", { duration: 100 }),
    ];
    expect(computeRecencyTimestamp(messages)).toBeNull();
  });

  it("ignores assistant messages without compacted flag", () => {
    const messages = [
      createXumMessage("1", "assistant", "regular", { timestamp: 100 }),
      createXumMessage("2", "assistant", "another", { timestamp: 200 }),
    ];
    expect(computeRecencyTimestamp(messages)).toBeNull();
  });

  it("handles mixed messages with only some having timestamps", () => {
    const messages = [
      createXumMessage("1", "user", "no timestamp"),
      createXumMessage("2", "user", "has timestamp", { timestamp: 150 }),
      createXumMessage("3", "user", "no timestamp again"),
    ];
    expect(computeRecencyTimestamp(messages)).toBe(150);
  });

  it("handles user messages in middle of array", () => {
    const messages = [
      createXumMessage("1", "assistant", "start"),
      createXumMessage("2", "user", "middle", { timestamp: 250 }),
      createXumMessage("3", "assistant", "end"),
    ];
    expect(computeRecencyTimestamp(messages)).toBe(250);
  });

  describe("compaction semantics", () => {
    it("manual compaction summary bumps recency", () => {
      const now = Date.now();
      const messages = [
        createXumMessage("1", "assistant", "summary", { compacted: "user", timestamp: now }),
      ];

      const result = computeRecencyTimestamp(messages);
      expect(result).toBe(now);
    });

    it("idle compaction request user message is ignored", () => {
      const messages = [
        createXumMessage("1", "user", "compact", {
          timestamp: 2000,
          muxMetadata: {
            type: "compaction-request",
            rawCommand: "/compact",
            parsed: {},
            source: "idle-compaction",
          },
        }),
      ];

      const result = computeRecencyTimestamp(messages);
      expect(result).toBeNull();
    });

    it("idle compacted summary timestamp governs recency (backdated)", () => {
      const requestTime = Date.now();
      const backdatedTime = requestTime - 60000;
      const messages = [
        createXumMessage("idle-req", "user", "compact", {
          timestamp: requestTime,
          muxMetadata: {
            type: "compaction-request",
            rawCommand: "/compact",
            parsed: {},
            source: "idle-compaction",
          },
        }),
        createXumMessage("idle-summary", "assistant", "Summary", {
          compacted: "idle",
          timestamp: backdatedTime,
        }),
      ];

      const result = computeRecencyTimestamp(messages);
      expect(result).toBe(backdatedTime);
    });

    it("manual compaction request user message does bump recency", () => {
      const messages = [
        createXumMessage("1", "user", "/compact", {
          timestamp: 3000,
          muxMetadata: {
            type: "compaction-request",
            rawCommand: "/compact",
            parsed: {},
          },
        }),
      ];

      const result = computeRecencyTimestamp(messages);
      expect(result).toBe(3000);
    });
  });

  // Tests for createdAt parameter
  describe("with createdAt parameter", () => {
    it("returns createdAt timestamp when no messages exist", () => {
      const createdAt = "2024-01-15T10:30:00.000Z";
      const expectedTimestamp = new Date(createdAt).getTime();
      expect(computeRecencyTimestamp([], createdAt)).toBe(expectedTimestamp);
    });

    it("returns max of createdAt and user message timestamp", () => {
      const createdAt = "2024-01-15T10:30:00.000Z"; // 1705316400000
      const createdTimestamp = new Date(createdAt).getTime();

      // Old message (before workspace created)
      const messages = [
        createXumMessage("1", "user", "old message", { timestamp: createdTimestamp - 1000 }),
      ];
      expect(computeRecencyTimestamp(messages, createdAt)).toBe(createdTimestamp);
    });

    it("returns user message timestamp when newer than createdAt", () => {
      const createdAt = "2024-01-15T10:30:00.000Z";
      const createdTimestamp = new Date(createdAt).getTime();

      // New message (after workspace created)
      const messages = [
        createXumMessage("1", "user", "new message", { timestamp: createdTimestamp + 5000 }),
      ];
      expect(computeRecencyTimestamp(messages, createdAt)).toBe(createdTimestamp + 5000);
    });

    it("returns max of createdAt, user message, and compacted message", () => {
      const createdAt = "2024-01-15T10:30:00.000Z";
      const createdTimestamp = new Date(createdAt).getTime();

      const messages = [
        createXumMessage("1", "user", "old user", { timestamp: createdTimestamp - 5000 }),
        createXumMessage("2", "assistant", "old compacted", {
          timestamp: createdTimestamp - 2000,
          compacted: true,
        }),
      ];

      // createdAt is newest
      expect(computeRecencyTimestamp(messages, createdAt)).toBe(createdTimestamp);
    });

    it("uses user message when it's the maximum", () => {
      const createdAt = "2024-01-15T10:30:00.000Z";
      const createdTimestamp = new Date(createdAt).getTime();

      const messages = [
        createXumMessage("1", "user", "newest", { timestamp: createdTimestamp + 10000 }),
        createXumMessage("2", "assistant", "compacted", {
          timestamp: createdTimestamp + 5000,
          compacted: true,
        }),
      ];

      // User message is newest
      expect(computeRecencyTimestamp(messages, createdAt)).toBe(createdTimestamp + 10000);
    });

    it("handles invalid createdAt gracefully", () => {
      const messages = [createXumMessage("1", "user", "msg", { timestamp: 100 })];

      // Invalid ISO string should result in NaN timestamp, which gets filtered out
      expect(computeRecencyTimestamp(messages, "invalid-date")).toBe(100);
    });

    it("returns null when no messages and no valid createdAt", () => {
      expect(computeRecencyTimestamp([])).toBeNull();
      expect(computeRecencyTimestamp([], undefined)).toBeNull();
    });
  });

  // Tests for idle compaction request filtering
  describe("with idle compaction requests", () => {
    it("excludes idle compaction request messages from recency", () => {
      const messages = [
        createXumMessage("1", "user", "normal message", { timestamp: 100 }),
        createXumMessage("2", "assistant", "reply", { timestamp: 150 }),
        createXumMessage("3", "user", "compaction request", {
          timestamp: 300,
          muxMetadata: {
            type: "compaction-request",
            rawCommand: "/compact",
            parsed: {},
            source: "idle-compaction",
          },
        }),
      ];
      // Should use timestamp 100 (normal user message), not 300 (idle compaction)
      expect(computeRecencyTimestamp(messages)).toBe(100);
    });

    it("includes user-initiated compaction requests in recency", () => {
      const messages = [
        createXumMessage("1", "user", "normal message", { timestamp: 100 }),
        createXumMessage("2", "user", "compaction request", {
          timestamp: 300,
          muxMetadata: { type: "compaction-request", rawCommand: "/compact", parsed: {} },
        }),
      ];
      // Should use timestamp 300 (user-initiated compaction request)
      expect(computeRecencyTimestamp(messages)).toBe(300);
    });

    it("falls back to createdAt when only idle compaction requests exist", () => {
      const createdAt = "2024-01-15T10:30:00.000Z";
      const createdTimestamp = new Date(createdAt).getTime();

      const messages = [
        createXumMessage("1", "user", "idle compaction", {
          timestamp: createdTimestamp + 10000,
          muxMetadata: {
            type: "compaction-request",
            rawCommand: "/compact",
            parsed: {},
            source: "idle-compaction",
          },
        }),
      ];
      // Should fall back to createdAt since the only user message is idle compaction
      expect(computeRecencyTimestamp(messages, createdAt)).toBe(createdTimestamp);
    });
  });
});
