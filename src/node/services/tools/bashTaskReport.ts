import assert from "@/common/utils/assert";

function getMarkdownCodeFenceDelimiter(args: { output: string }): string {
  assert(typeof args.output === "string", "output must be a string");

  // Pick a fence longer than any run of backticks in the output so literal ``` lines
  // can't terminate the block early (and lose the remaining output when re-parsing).
  let longestBacktickRun = 0;
  let currentRun = 0;
  for (const char of args.output) {
    if (char === "`") {
      currentRun += 1;
      continue;
    }

    if (currentRun > longestBacktickRun) {
      longestBacktickRun = currentRun;
    }
    currentRun = 0;
  }
  if (currentRun > longestBacktickRun) {
    longestBacktickRun = currentRun;
  }

  const fenceLength = Math.max(3, longestBacktickRun + 1);
  return "`".repeat(fenceLength);
}
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
    const trimmedOutput = args.output.trimEnd();
    const fence = getMarkdownCodeFenceDelimiter({ output: trimmedOutput });

    lines.push("");
    lines.push(`${fence}text`);
    lines.push(trimmedOutput);
    lines.push(fence);
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

  // Parse fenced output block (optional).
  const fenceStart = lines.findIndex((line) => /^`{3,}text\s*$/.test(line.trimEnd()));

  // Find status/exitCode lines. Keep this tolerant to extra blank lines.
  // IMPORTANT: only scan the header section; the output block may contain literal
  // "status:" / "exitCode:" lines that must not override the header.
  const headerLines = fenceStart === -1 ? lines : lines.slice(0, fenceStart);

  let status: string | undefined;
  let exitCode: number | undefined;

  for (const line of headerLines) {
    if (status === undefined && line.startsWith("status:")) {
      status = line.slice("status:".length).trim();
      continue;
    }

    if (exitCode === undefined && line.startsWith("exitCode:")) {
      const parsed = Number.parseInt(line.slice("exitCode:".length).trim(), 10);
      if (Number.isFinite(parsed)) {
        exitCode = parsed;
      }
    }
  }

  if (!status) {
    return undefined;
  }

  let output = "";
  if (fenceStart !== -1) {
    const fenceLine = lines[fenceStart]?.trimEnd() ?? "";
    const match = /^(`{3,})text\s*$/.exec(fenceLine);
    if (!match) {
      return undefined;
    }

    const fence = match[1];

    // We always append the closing fence at the end of the report. If the output contains
    // literal fence lines (e.g. "```"), picking the *first* closing fence would truncate
    // the parsed output and permanently drop data when we rewrite the report.
    let fenceEnd = -1;
    for (let index = lines.length - 1; index > fenceStart; index -= 1) {
      if ((lines[index]?.trimEnd() ?? "") !== fence) {
        continue;
      }

      const onlyBlankLinesAfterFence = lines
        .slice(index + 1)
        .every((line) => line.trim().length === 0);
      if (onlyBlankLinesAfterFence) {
        fenceEnd = index;
        break;
      }
    }

    if (fenceEnd === -1) {
      fenceEnd = lines.findIndex((line, index) => index > fenceStart && line.trimEnd() === fence);
    }

    if (fenceEnd === -1) {
      return undefined;
    }

    output = lines.slice(fenceStart + 1, fenceEnd).join("\n");
  }

  return { processId, status, exitCode, output };
}
