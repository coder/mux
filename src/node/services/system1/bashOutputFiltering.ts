import assert from "@/common/utils/assert";

export interface System1KeepRange {
  start: number;
  end: number;
  reason?: string;
}

export interface ApplySystem1KeepRangesResult {
  filteredOutput: string;
  keptLines: number;
  totalLines: number;
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
