import { describe, it, expect } from "bun:test";
import { StreamingMessageAggregator } from "./StreamingMessageAggregator";
import { INIT_HOOK_MAX_LINES } from "@/common/constants/toolLimits";

interface InitDisplayedMessage {
  type: "workspace-init";
  status: "running" | "success" | "error";
  lines: string[];
  exitCode: number | null;
  truncatedLines?: number;
}

// Helper to wait for throttled init output updates (100ms throttle + buffer)
const waitForInitThrottle = () => new Promise((r) => setTimeout(r, 120));

describe("Init display after cleanup changes", () => {
  it("should display init messages correctly", async () => {
    const aggregator = new StreamingMessageAggregator("2024-01-01T00:00:00.000Z");

    // Simulate init start
    aggregator.handleMessage({
      type: "init-start",
      hookPath: "/test/.mux/init",
      timestamp: Date.now(),
    });

    let messages = aggregator.getDisplayedMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0].type).toBe("workspace-init");
    expect((messages[0] as InitDisplayedMessage).status).toBe("running");

    // Simulate init output
    aggregator.handleMessage({
      type: "init-output",
      line: "Installing dependencies...",
      timestamp: Date.now(),
      isError: false,
    });

    // Wait for throttled cache invalidation
    await waitForInitThrottle();

    messages = aggregator.getDisplayedMessages();
    expect(messages).toHaveLength(1);
    expect((messages[0] as InitDisplayedMessage).lines).toContain("Installing dependencies...");

    // Simulate init end (flushes immediately)
    aggregator.handleMessage({
      type: "init-end",
      exitCode: 0,
      timestamp: Date.now(),
    });

    messages = aggregator.getDisplayedMessages();
    expect(messages).toHaveLength(1);
    expect((messages[0] as InitDisplayedMessage).status).toBe("success");
    expect((messages[0] as InitDisplayedMessage).exitCode).toBe(0);
  });

  it("should handle init-output without init-start (defensive)", () => {
    const aggregator = new StreamingMessageAggregator("2024-01-01T00:00:00.000Z");

    // This might crash with non-null assertion if initState is null
    expect(() => {
      aggregator.handleMessage({
        type: "init-output",
        line: "Some output",
        timestamp: Date.now(),
        isError: false,
      });
    }).not.toThrow();
  });

  it("should handle init-end without init-start (defensive)", () => {
    const aggregator = new StreamingMessageAggregator("2024-01-01T00:00:00.000Z");

    expect(() => {
      aggregator.handleMessage({
        type: "init-end",
        exitCode: 0,
        timestamp: Date.now(),
      });
    }).not.toThrow();
  });

  it("should truncate lines and track truncatedLines when exceeding limit", async () => {
    const aggregator = new StreamingMessageAggregator("2024-01-01T00:00:00.000Z");

    aggregator.handleMessage({
      type: "init-start",
      hookPath: "/test/.mux/init",
      timestamp: Date.now(),
    });

    // Add more lines than the limit
    const totalLines = INIT_HOOK_MAX_LINES + 50;
    for (let i = 0; i < totalLines; i++) {
      aggregator.handleMessage({
        type: "init-output",
        line: `Line ${i}`,
        timestamp: Date.now(),
        isError: false,
      });
    }

    // Wait for throttled cache invalidation
    await waitForInitThrottle();

    const messages = aggregator.getDisplayedMessages();
    const initMsg = messages[0] as InitDisplayedMessage;

    expect(initMsg.lines.length).toBe(INIT_HOOK_MAX_LINES);
    expect(initMsg.truncatedLines).toBe(50);

    // Should have the most recent lines (tail)
    expect(initMsg.lines[INIT_HOOK_MAX_LINES - 1]).toBe(`Line ${totalLines - 1}`);
    // First line should be from when truncation started
    expect(initMsg.lines[0]).toBe("Line 50");
  });

  it("should capture truncatedLines from init-end event", () => {
    const aggregator = new StreamingMessageAggregator("2024-01-01T00:00:00.000Z");

    aggregator.handleMessage({
      type: "init-start",
      hookPath: "/test/.mux/init",
      timestamp: Date.now(),
    });

    // Add just a few lines (no frontend truncation)
    aggregator.handleMessage({
      type: "init-output",
      line: "Line 1",
      timestamp: Date.now(),
      isError: false,
    });

    // Simulate init-end with truncatedLines (from backend replay)
    aggregator.handleMessage({
      type: "init-end",
      exitCode: 0,
      timestamp: Date.now(),
      truncatedLines: 1000, // Backend truncated 1000 lines
    });

    const messages = aggregator.getDisplayedMessages();
    const initMsg = messages[0] as InitDisplayedMessage;

    expect(initMsg.truncatedLines).toBe(1000);
  });
});
