#!/usr/bin/env bun
/**
 * Emit a deliberately noisy blob of stdout designed to trigger Mux "System 1" bash-output filtering.
 *
 * Goal:
 * - Large enough to trigger System 1 filtering (lines > 10 and/or bytes > 4KB)
 * - Small enough to avoid the bash tool tmpfile overflow path (bytes < 16KB, lines < 300)
 * - Contains exactly ONE relevant random number (the only digits in the output)
 *
 * Usage:
 *   bun scripts/system1-noisy-output.ts
 */

import assert from "node:assert/strict";
import { randomInt } from "node:crypto";

// Keep these in sync with:
// - src/node/services/aiService.ts (System 1 trigger)
// - src/common/constants/toolLimits.ts (bash tool output limits)
const SYSTEM1_BASH_MIN_LINES = 10;
const SYSTEM1_BASH_MIN_TOTAL_BYTES = 4 * 1024;

const BASH_HARD_MAX_LINES = 300;
const BASH_MAX_TOTAL_BYTES = 16 * 1024;
const BASH_MAX_LINE_BYTES = 1024;

// Safety margin to avoid accidental boundary changes (encoding/newlines, etc.).
const TARGET_MAX_TOTAL_BYTES = BASH_MAX_TOTAL_BYTES - 512;

// Keep noise lines short and ASCII-only so byte counts are predictable.
const NOISE_LINE_LEN = 80;

function randomLowercaseLetters(len: number): string {
  assert(Number.isInteger(len) && len > 0, "len must be a positive integer");

  const chars: string[] = [];
  chars.length = len;
  for (let i = 0; i < len; i++) {
    // a-z only (no digits) so the secret number is the only numeric content in stdout
    chars[i] = String.fromCharCode(97 + randomInt(0, 26));
  }
  return chars.join("");
}

function lineBytesWithNewline(line: string): number {
  const bytes = Buffer.byteLength(line, "utf8");
  assert(
    bytes < BASH_MAX_LINE_BYTES,
    `Generated line exceeded ${BASH_MAX_LINE_BYTES} bytes (${bytes})`
  );
  return bytes + 1; // + "\n"
}

function main(): void {
  // 8-digit random number, avoids leading zeros.
  const secretNumber = randomInt(10_000_000, 100_000_000);

  // Looks like an error so System 1 is strongly incentivized to keep it.
  // NOTE: This is the ONLY line in the whole output that contains digits.
  const secretLine = `ERROR: ONLY_RELEVANT_NUMBER=${secretNumber}`;

  const lines: string[] = [];
  let totalBytes = 0;

  const addLine = (line: string): void => {
    const lineBytes = lineBytesWithNewline(line);

    // Must stay under bash tmpfile overflow limits or System 1 will never run.
    assert(lines.length + 1 < BASH_HARD_MAX_LINES, "Exceeded bash max lines");
    assert(totalBytes + lineBytes < BASH_MAX_TOTAL_BYTES, "Exceeded bash max bytes");

    lines.push(line);
    totalBytes += lineBytes;
  };

  // Include the relevant number.
  addLine(secretLine);

  // Ensure we *definitely* cross System 1 activation thresholds.
  while (lines.length <= SYSTEM1_BASH_MIN_LINES || totalBytes <= SYSTEM1_BASH_MIN_TOTAL_BYTES) {
    addLine(randomLowercaseLetters(NOISE_LINE_LEN));
  }

  // Add as much additional noise as possible while staying safely under the bash limits.
  for (;;) {
    const candidate = randomLowercaseLetters(NOISE_LINE_LEN);
    const candidateBytes = lineBytesWithNewline(candidate);

    if (lines.length + 1 >= BASH_HARD_MAX_LINES) break;
    if (totalBytes + candidateBytes >= TARGET_MAX_TOTAL_BYTES) break;

    addLine(candidate);
  }

  const output = lines.join("\n") + "\n";
  const outputBytes = Buffer.byteLength(output, "utf8");

  // Final defensive checks (should never fire unless assumptions change).
  assert(lines.length > SYSTEM1_BASH_MIN_LINES, "Output did not exceed System 1 min lines");
  assert(outputBytes > SYSTEM1_BASH_MIN_TOTAL_BYTES, "Output did not exceed System 1 min bytes");
  assert(outputBytes < BASH_MAX_TOTAL_BYTES, "Output exceeded bash max bytes");
  assert(lines.length < BASH_HARD_MAX_LINES, "Output exceeded bash max lines");

  process.stdout.write(output);
}

main();
