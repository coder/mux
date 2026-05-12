import { describe, it, expect } from "bun:test";
import { extractMonitorWakeEvents } from "./MonitorWakeMessage";

describe("extractMonitorWakeEvents", () => {
  it("parses a basic monitor-event payload", () => {
    const raw = [
      '<monitor-event taskId="bash:abc" total_matches="3">',
      "<!-- 1 new matching line -->",
      "<line>ERR boom</line>",
      "</monitor-event>",
    ].join("\n");

    expect(extractMonitorWakeEvents(raw)).toEqual({
      events: [
        {
          taskId: "bash:abc",
          totalMatches: 3,
          lines: ["ERR boom"],
        },
      ],
      remainingContent: "",
    });
  });

  it("captures optional display_name and dropped_lines", () => {
    const raw = [
      '<monitor-event taskId="bash:abc" display_name="Dev Server" total_matches="7" dropped_lines="2">',
      "<line>match one</line>",
      "<line>match two</line>",
      "</monitor-event>",
    ].join("\n");

    expect(extractMonitorWakeEvents(raw)).toEqual({
      events: [
        {
          taskId: "bash:abc",
          displayName: "Dev Server",
          totalMatches: 7,
          droppedLines: 2,
          lines: ["match one", "match two"],
        },
      ],
      remainingContent: "",
    });
  });

  it("unescapes XML entities in attributes and lines", () => {
    const raw =
      '<monitor-event taskId="bash:1" display_name="A &amp; B" total_matches="1"><line>5 &lt; 6 &amp;&amp; ok</line></monitor-event>';

    expect(extractMonitorWakeEvents(raw)).toEqual({
      events: [
        {
          taskId: "bash:1",
          displayName: "A & B",
          totalMatches: 1,
          lines: ["5 < 6 && ok"],
        },
      ],
      remainingContent: "",
    });
  });

  it("returns one entry per batched monitor-event block", () => {
    const raw = [
      '<monitor-event taskId="bash:1" display_name="Server" total_matches="1">',
      "<line>boot ready</line>",
      "</monitor-event>",
      '<monitor-event taskId="bash:2" display_name="Tests" total_matches="2">',
      "<line>FAIL one</line>",
      "<line>FAIL two</line>",
      "</monitor-event>",
    ].join("\n");

    expect(extractMonitorWakeEvents(raw)).toEqual({
      events: [
        {
          taskId: "bash:1",
          displayName: "Server",
          totalMatches: 1,
          lines: ["boot ready"],
        },
        {
          taskId: "bash:2",
          displayName: "Tests",
          totalMatches: 2,
          lines: ["FAIL one", "FAIL two"],
        },
      ],
      remainingContent: "",
    });
  });

  it("preserves non-monitor user text alongside extracted events", () => {
    const raw = [
      "Please investigate this:",
      '<monitor-event taskId="bash:1" total_matches="1"><line>FAIL boot</line></monitor-event>',
    ].join("\n");

    expect(extractMonitorWakeEvents(raw)).toEqual({
      events: [
        {
          taskId: "bash:1",
          totalMatches: 1,
          lines: ["FAIL boot"],
        },
      ],
      remainingContent: "Please investigate this:",
    });
  });

  it("returns null when no monitor block is present", () => {
    expect(extractMonitorWakeEvents("hello world")).toBeNull();
    expect(
      extractMonitorWakeEvents("<local-command-stdout>nope</local-command-stdout>")
    ).toBeNull();
    expect(extractMonitorWakeEvents('<monitor-event taskId="bash:1">')).toBeNull();
  });
});
