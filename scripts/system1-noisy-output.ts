#!/usr/bin/env bun
/**
 * Emit deliberately noisy stdout designed to trigger Mux "System 1" bash-output filtering.
 *
 * Goal:
 * - Large enough to trigger System 1 filtering (lines > 10 and/or bytes > 4KB)
 * - Small enough to avoid the bash tool tmpfile overflow path per burst (bytes < 16KB, lines < 300)
 * - Contains exactly ONE relevant random number (the only digits in the output)
 *
 * Usage:
 *   bun scripts/system1-noisy-output.ts
 *   bun scripts/system1-noisy-output.ts --bursts 5 --sleep-ms 200
 *
 * Notes:
 * - Use --bursts/--sleep-ms for background-bash testing (bash_output/task_await).
 *   In foreground mode, multiple bursts may exceed the bash tool output limits.
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
const TARGET_MAX_TOTAL_BYTES_SINGLE = BASH_MAX_TOTAL_BYTES - 512;

// For burst mode, keep each burst modest so the final task output is still manageable.
const TARGET_MAX_TOTAL_BYTES_BURST = Math.min(TARGET_MAX_TOTAL_BYTES_SINGLE, SYSTEM1_BASH_MIN_TOTAL_BYTES + 2048);

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

function parseArgs(argv: string[]): { bursts: number; sleepMs: number } {
  let bursts = 1;
  let sleepMs = 0;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === "--bursts") {
      const raw = argv[i + 1];
      assert(raw !== undefined, "--bursts requires a value");
      bursts = Number.parseInt(raw, 10);
      i += 1;
      continue;
    }

    if (arg === "--sleep-ms") {
      const raw = argv[i + 1];
      assert(raw !== undefined, "--sleep-ms requires a value");
      sleepMs = Number.parseInt(raw, 10);
      i += 1;
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      // Avoid printing in normal use; throwing is fine for dev tooling.
      throw new Error(
        "Usage: bun scripts/system1-noisy-output.ts [--bursts N] [--sleep-ms MS]"
      );
    }

    throw new Error(`Unknown arg: ${arg}`);
  }

  assert(Number.isInteger(bursts) && bursts >= 1, "--bursts must be an integer >= 1");
  assert(Number.isInteger(sleepMs) && sleepMs >= 0, "--sleep-ms must be an integer >= 0");

  return { bursts, sleepMs };
}

function generateBurst(params: {
  includeSecretLine: boolean;
  secretNumber: number;
  targetMaxTotalBytes: number;
}): string {
  // Looks like an error so System 1 is strongly incentivized to keep it.
  // NOTE: This is the ONLY line in the whole output that contains digits.
  const secretLine = `ERROR: ONLY_RELEVANT_NUMBER=${params.secretNumber}`;

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

  if (params.includeSecretLine) {
    addLine(secretLine);
  }

  // Ensure we *definitely* cross System 1 activation thresholds.
  while (lines.length <= SYSTEM1_BASH_MIN_LINES || totalBytes <= SYSTEM1_BASH_MIN_TOTAL_BYTES) {
    addLine(randomLowercaseLetters(NOISE_LINE_LEN));
  }

  // Add as much additional noise as possible while staying safely under the target.
  for (;;) {
    const candidate = randomLowercaseLetters(NOISE_LINE_LEN);
    const candidateBytes = lineBytesWithNewline(candidate);

    if (lines.length + 1 >= BASH_HARD_MAX_LINES) break;
    if (totalBytes + candidateBytes >= params.targetMaxTotalBytes) break;

    addLine(candidate);
  }

  const output = lines.join("\n") + "\n";
  const outputBytes = Buffer.byteLength(output, "utf8");

  // Final defensive checks (should never fire unless assumptions change).
  assert(lines.length > SYSTEM1_BASH_MIN_LINES, "Output did not exceed System 1 min lines");
  assert(outputBytes > SYSTEM1_BASH_MIN_TOTAL_BYTES, "Output did not exceed System 1 min bytes");
  assert(outputBytes < BASH_MAX_TOTAL_BYTES, "Output exceeded bash max bytes");
  assert(lines.length < BASH_HARD_MAX_LINES, "Output exceeded bash max lines");

  return output;
}

async function main(): Promise<void> {
  const { bursts, sleepMs } = parseArgs(process.argv.slice(2));

  // 8-digit random number, avoids leading zeros.
  const secretNumber = randomInt(10_000_000, 100_000_000);

  const perBurstTarget = bursts > 1 ? TARGET_MAX_TOTAL_BYTES_BURST : TARGET_MAX_TOTAL_BYTES_SINGLE;

  for (let i = 0; i < bursts; i++) {
    const output = generateBurst({
      includeSecretLine: i === 0,
      secretNumber,
      targetMaxTotalBytes: perBurstTarget,
    });

    process.stdout.write(output);

    if (sleepMs > 0 && i < bursts - 1) {
      await new Promise((resolve) => setTimeout(resolve, sleepMs));
    }
  }
}

await main();
