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
