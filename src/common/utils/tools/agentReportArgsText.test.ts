import { describe, test, expect } from "bun:test";
import { extractAgentReportArgsFromArgsText } from "./agentReportArgsText";

describe("extractAgentReportArgsFromArgsText", () => {
  test("extracts reportMarkdown and title from complete JSON", () => {
    const argsText = JSON.stringify({
      reportMarkdown: "Hello\\nWorld",
      title: "Result",
    });

    const extracted = extractAgentReportArgsFromArgsText(argsText);
    expect(extracted).toEqual({ reportMarkdown: "Hello\\nWorld", title: "Result" });
  });

  test("returns best-effort partial reportMarkdown when JSON is truncated", () => {
    const partial = '{"reportMarkdown":"Hello\\nWor';
    const extracted = extractAgentReportArgsFromArgsText(partial);
    expect(extracted.reportMarkdown).toBe("Hello\nWor");
  });

  test("tolerates truncated escape sequences", () => {
    const partial = '{"reportMarkdown":"Hello\\';
    const extracted = extractAgentReportArgsFromArgsText(partial);
    // Trailing backslash is ignored.
    expect(extracted.reportMarkdown).toBe("Hello");
  });

  test("decodes unicode escapes when complete and ignores incomplete unicode", () => {
    const complete = '{"reportMarkdown":"Hi \\u263A"}';
    expect(extractAgentReportArgsFromArgsText(complete).reportMarkdown).toBe("Hi ☺");

    const incomplete = '{"reportMarkdown":"Hi \\u26"}';
    expect(extractAgentReportArgsFromArgsText(incomplete).reportMarkdown).toBe("Hi ");
  });

  test("does not treat key-like text inside strings as a key", () => {
    const argsText = JSON.stringify({
      reportMarkdown: 'contains "reportMarkdown":"nope"',
      title: "T",
    });
    const extracted = extractAgentReportArgsFromArgsText(argsText);
    expect(extracted.reportMarkdown).toBe('contains "reportMarkdown":"nope"');
    expect(extracted.title).toBe("T");
  });
});
