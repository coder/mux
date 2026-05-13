import { describe, it, expect } from "bun:test";
import { stripMonitorWakeXml } from "./monitorWake";

describe("stripMonitorWakeXml", () => {
  it("returns the input unchanged when no monitor block is present", () => {
    const input = "Hello there\n<other>tag</other>";
    expect(stripMonitorWakeXml(input)).toBe(input);
  });

  it("removes a lone monitor wake block and trims whitespace", () => {
    const raw =
      '<monitor-event taskId="bash:1" total_matches="1"><line>FAIL boot</line></monitor-event>';
    expect(stripMonitorWakeXml(raw)).toBe("");
  });

  it("preserves surrounding user text alongside extracted blocks", () => {
    const raw = [
      "Please investigate this:",
      '<monitor-event taskId="bash:1" total_matches="1"><line>FAIL boot</line></monitor-event>',
    ].join("\n");
    expect(stripMonitorWakeXml(raw)).toBe("Please investigate this:");
  });

  it("handles batched monitor blocks", () => {
    const raw = [
      "first",
      '<monitor-event taskId="bash:1" total_matches="1"><line>a</line></monitor-event>',
      '<monitor-event taskId="bash:2" total_matches="1"><line>b</line></monitor-event>',
      "second",
    ].join("\n");
    expect(stripMonitorWakeXml(raw)).toBe("first\n\nsecond");
  });
});
