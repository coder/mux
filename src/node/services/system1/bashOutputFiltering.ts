import { z } from "zod";

import assert from "@/common/utils/assert";

export interface System1KeepRange {
  start: number;
  end: number;
  reason?: string;
}

export const system1BashKeepRangesSchema = z.object({
  keep_ranges: z.array(
    z.object({
      start: z.number(),
      end: z.number(),
    })
  ),
});

export type System1BashKeepRangesObject = z.infer<typeof system1BashKeepRangesSchema>;
export interface ApplySystem1KeepRangesResult {
  filteredOutput: string;
  keptLines: number;
  totalLines: number;
}

export function formatSystem1BashFilterNotice(params: {
  keptLines: number;
  totalLines: number;
  trigger: string;
  fullOutputPath?: string | undefined;
}): string {
  assert(
    Number.isInteger(params.keptLines) && params.keptLines >= 0,
    "keptLines must be a non-negative integer"
  );
  assert(
    Number.isInteger(params.totalLines) && params.totalLines >= 0,
    "totalLines must be a non-negative integer"
  );
  assert(params.keptLines <= params.totalLines, "keptLines must be <= totalLines");
  assert(
    typeof params.trigger === "string" && params.trigger.length > 0,
    "trigger must be a string"
  );

  const notice = `Auto-filtered output: kept ${params.keptLines}/${params.totalLines} lines (trigger: ${params.trigger}).`;

  if (typeof params.fullOutputPath !== "string" || params.fullOutputPath.length === 0) {
    return notice;
  }

  return (
    notice +
    `\n\nFull output saved to ${params.fullOutputPath}` +
    "\n\nFile will be automatically cleaned up when stream ends (it may already be gone)."
  );
}

export function splitBashOutputLines(output: string): string[] {
  if (output.length === 0) {
    return [];
  }

  // NOTE: Preserve exact line contents (including any \r characters).
  return output.split("\n");
}

export function formatNumberedLinesForSystem1(lines: string[]): string {
  return lines.map((line, index) => `${String(index + 1).padStart(4, "0")}| ${line}`).join("\n");
}

export function buildSystem1BashKeepRangesPrompt(params: {
  maxKeptLines: number;
  script: string;
  numberedOutput: string;
}): { systemPrompt: string; userMessage: string } {
  assert(
    Number.isInteger(params.maxKeptLines) && params.maxKeptLines > 0,
    "maxKeptLines must be a positive integer"
  );
  assert(typeof params.script === "string", "script must be a string");
  assert(
    typeof params.numberedOutput === "string" && params.numberedOutput.length > 0,
    "numberedOutput must be a non-empty string"
  );

  const systemPrompt = [
    "You are a fast log filtering assistant.",
    "Given numbered bash output, return ONLY valid JSON (no markdown, no prose).",
    'Schema: {"keep_ranges":[{"start":number,"end":number}]}',
    "Rules:",
    "- start/end are 1-based line numbers into the numbered output",
    `- Keep at most ${params.maxKeptLines} lines total (we may truncate)`,
    "- Prefer errors, stack traces, failing test summaries, and actionable warnings",
    "- Prefer fewer, wider ranges (return at most 8 ranges)",
    "- If uncertain, keep the most informative 1-5 lines",
    "",
    "Example:",
    "Numbered output:",
    "0001| building...",
    "0002| ERROR: expected X, got Y",
    "0003|   at path/to/file.ts:12:3",
    "0004| done",
    "JSON:",
    '{"keep_ranges":[{"start":2,"end":3}]}',
  ].join("\n");

  const userMessage = `Bash script:\n${params.script}\n\nNumbered output:\n${params.numberedOutput}`;

  return { systemPrompt, userMessage };
}

function extractFirstJsonObject(text: string): string | undefined {
  // Be tolerant of Markdown wrappers.
  const fenceMatch = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(text);
  const candidate = fenceMatch ? fenceMatch[1] : text;

  const first = candidate.indexOf("{");
  const last = candidate.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) {
    return undefined;
  }

  return candidate.slice(first, last + 1);
}

export function parseSystem1KeepRanges(text: string): System1KeepRange[] | undefined {
  const jsonText = extractFirstJsonObject(text);
  if (!jsonText) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return undefined;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }

  const keepRanges = (parsed as { keep_ranges?: unknown }).keep_ranges;
  if (!Array.isArray(keepRanges)) {
    return undefined;
  }

  const out: System1KeepRange[] = [];
  for (const entry of keepRanges) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }

    const record = entry as { start?: unknown; end?: unknown; reason?: unknown };
    if (typeof record.start !== "number" || typeof record.end !== "number") {
      continue;
    }

    out.push({
      start: record.start,
      end: record.end,
      reason: typeof record.reason === "string" ? record.reason : undefined,
    });
  }

  return out;
}

const HEURISTIC_IMPORTANT_LINE_REGEX =
  /(^|\b)(error|failed|failure|fatal|panic|exception|traceback|warning|assertion failed|npm err!|err!|exited with code|exit code)(\b|$)/i;

const HEURISTIC_CONTEXT_LINES = 2;
const HEURISTIC_MAX_MATCH_RANGES = 50;

export function getHeuristicKeepRangesForBashOutput(params: {
  lines: string[];
  maxKeptLines: number;
}): System1KeepRange[] {
  assert(Array.isArray(params.lines), "lines must be an array");
  assert(
    Number.isInteger(params.maxKeptLines) && params.maxKeptLines > 0,
    "maxKeptLines must be a positive integer"
  );

  const totalLines = params.lines.length;
  if (totalLines === 0) {
    return [];
  }

  // Keep a small head/tail slice so users can see setup and summary.
  const headTailLines = Math.max(1, Math.min(5, Math.floor(params.maxKeptLines / 8)));

  const ranges: System1KeepRange[] = [];

  const headEnd = Math.min(totalLines, headTailLines);
  if (headEnd > 0) {
    ranges.push({ start: 1, end: headEnd, reason: "head" });
  }

  const tailStart = Math.max(1, totalLines - headTailLines + 1);
  if (tailStart <= totalLines) {
    ranges.push({ start: tailStart, end: totalLines, reason: "tail" });
  }

  let matchRanges = 0;
  for (let idx = 0; idx < totalLines; idx += 1) {
    if (matchRanges >= HEURISTIC_MAX_MATCH_RANGES) {
      break;
    }

    const line = params.lines[idx];
    if (!HEURISTIC_IMPORTANT_LINE_REGEX.test(line)) {
      continue;
    }

    const lineNo = idx + 1;
    const start = Math.max(1, lineNo - HEURISTIC_CONTEXT_LINES);
    const end = Math.min(totalLines, lineNo + HEURISTIC_CONTEXT_LINES);

    ranges.push({ start, end, reason: "match" });
    matchRanges += 1;
  }

  return ranges;
}

interface NormalizedRange {
  start: number;
  end: number;
}

function normalizeKeepRanges(ranges: System1KeepRange[], maxLine: number): NormalizedRange[] {
  assert(Number.isInteger(maxLine) && maxLine >= 0, "maxLine must be a non-negative integer");

  const normalized: NormalizedRange[] = [];
  for (const range of ranges) {
    if (!Number.isFinite(range.start) || !Number.isFinite(range.end)) {
      continue;
    }

    // System 1 may return floats; clamp after rounding.
    let start = Math.floor(range.start);
    let end = Math.floor(range.end);

    if (start > end) {
      [start, end] = [end, start];
    }

    // 1-based indexing.
    start = Math.max(1, Math.min(maxLine, start));
    end = Math.max(1, Math.min(maxLine, end));

    normalized.push({ start, end });
  }

  normalized.sort((a, b) => a.start - b.start || a.end - b.end);

  const merged: NormalizedRange[] = [];
  for (const range of normalized) {
    const prev = merged[merged.length - 1];
    if (!prev) {
      merged.push(range);
      continue;
    }

    // Merge overlapping/adjacent ranges.
    if (range.start <= prev.end + 1) {
      prev.end = Math.max(prev.end, range.end);
      continue;
    }

    merged.push(range);
  }

  return merged;
}

export function applySystem1KeepRangesToOutput(params: {
  rawOutput: string;
  keepRanges: System1KeepRange[];
  maxKeptLines: number;
}): ApplySystem1KeepRangesResult | undefined {
  assert(typeof params.rawOutput === "string", "rawOutput must be a string");
  assert(Array.isArray(params.keepRanges), "keepRanges must be an array");
  assert(
    Number.isInteger(params.maxKeptLines) && params.maxKeptLines > 0,
    "maxKeptLines must be a positive integer"
  );

  const lines = splitBashOutputLines(params.rawOutput);
  const totalLines = lines.length;

  if (totalLines === 0) {
    return {
      filteredOutput: "",
      keptLines: 0,
      totalLines: 0,
    };
  }

  const normalized = normalizeKeepRanges(params.keepRanges, totalLines);
  if (normalized.length === 0) {
    return undefined;
  }

  const kept: string[] = [];
  for (const range of normalized) {
    for (let lineNo = range.start; lineNo <= range.end; lineNo += 1) {
      kept.push(lines[lineNo - 1]);

      if (kept.length >= params.maxKeptLines) {
        return {
          filteredOutput: kept.join("\n"),
          keptLines: kept.length,
          totalLines,
        };
      }
    }
  }

  return {
    filteredOutput: kept.join("\n"),
    keptLines: kept.length,
    totalLines,
  };
}
