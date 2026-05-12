import { describe, it, expect } from "bun:test";
import { parseMonitorWakeMessage } from "./MonitorWakeMessage";

describe("parseMonitorWakeMessage", () => {
  it("parses a basic monitor-event payload", () => {
    const raw = [
      '<monitor-event taskId="bash:abc" total_matches="3">',
      "<!-- 1 new matching line -->",
      "<line>ERR boom</line>",
      "</monitor-event>",
    ].join("\n");

    const event = parseMonitorWakeMessage(raw);
    expect(event).toEqual({
      taskId: "bash:abc",
      totalMatches: 3,
      lines: ["ERR boom"],
    });
  });

  it("captures optional display_name and dropped_lines", () => {
    const raw = [
      '<monitor-event taskId="bash:abc" display_name="Dev Server" total_matches="7" dropped_lines="2">',
      "<line>match one</line>",
      "<line>match two</line>",
      "</monitor-event>",
    ].join("\n");

    const event = parseMonitorWakeMessage(raw);
    expect(event).toEqual({
      taskId: "bash:abc",
      displayName: "Dev Server",
      totalMatches: 7,
      droppedLines: 2,
      lines: ["match one", "match two"],
    });
  });

  it("unescapes XML entities in attributes and lines", () => {
    const raw =
      '<monitor-event taskId="bash:1" display_name="A &amp; B" total_matches="1"><line>5 &lt; 6 &amp;&amp; ok</line></monitor-event>';

    expect(parseMonitorWakeMessage(raw)).toEqual({
      taskId: "bash:1",
      displayName: "A & B",
      totalMatches: 1,
      lines: ["5 < 6 && ok"],
    });
  });

  it("returns null for content that is not a monitor event", () => {
    expect(parseMonitorWakeMessage("hello world")).toBeNull();
    expect(parseMonitorWakeMessage("<local-command-stdout>nope</local-command-stdout>")).toBeNull();
    expect(parseMonitorWakeMessage('<monitor-event taskId="bash:1">')).toBeNull();
  });
});
