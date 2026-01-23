#!/usr/bin/env bun
/**
 * Emit deliberately noisy stdout designed to trigger Mux "System 1" bash-output filtering.
 *
 * Goal:
 * - Large enough to trigger System 1 filtering (lines > 10 and/or bytes > 4KB)
 * - Small enough to avoid the bash tool tmpfile overflow path per burst (bytes < 16KB, lines < 300)
 * - Output looks like plausible text/log spam rather than random gibberish
 * - Contains a single "needle" phrase embedded inside the noise (not on a standalone ERROR line)
 *
 * Usage:
 *   bun scripts/system1-noisy-output.ts
 *   bun scripts/system1-noisy-output.ts --bursts 5 --sleep-ms 200
 *   bun scripts/system1-noisy-output.ts --git
 *   bun scripts/system1-noisy-output.ts --needles
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
const TARGET_MAX_TOTAL_BYTES_BURST = Math.min(
  TARGET_MAX_TOTAL_BYTES_SINGLE,
  SYSTEM1_BASH_MIN_TOTAL_BYTES + 2048
);

const TARGET_MAX_TOTAL_BYTES_NEEDLES = Math.min(
  TARGET_MAX_TOTAL_BYTES_SINGLE,
  SYSTEM1_BASH_MIN_TOTAL_BYTES + 8 * 1024
);

// Keep lines short and ASCII-only so byte counts are predictable.
const TEXT_LINE_TARGET_LEN = 96;

// Intentionally a plausible-looking phrase (no digits) so it can be buried in noise.
// We keep it constant so it is easy to grep for during manual testing.
const NEEDLE_PHRASE = "maecenas faucibus mollis interdum";

// A realistic-ish git rebase conflict transcript, condensed to remove hint blocks and repeated
// "Rebasing (n/N)" progress spam.
//
// This fixture is intentionally > 10 lines so it reliably triggers System 1 filtering.
const GIT_REBASE_CONFLICT_OUTPUT_LINES = [
  "Rebasing (6/14)",
  "Applying: chore: format",
  "Applying: refactor(router): split handlers",
  "Applying: refactor(router): clean up error reporting",
  "Applying: fix: include plan path in harness bearings",
  "Applying: tests: update router snapshots",
  "Applying: build: regenerate orpc types",
  "Auto-merging src/node/orpc/router.ts",
  "CONFLICT (content): Merge conflict in src/node/orpc/router.ts",
  "error: could not apply 678c593ed... fix: include plan path in harness bearings",
  "Could not apply 678c593ed... fix: include plan path in harness bearings",
] as const;

const DEVELOPER_SIGNAL_LINES = [
  // High-priority (should always surface):
  "Error: ECONNREFUSED 127.0.0.1:5432 - database connection failed",
  "FATAL: Out of memory, killing process",
  "warning: deprecated API 'fetchSync' will be removed in v3.0",
  "Tests: 47 passed, 2 failed, 1 skipped",
  "Build failed with exit code 1",
  // Medium-priority (likely important):
  "Listening on http://localhost:3000",
  "Compiled successfully in 1.2s",
  "warning: unused variable 'config' on line 42",
  "Migration 20240115_add_users applied successfully",
  // Subtle/tricky (tests semantic understanding):
  "Retrying request (attempt 3/3)...",
  "Skipping optional dependency: fsevents",
  "Connection pool exhausted, waiting...",
  // False positive traps (should NOT surface):
  "Processing error_handler.ts...",
  "const WARNING_LEVEL = 3;",
  "// TODO: handle edge case",
  // Security-sensitive (definitely surface):
  "API_KEY=sk-live-abc123...",
  "Permission denied: /etc/shadow",
] as const;

const LOREM_WORDS = [
  // Classic lorem ipsum core
  "lorem",
  "ipsum",
  "dolor",
  "sit",
  "amet",
  "consectetur",
  "adipiscing",
  "elit",
  "sed",
  "do",
  "eiusmod",
  "tempor",
  "incididunt",
  "ut",
  "labore",
  "et",
  "dolore",
  "magna",
  "aliqua",
  "enim",
  "ad",
  "minim",
  "veniam",
  "quis",
  "nostrud",
  "exercitation",
  "ullamco",
  "laboris",
  "nisi",
  "aliquip",
  "ex",
  "ea",
  "commodo",
  "consequat",
  "duis",
  "aute",
  "irure",
  "in",
  "reprehenderit",
  "voluptate",
  "velit",
  "esse",
  "cillum",
  "fugiat",
  "nulla",
  "pariatur",
  "excepteur",
  "sint",
  "occaecat",
  "cupidatat",
  "non",
  "proident",
  "sunt",
  "culpa",
  "qui",
  "officia",
  "deserunt",
  "mollit",
  "anim",
  "id",
  "est",
  "laborum",
  // Additional filler to make output look less uniform
  "pellentesque",
  "habitant",
  "morbi",
  "tristique",
  "senectus",
  "netus",
  "malesuada",
  "fames",
  "turpis",
  "egestas",
  "vestibulum",
  "tortor",
  "quam",
  "feugiat",
  "vitae",
  "ultricies",
  "eget",
  "ante",
  "donec",
  "eu",
  "libero",
  "quam",
  "semper",
  "aenean",
  "mauris",
  "placerat",
  "eleifend",
  "leo",
];

function lineBytesWithNewline(line: string): number {
  const bytes = Buffer.byteLength(line, "utf8");
  assert(
    bytes < BASH_MAX_LINE_BYTES,
    `Generated line exceeded ${BASH_MAX_LINE_BYTES} bytes (${bytes})`
  );
  return bytes + 1; // + "\n"
}

function parseArgs(argv: string[]): {
  bursts: number;
  sleepMs: number;
  isGit: boolean;
  isNeedles: boolean;
} {
  let bursts = 1;
  let sleepMs = 0;
  let isGit = false;
  let isNeedles = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === "--git") {
      isGit = true;
      continue;
    }

    if (arg === "--needles") {
      isNeedles = true;
      continue;
    }

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
        "Usage: bun scripts/system1-noisy-output.ts [--git] [--needles] [--bursts N] [--sleep-ms MS]"
      );
    }

    throw new Error(`Unknown arg: ${arg}`);
  }

  assert(Number.isInteger(bursts) && bursts >= 1, "--bursts must be an integer >= 1");
  assert(Number.isInteger(sleepMs) && sleepMs >= 0, "--sleep-ms must be an integer >= 0");
  assert(!(isGit && isNeedles), "--git and --needles are mutually exclusive");

  if (isGit || isNeedles) {
    assert(bursts === 1, "--git/--needles mode does not support --bursts");
    assert(sleepMs === 0, "--git/--needles mode does not support --sleep-ms");
  }

  return { bursts, sleepMs, isGit, isNeedles };
}

function getGitRebaseConflictOutput(): string {
  const lines = [...GIT_REBASE_CONFLICT_OUTPUT_LINES];

  // Ensure we *definitely* cross System 1 activation thresholds.
  assert(lines.length > SYSTEM1_BASH_MIN_LINES, "Git output did not exceed System 1 min lines");

  const output = lines.join("\n") + "\n";
  const outputBytes = Buffer.byteLength(output, "utf8");

  // Defensive checks (should never fire unless assumptions change).
  assert(lines.length < BASH_HARD_MAX_LINES, "Git output exceeded bash max lines");
  assert(outputBytes < BASH_MAX_TOTAL_BYTES, "Git output exceeded bash max bytes");

  // Ensure we never emit a single line that breaks the tool output limit.
  for (const line of lines) {
    void lineBytesWithNewline(line);
  }

  // Sanity: keep the core conflict lines intact.
  assert(output.includes("CONFLICT (content):"), "Git output missing CONFLICT line");
  assert(output.includes("could not apply"), "Git output missing could-not-apply line");

  return output;
}

function makePlausibleDevLogLine(index: number): string {
  assert(Number.isInteger(index) && index >= 0, "index must be a non-negative integer");

  const fileId = String(index % 97).padStart(2, "0");

  switch (index % 6) {
    case 0:
      return `info: [builder] transpiling src/module-${fileId}.ts -> dist/module-${fileId}.js`;
    case 1:
      return `info: [builder] resolved ${100 + index} modules, ${20 + (index % 15)} cached`;
    case 2:
      return `debug: [cache] hit for pkg-${index % 17}@${1 + (index % 3)}.${index % 10}.${index % 7}`;
    case 3:
      return `info: [bundler] emitted chunk-${index % 12} (${50 + (index % 40)}kb)`;
    case 4:
      return `info: [lint] checking src/file-${fileId}.ts (mode=${index % 4 === 0 ? "fast" : "full"})`;
    case 5:
      return `debug: [timing] step=${index} duration=${(index % 9) + 1}.${index % 10}s`;
    default:
      // This should be unreachable due to modulo.
      assert(false, "Unreachable dev log line case");
  }
}

function getNeedlesOutput(params: { targetMaxTotalBytes: number }): string {
  assert(
    Number.isInteger(params.targetMaxTotalBytes) && params.targetMaxTotalBytes > 0,
    "targetMaxTotalBytes must be a positive integer"
  );

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

  // Preamble: looks like a plausible command run.
  addLine("$ bun run build");

  let noiseIndex = 0;
  const noiseBetweenSignals = 6;

  for (const signalLine of DEVELOPER_SIGNAL_LINES) {
    for (let i = 0; i < noiseBetweenSignals; i++) {
      addLine(makePlausibleDevLogLine(noiseIndex));
      noiseIndex += 1;
    }

    addLine(signalLine);
  }

  // Fill with more plausible noise so System 1 has to choose (max kept lines is limited).
  for (;;) {
    const candidate = makePlausibleDevLogLine(noiseIndex);
    noiseIndex += 1;

    const candidateBytes = lineBytesWithNewline(candidate);

    if (lines.length + 1 >= BASH_HARD_MAX_LINES) break;
    if (totalBytes + candidateBytes >= params.targetMaxTotalBytes) break;

    addLine(candidate);
  }

  const output = lines.join("\n") + "\n";
  const outputBytes = Buffer.byteLength(output, "utf8");

  // Final defensive checks (should never fire unless assumptions change).
  assert(lines.length > SYSTEM1_BASH_MIN_LINES, "Needles output did not exceed System 1 min lines");
  assert(
    outputBytes > SYSTEM1_BASH_MIN_TOTAL_BYTES,
    "Needles output did not exceed System 1 min bytes"
  );
  assert(outputBytes < BASH_MAX_TOTAL_BYTES, "Needles output exceeded bash max bytes");
  assert(lines.length < BASH_HARD_MAX_LINES, "Needles output exceeded bash max lines");

  // Sanity: keep our intended signal lines intact.
  for (const signalLine of DEVELOPER_SIGNAL_LINES) {
    assert(output.includes(signalLine), `Needles output missing expected line: ${signalLine}`);
  }

  return output;
}

function capitalizeFirstLetter(text: string): string {
  assert(typeof text === "string" && text.length > 0, "text must be a non-empty string");
  return text[0].toUpperCase() + text.slice(1);
}

function randomLoremWord(): string {
  return LOREM_WORDS[randomInt(0, LOREM_WORDS.length)]!;
}

function makeLoremSentence(params: {
  targetLen: number;
  insertPhrase?: string | undefined;
}): string {
  assert(Number.isInteger(params.targetLen) && params.targetLen > 0, "targetLen must be > 0");

  const words: string[] = [];
  let currentLen = 0;

  // Build up a sentence with word-ish lengths; keep it deterministic-ish by targeting characters.
  while (currentLen < params.targetLen) {
    const next = randomLoremWord();
    words.push(next);
    currentLen += next.length + 1;

    // Avoid pathological loops if assumptions change.
    assert(words.length < 200, "Generated too many words for a single line");
  }

  // Add a comma in roughly the middle to make it look slightly more natural.
  if (words.length > 12) {
    const commaAt = randomInt(4, Math.min(9, words.length - 2));
    words[commaAt] = `${words[commaAt]},`;
  }

  if (typeof params.insertPhrase === "string" && params.insertPhrase.length > 0) {
    const phraseWords = params.insertPhrase.split(/\s+/).filter(Boolean);
    assert(phraseWords.length > 0, "insertPhrase produced no words");

    // Prefer inserting somewhere "in the middle" so the phrase isn't the start or end of the line.
    const minIndex = Math.min(6, Math.max(0, words.length - 1));
    const maxIndex = Math.max(minIndex + 1, words.length - 3);
    const insertAt = randomInt(minIndex, maxIndex);

    words.splice(insertAt, 0, ...phraseWords);
  }

  const sentence = capitalizeFirstLetter(words.join(" ")) + ".";
  // Must not accidentally exceed the bash tool line limit.
  void lineBytesWithNewline(sentence);
  return sentence;
}

function generateBurst(params: {
  includeNeedle: boolean;
  needlePhrase: string;
  targetMaxTotalBytes: number;
}): string {
  const lines: string[] = [];
  let totalBytes = 0;

  let needleInserted = false;
  const needleInsertAfterLines = randomInt(8, 18);

  const addLine = (line: string): void => {
    const lineBytes = lineBytesWithNewline(line);

    // Must stay under bash tmpfile overflow limits or System 1 will never run.
    assert(lines.length + 1 < BASH_HARD_MAX_LINES, "Exceeded bash max lines");
    assert(totalBytes + lineBytes < BASH_MAX_TOTAL_BYTES, "Exceeded bash max bytes");

    lines.push(line);
    totalBytes += lineBytes;
  };

  // Ensure we *definitely* cross System 1 activation thresholds.
  while (lines.length <= SYSTEM1_BASH_MIN_LINES || totalBytes <= SYSTEM1_BASH_MIN_TOTAL_BYTES) {
    if (params.includeNeedle && !needleInserted && lines.length >= needleInsertAfterLines) {
      addLine(
        makeLoremSentence({
          targetLen: TEXT_LINE_TARGET_LEN,
          insertPhrase: params.needlePhrase,
        })
      );
      needleInserted = true;
      continue;
    }

    addLine(makeLoremSentence({ targetLen: TEXT_LINE_TARGET_LEN }));
  }

  // Defensive: ensure the needle exists even if our insertion assumptions change.
  if (params.includeNeedle && !needleInserted) {
    addLine(
      makeLoremSentence({
        targetLen: TEXT_LINE_TARGET_LEN,
        insertPhrase: params.needlePhrase,
      })
    );
  }

  // Add as much additional noise as possible while staying safely under the target.
  for (;;) {
    const candidate = makeLoremSentence({ targetLen: TEXT_LINE_TARGET_LEN });
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
  const { bursts, sleepMs, isGit, isNeedles } = parseArgs(process.argv.slice(2));

  if (isGit) {
    process.stdout.write(getGitRebaseConflictOutput());
    return;
  }

  if (isNeedles) {
    process.stdout.write(
      getNeedlesOutput({
        targetMaxTotalBytes: TARGET_MAX_TOTAL_BYTES_NEEDLES,
      })
    );
    return;
  }

  const perBurstTarget = bursts > 1 ? TARGET_MAX_TOTAL_BYTES_BURST : TARGET_MAX_TOTAL_BYTES_SINGLE;

  for (let i = 0; i < bursts; i++) {
    const output = generateBurst({
      includeNeedle: i === 0,
      needlePhrase: NEEDLE_PHRASE,
      targetMaxTotalBytes: perBurstTarget,
    });

    process.stdout.write(output);

    if (sleepMs > 0 && i < bursts - 1) {
      await new Promise((resolve) => setTimeout(resolve, sleepMs));
    }
  }
}

await main();
