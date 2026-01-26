import { describe, expect, it } from "bun:test";

import {
  classifyBashIntent,
  decideBashOutputCompaction,
  isBashOutputAlreadyTargeted,
} from "./bashCompactionPolicy";

describe("bashCompactionPolicy", () => {
  describe("isBashOutputAlreadyTargeted", () => {
    it("detects common output-slicing commands", () => {
      expect(isBashOutputAlreadyTargeted("rg foo . | head -n 50")).toBe(true);
      expect(isBashOutputAlreadyTargeted("tail -n 100 some.log")).toBe(true);
      expect(isBashOutputAlreadyTargeted("sed -n '1,200p' file.txt")).toBe(true);
      expect(isBashOutputAlreadyTargeted("awk 'NR>=10 && NR<=20 {print}' file.txt")).toBe(true);
    });

    it("returns false for non-targeted scripts", () => {
      expect(isBashOutputAlreadyTargeted("ls -la")).toBe(false);
      expect(isBashOutputAlreadyTargeted("rg foo .")).toBe(false);
    });
  });

  describe("classifyBashIntent", () => {
    it("classifies exploration via display name keywords", () => {
      expect(classifyBashIntent({ script: "echo hi", displayName: "List files" })).toBe(
        "exploration"
      );
      expect(classifyBashIntent({ script: "echo hi", displayName: "Search repo" })).toBe(
        "exploration"
      );
    });

    it("classifies exploration via common commands", () => {
      expect(classifyBashIntent({ script: "ls -la" })).toBe("exploration");
      expect(classifyBashIntent({ script: "git status --porcelain" })).toBe("exploration");
      expect(classifyBashIntent({ script: "find . -maxdepth 2 -type f" })).toBe("exploration");
    });

    it("classifies logs for build/test commands", () => {
      expect(classifyBashIntent({ script: "make test" })).toBe("logs");
      expect(classifyBashIntent({ script: "bun test" })).toBe("logs");
    });
  });

  describe("decideBashOutputCompaction", () => {
    it("skips when output is below configured thresholds", () => {
      const decision = decideBashOutputCompaction({
        toolName: "bash",
        script: "ls",
        totalLines: 5,
        totalBytes: 1_000,
        minLines: 10,
        minTotalBytes: 4 * 1024,
        maxKeptLines: 40,
      });

      expect(decision.shouldCompact).toBe(false);
      expect(decision.skipReason).toBe("below_threshold");
      expect(decision.triggeredByLines).toBe(false);
      expect(decision.triggeredByBytes).toBe(false);
    });

    it("skips compaction for already-targeted scripts", () => {
      const decision = decideBashOutputCompaction({
        toolName: "bash",
        script: "rg foo . | head -n 50",
        totalLines: 200,
        totalBytes: 10_000,
        minLines: 10,
        minTotalBytes: 4 * 1024,
        maxKeptLines: 40,
      });

      expect(decision.shouldCompact).toBe(false);
      expect(decision.skipReason).toBe("already_targeted_script");
    });

    it("skips compaction for small exploration output", () => {
      const decision = decideBashOutputCompaction({
        toolName: "bash",
        script: "ls",
        totalLines: 50,
        totalBytes: 8_000,
        minLines: 10,
        minTotalBytes: 4 * 1024,
        maxKeptLines: 40,
      });

      expect(decision.intent).toBe("exploration");
      expect(decision.shouldCompact).toBe(false);
      expect(decision.skipReason).toBe("exploration_output_small");
    });

    it("respects user maxKeptLines for small exploration output", () => {
      const decision = decideBashOutputCompaction({
        toolName: "bash",
        script: "ls",
        totalLines: 50,
        totalBytes: 8_000,
        minLines: 10,
        minTotalBytes: 4 * 1024,
        maxKeptLines: 20,
      });

      expect(decision.intent).toBe("exploration");
      expect(decision.shouldCompact).toBe(true);
      expect(decision.skipReason).toBeUndefined();
      expect(decision.effectiveMaxKeptLines).toBe(20);
    });

    it("respects user thresholds for small exploration output", () => {
      const decision = decideBashOutputCompaction({
        toolName: "bash",
        script: "ls",
        totalLines: 50,
        totalBytes: 8_000,
        minLines: 0,
        minTotalBytes: 4 * 1024,
        maxKeptLines: 40,
      });

      expect(decision.intent).toBe("exploration");
      expect(decision.shouldCompact).toBe(true);
      expect(decision.skipReason).toBeUndefined();
      expect(decision.effectiveMaxKeptLines).toBe(40);
    });

    it("does not boost maxKeptLines when thresholds are user-set", () => {
      const decision = decideBashOutputCompaction({
        toolName: "bash",
        script: "find . -type f",
        totalLines: 200,
        totalBytes: 14_000,
        minLines: 0,
        minTotalBytes: 4 * 1024,
        maxKeptLines: 40,
      });

      expect(decision.intent).toBe("exploration");
      expect(decision.shouldCompact).toBe(true);
      expect(decision.skipReason).toBeUndefined();
      expect(decision.effectiveMaxKeptLines).toBe(40);
    });

    it("boosts maxKeptLines for large exploration output when using the default budget", () => {
      const decision = decideBashOutputCompaction({
        toolName: "bash",
        script: "find . -type f",
        totalLines: 200,
        totalBytes: 14_000,
        minLines: 10,
        minTotalBytes: 4 * 1024,
        maxKeptLines: 40,
      });

      expect(decision.intent).toBe("exploration");
      expect(decision.shouldCompact).toBe(true);
      expect(decision.effectiveMaxKeptLines).toBe(120);
    });

    it("keeps default behavior for logs", () => {
      const decision = decideBashOutputCompaction({
        toolName: "bash",
        script: "make test",
        totalLines: 200,
        totalBytes: 14_000,
        minLines: 10,
        minTotalBytes: 4 * 1024,
        maxKeptLines: 40,
      });

      expect(decision.intent).toBe("logs");
      expect(decision.shouldCompact).toBe(true);
      expect(decision.effectiveMaxKeptLines).toBe(40);
    });
  });
});
