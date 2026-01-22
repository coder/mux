import assert from "@/common/utils/assert";

export interface ParsedBashOutputReport {
  processId: string;
  status: string;
  exitCode?: number;
  output: string;
}

export function formatBashOutputReport(args: {
  processId: string;
  status: string;
  exitCode?: number;
  output: string;
}): string {
  assert(typeof args.processId === "string" && args.processId.length > 0, "processId required");
  assert(typeof args.status === "string" && args.status.length > 0, "status required");
  assert(typeof args.output === "string", "output must be a string");

  const lines: string[] = [];

  lines.push(`### Bash task: ${args.processId}`);
  lines.push("");

  lines.push(`status: ${args.status}`);
  if (args.exitCode !== undefined) {
    lines.push(`exitCode: ${args.exitCode}`);
  }

  if (args.output.trim().length > 0) {
    lines.push("");
    lines.push("```text");
    lines.push(args.output.trimEnd());
    lines.push("```");
  }

  return lines.join("\n");
}

export function tryParseBashOutputReport(
  reportMarkdown: string
): ParsedBashOutputReport | undefined {
  if (typeof reportMarkdown !== "string") return undefined;

  const lines = reportMarkdown.split("\n");
  const header = lines[0] ?? "";
  const headerPrefix = "### Bash task:";
  if (!header.startsWith(headerPrefix)) {
    return undefined;
  }

  const processId = header.slice(headerPrefix.length).trim();
  if (!processId) {
    return undefined;
  }

  // Find status/exitCode lines. Keep this tolerant to extra blank lines.
  let status: string | undefined;
  let exitCode: number | undefined;

  for (const line of lines) {
    if (line.startsWith("status:")) {
      status = line.slice("status:".length).trim();
      continue;
    }

    if (line.startsWith("exitCode:")) {
      const parsed = Number.parseInt(line.slice("exitCode:".length).trim(), 10);
      if (Number.isFinite(parsed)) {
        exitCode = parsed;
      }
    }
  }

  if (!status) {
    return undefined;
  }

  // Parse fenced output block (optional)
  let output = "";
  const fenceStart = lines.findIndex((line) => line.trimEnd() === "```text");
  if (fenceStart !== -1) {
    const fenceEnd = lines.findIndex(
      (line, index) => index > fenceStart && line.trimEnd() === "```"
    );
    if (fenceEnd === -1) {
      return undefined;
    }

    output = lines.slice(fenceStart + 1, fenceEnd).join("\n");
  }

  return { processId, status, exitCode, output };
}
