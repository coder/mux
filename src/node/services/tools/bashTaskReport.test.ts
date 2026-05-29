import { describe, expect, it } from "bun:test";

import { formatBashOutputReport, tryParseBashOutputReport } from "./bashTaskReport";

describe("bashTaskReport", () => {
  it("roundtrips a bash output report with output", () => {
    const report = formatBashOutputReport({
      processId: "proc_123",
      status: "exited",
      exitCode: 0,
      output: "line1\nline2\n",
    });

    expect(report).toContain("### Bash task: proc_123");
    expect(report).toContain("status: exited");
    expect(report).toContain("exitCode: 0");
    expect(report).toContain("```text");

    const parsed = tryParseBashOutputReport(report);
    expect(parsed).toEqual({
      processId: "proc_123",
      status: "exited",
      exitCode: 0,
      output: "line1\nline2",
    });
  });

  it("does not parse status/exitCode from the output block", () => {
    const report = formatBashOutputReport({
      processId: "proc_123",
      status: "exited",
      exitCode: 0,
      output: "status: ok\nexitCode: 1\n",
    });

    expect(tryParseBashOutputReport(report)).toEqual({
      processId: "proc_123",
      status: "exited",
      exitCode: 0,
      output: "status: ok\nexitCode: 1",
    });
  });

  it("roundtrips output that contains a literal ``` fence line", () => {
    const report = formatBashOutputReport({
      processId: "proc_123",
      status: "exited",
      exitCode: 0,
      output: "before\n```\nafter\n",
    });

    // Ensure we picked a fence that can't be terminated by a literal ``` output line.
    expect(report).toContain("````text");

    const parsed = tryParseBashOutputReport(report);
    expect(parsed?.output).toBe("before\n```\nafter");
  });

  it("parses legacy reports where output contains a literal ``` fence line", () => {
    const legacy = [
      "### Bash task: proc_123",
      "",
      "status: exited",
      "exitCode: 0",
      "",
      "```text",
      "before",
      "```",
      "after",
      "```",
    ].join("\n");

    expect(tryParseBashOutputReport(legacy)).toEqual({
      processId: "proc_123",
      status: "exited",
      exitCode: 0,
      output: "before\n```\nafter",
    });
  });

  it("roundtrips a bash output report with no output", () => {
    const report = formatBashOutputReport({
      processId: "proc_123",
      status: "exited",
      exitCode: 0,
      output: "",
    });

    expect(report).toContain("### Bash task: proc_123");
    expect(report).toContain("status: exited");
    expect(report).toContain("exitCode: 0");
    expect(report).not.toContain("```text");

    const parsed = tryParseBashOutputReport(report);
    expect(parsed).toEqual({
      processId: "proc_123",
      status: "exited",
      exitCode: 0,
      output: "",
    });
  });

  it("returns undefined for non-bash markdown", () => {
    expect(tryParseBashOutputReport("### Not bash\nstatus: exited")).toBeUndefined();
  });
});
