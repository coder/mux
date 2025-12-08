import { StreamingMessageAggregator } from "./StreamingMessageAggregator";

interface InitDisplayedMessage {
  type: "workspace-init";
  status: "running" | "success" | "error";
  lines: string[];
  exitCode: number | null;
}

describe("Init display after cleanup changes", () => {
  it("should display init messages correctly", () => {
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

    messages = aggregator.getDisplayedMessages();
    expect(messages).toHaveLength(1);
    expect((messages[0] as InitDisplayedMessage).lines).toContain("Installing dependencies...");

    // Simulate init end
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
});
