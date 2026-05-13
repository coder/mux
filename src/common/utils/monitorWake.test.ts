import { describe, it, expect } from "bun:test";
import { stripMonitorWakeXml } from "./monitorWake";

describe("stripMonitorWakeXml", () => {
  it("returns the input unchanged when no monitor block is present", () => {
    const input = "Hello there\n<other>tag</other>";
    expect(stripMonitorWakeXml(input)).toBe(input);
  });

  it("removes a lone monitor wake block and trims whitespace", () => {
    const raw =
      '<monitor-event source="mux" taskId="bash:1" total_matches="1"><line>FAIL boot</line></monitor-event>';
    expect(stripMonitorWakeXml(raw)).toBe("");
  });

  it("preserves surrounding user text alongside extracted blocks", () => {
    const raw = [
      "Please investigate this:",
      '<monitor-event source="mux" taskId="bash:1" total_matches="1"><line>FAIL boot</line></monitor-event>',
    ].join("\n");
    expect(stripMonitorWakeXml(raw)).toBe("Please investigate this:");
  });

  it("handles batched monitor blocks", () => {
    const raw = [
      "first",
      '<monitor-event source="mux" taskId="bash:1" total_matches="1"><line>a</line></monitor-event>',
      '<monitor-event source="mux" taskId="bash:2" total_matches="1"><line>b</line></monitor-event>',
      "second",
    ].join("\n");
    expect(stripMonitorWakeXml(raw)).toBe("first\n\nsecond");
  });

  it("preserves user-authored monitor-shaped XML without the backend sentinel", () => {
    // Regression: when a real backend wake (sentinel-bearing) is appended to a queue that
    // already contains user-pasted XML that *looks* like a monitor event, only the synthetic
    // block must be stripped; the user's verbatim block stays.
    const userPasted =
      '<monitor-event taskId="bash:user" total_matches="9"><line>user copy</line></monitor-event>';
    const backendWake =
      '<monitor-event source="mux" taskId="bash:1" total_matches="1"><line>real wake</line></monitor-event>';
    const raw = `${userPasted}\n${backendWake}`;
    expect(stripMonitorWakeXml(raw)).toBe(userPasted);
  });

  it("returns the input unchanged when only sentinel-less blocks are present", () => {
    const userPasted =
      '<monitor-event taskId="bash:user" total_matches="9"><line>user copy</line></monitor-event>';
    expect(stripMonitorWakeXml(userPasted)).toBe(userPasted);
  });
});
