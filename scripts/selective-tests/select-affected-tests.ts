#!/usr/bin/env bun
/**
 * Select which integration tests to run based on changed files.
 *
 * Usage:
 *   bun scripts/selective-tests/select-affected-tests.ts [options]
 *
 * Options:
 *   --map <path>         Path to coverage map JSON (default: coverage-map.json)
 *   --base <ref>         Git base ref for comparison (default: origin/main)
 *   --head <ref>         Git head ref for comparison (default: HEAD)
 *   --changed <files>    Comma-separated list of changed files (overrides git diff)
 *   --output <format>    Output format: json, list, or jest (default: jest)
 *   --max-staleness <d>  Maximum map age in days (default: 7)
 *   --force-all          Force running all tests (for debugging)
 *   --verbose            Enable verbose logging
 *
 * Exit codes:
 *   0 - Success, selective tests determined
 *   2 - Fallback triggered, run all tests
 *   1 - Error
 *
 * Output (stdout):
 *   - json: Full AffectedTestsResult as JSON
 *   - list: Newline-separated list of test files
 *   - jest: Space-separated test files suitable for jest CLI
 */

import { execSync } from "child_process";
import * as fs from "fs";
import type { CoverageMap, AffectedTestsResult } from "./types";
import { EXIT_CODES, INFRASTRUCTURE_PATTERNS } from "./types";

// minimatch is CommonJS, need to use require
// eslint-disable-next-line @typescript-eslint/no-require-imports
const minimatch = require("minimatch") as (
  file: string,
  pattern: string,
  options?: { matchBase?: boolean }
) => boolean;

const DEFAULT_MAP_PATH = "coverage-map.json";
const DEFAULT_BASE_REF = "origin/main";
const DEFAULT_HEAD_REF = "HEAD";
const DEFAULT_MAX_STALENESS_DAYS = 7;

interface Options {
  mapPath: string;
  baseRef: string;
  headRef: string;
  changedFiles: string[] | null;
  outputFormat: "json" | "list" | "jest";
  maxStalenessDays: number;
  forceAll: boolean;
  verbose: boolean;
}

function log(message: string, verbose: boolean, force = false): void {
  if (verbose || force) {
    console.error(`[select-affected-tests] ${message}`);
  }
}

function parseArgs(): Options {
  const args = process.argv.slice(2);
  const options: Options = {
    mapPath: DEFAULT_MAP_PATH,
    baseRef: DEFAULT_BASE_REF,
    headRef: DEFAULT_HEAD_REF,
    changedFiles: null,
    outputFormat: "jest",
    maxStalenessDays: DEFAULT_MAX_STALENESS_DAYS,
    forceAll: false,
    verbose: false,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--map":
        options.mapPath = args[++i];
        break;
      case "--base":
        options.baseRef = args[++i];
        break;
      case "--head":
        options.headRef = args[++i];
        break;
      case "--changed":
        options.changedFiles = args[++i].split(",").filter(Boolean);
        break;
      case "--output":
        options.outputFormat = args[++i] as "json" | "list" | "jest";
        break;
      case "--max-staleness":
        options.maxStalenessDays = parseInt(args[++i], 10);
        break;
      case "--force-all":
        options.forceAll = true;
        break;
      case "--verbose":
        options.verbose = true;
        break;
    }
  }

  return options;
}

function getChangedFiles(baseRef: string, headRef: string): string[] {
  try {
    // First, try to get the merge base for more accurate diffing
    const mergeBase = execSync(`git merge-base ${baseRef} ${headRef}`, {
      encoding: "utf-8",
    }).trim();

    const output = execSync(`git diff --name-only ${mergeBase} ${headRef}`, {
      encoding: "utf-8",
    });

    return output
      .split("\n")
      .map((f) => f.trim())
      .filter(Boolean);
  } catch {
    // Fallback to direct diff if merge-base fails
    try {
      const output = execSync(`git diff --name-only ${baseRef} ${headRef}`, {
        encoding: "utf-8",
      });
      return output
        .split("\n")
        .map((f) => f.trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  }
}

function matchesPattern(file: string, pattern: string): boolean {
  // Handle glob patterns
  if (pattern.includes("*")) {
    return minimatch(file, pattern, { matchBase: true });
  }
  // Exact match or directory prefix
  return file === pattern || file.startsWith(pattern + "/");
}

function isInfrastructureFile(
  file: string,
  patterns: string[] = INFRASTRUCTURE_PATTERNS
): boolean {
  return patterns.some((pattern) => matchesPattern(file, pattern));
}

function isNewTestFile(file: string, coverageMap: CoverageMap): boolean {
  return (
    file.startsWith("tests/integration/") &&
    file.endsWith(".test.ts") &&
    !coverageMap.allTests.includes(file)
  );
}

function loadCoverageMap(mapPath: string): CoverageMap | null {
  if (!fs.existsSync(mapPath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(mapPath, "utf-8");
    return JSON.parse(content) as CoverageMap;
  } catch {
    return null;
  }
}

function isMapStale(map: CoverageMap, maxDays: number): boolean {
  const generatedAt = new Date(map.generatedAt);
  const now = new Date();
  const ageMs = now.getTime() - generatedAt.getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  return ageDays > maxDays;
}

function selectAffectedTests(
  options: Options
): AffectedTestsResult & { exitCode: number } {
  const verbose = options.verbose;

  // Check for force-all flag
  if (options.forceAll) {
    log("Force-all flag set, running all tests", verbose, true);
    return {
      runAll: true,
      reason: "Force-all flag set",
      tests: [],
      changedFiles: [],
      unmappedFiles: [],
      exitCode: EXIT_CODES.FALLBACK_TRIGGERED,
    };
  }

  // Load coverage map
  const coverageMap = loadCoverageMap(options.mapPath);

  if (!coverageMap) {
    log(`Coverage map not found at ${options.mapPath}`, verbose, true);
    return {
      runAll: true,
      reason: `Coverage map not found at ${options.mapPath}`,
      tests: [],
      changedFiles: [],
      unmappedFiles: [],
      exitCode: EXIT_CODES.FALLBACK_TRIGGERED,
    };
  }

  log(`Loaded coverage map from ${options.mapPath}`, verbose);
  log(`  Generated: ${coverageMap.generatedAt}`, verbose);
  log(`  Commit: ${coverageMap.commitSha}`, verbose);
  log(`  Tests: ${coverageMap.allTests.length}`, verbose);

  // Check map staleness
  if (isMapStale(coverageMap, options.maxStalenessDays)) {
    log(
      `Coverage map is stale (> ${options.maxStalenessDays} days old)`,
      verbose,
      true
    );
    return {
      runAll: true,
      reason: `Coverage map is stale (> ${options.maxStalenessDays} days old)`,
      tests: [],
      changedFiles: [],
      unmappedFiles: [],
      exitCode: EXIT_CODES.FALLBACK_TRIGGERED,
    };
  }

  // Get changed files
  const changedFiles =
    options.changedFiles ?? getChangedFiles(options.baseRef, options.headRef);

  if (changedFiles.length === 0) {
    log("No changed files detected", verbose, true);
    return {
      runAll: false,
      reason: "No changed files detected",
      tests: [],
      changedFiles: [],
      unmappedFiles: [],
      exitCode: EXIT_CODES.SUCCESS,
    };
  }

  log(`Changed files (${changedFiles.length}):`, verbose);
  for (const file of changedFiles) {
    log(`  ${file}`, verbose);
  }

  // Check for infrastructure files
  const infrastructurePatterns =
    coverageMap.infrastructureFiles || INFRASTRUCTURE_PATTERNS;
  const infrastructureChanges = changedFiles.filter((f) =>
    isInfrastructureFile(f, infrastructurePatterns)
  );

  if (infrastructureChanges.length > 0) {
    log(
      `Infrastructure files changed: ${infrastructureChanges.join(", ")}`,
      verbose,
      true
    );
    return {
      runAll: true,
      reason: `Infrastructure files changed: ${infrastructureChanges.join(", ")}`,
      tests: [],
      changedFiles,
      unmappedFiles: [],
      exitCode: EXIT_CODES.FALLBACK_TRIGGERED,
    };
  }

  // Check for new test files
  const newTests = changedFiles.filter((f) => isNewTestFile(f, coverageMap));
  if (newTests.length > 0) {
    log(`New test files detected: ${newTests.join(", ")}`, verbose, true);
    return {
      runAll: true,
      reason: `New test files detected: ${newTests.join(", ")}`,
      tests: [],
      changedFiles,
      unmappedFiles: [],
      exitCode: EXIT_CODES.FALLBACK_TRIGGERED,
    };
  }

  // Filter to source files only
  const sourceChanges = changedFiles.filter(
    (f) =>
      f.startsWith("src/") &&
      f.endsWith(".ts") &&
      !f.endsWith(".test.ts") &&
      !f.endsWith(".d.ts")
  );

  // Also include test file changes that are in the coverage map
  const testChanges = changedFiles.filter(
    (f) =>
      f.startsWith("tests/integration/") &&
      f.endsWith(".test.ts") &&
      coverageMap.allTests.includes(f)
  );

  // Non-source changes that we can ignore (docs, configs we don't care about, etc.)
  const ignoredPatterns = [
    "docs/**",
    "*.md",
    "*.mdx",
    ".gitignore",
    ".editorconfig",
    "LICENSE",
    ".vscode/**",
    "storybook/**",
    ".storybook/**",
    "*.stories.tsx",
  ];

  const ignoredChanges = changedFiles.filter((f) =>
    ignoredPatterns.some((p) => matchesPattern(f, p))
  );

  // Find unmapped source files
  const unmappedSourceFiles = sourceChanges.filter(
    (f) => !coverageMap.fileToTests[f]
  );

  // If we have unmapped source files that aren't in the map at all, be conservative
  if (unmappedSourceFiles.length > 0) {
    log(
      `Unmapped source files found: ${unmappedSourceFiles.join(", ")}`,
      verbose,
      true
    );
    return {
      runAll: true,
      reason: `Unmapped source files: ${unmappedSourceFiles.join(", ")}`,
      tests: [],
      changedFiles,
      unmappedFiles: unmappedSourceFiles,
      exitCode: EXIT_CODES.FALLBACK_TRIGGERED,
    };
  }

  // Collect all affected tests
  const affectedTests = new Set<string>();

  // Add tests for changed source files
  for (const sourceFile of sourceChanges) {
    const tests = coverageMap.fileToTests[sourceFile] || [];
    for (const test of tests) {
      affectedTests.add(test);
    }
  }

  // Add any changed test files directly
  for (const testFile of testChanges) {
    affectedTests.add(testFile);
  }

  const testsList = Array.from(affectedTests).sort();

  // Check if we have remaining changes that aren't accounted for
  const accountedChanges = new Set([
    ...sourceChanges,
    ...testChanges,
    ...ignoredChanges,
  ]);
  const unaccountedChanges = changedFiles.filter(
    (f) => !accountedChanges.has(f)
  );

  // If there are unaccounted changes that are TypeScript files, be conservative
  const unaccountedTsChanges = unaccountedChanges.filter((f) =>
    f.endsWith(".ts")
  );
  if (unaccountedTsChanges.length > 0) {
    log(
      `Unaccounted TypeScript changes: ${unaccountedTsChanges.join(", ")}`,
      verbose,
      true
    );
    return {
      runAll: true,
      reason: `Unaccounted TypeScript changes: ${unaccountedTsChanges.join(", ")}`,
      tests: [],
      changedFiles,
      unmappedFiles: unaccountedTsChanges,
      exitCode: EXIT_CODES.FALLBACK_TRIGGERED,
    };
  }

  log(`Affected tests (${testsList.length}):`, verbose);
  for (const test of testsList) {
    log(`  ${test}`, verbose);
  }

  return {
    runAll: false,
    reason:
      testsList.length > 0
        ? `Selected ${testsList.length} tests for ${sourceChanges.length} changed source files`
        : "No tests affected by changes",
    tests: testsList,
    changedFiles,
    unmappedFiles: [],
    exitCode: EXIT_CODES.SUCCESS,
  };
}

function formatOutput(
  result: AffectedTestsResult,
  format: "json" | "list" | "jest"
): string {
  switch (format) {
    case "json":
      return JSON.stringify(result, null, 2);
    case "list":
      if (result.runAll) {
        return "ALL";
      }
      return result.tests.join("\n");
    case "jest":
      if (result.runAll) {
        // Return 'tests' to run all integration tests
        return "tests";
      }
      if (result.tests.length === 0) {
        // No tests to run - return a pattern that matches nothing
        return "--testPathPattern=^$";
      }
      // Return test files space-separated for jest CLI
      return result.tests.join(" ");
  }
}

function main(): void {
  const options = parseArgs();
  const result = selectAffectedTests(options);

  // Output the result
  const output = formatOutput(result, options.outputFormat);
  console.log(output);

  // Log summary
  log(`Result: ${result.reason}`, options.verbose, true);
  if (result.runAll) {
    log("Fallback triggered: running all tests", options.verbose, true);
  } else if (result.tests.length > 0) {
    log(
      `Running ${result.tests.length} selected tests`,
      options.verbose,
      true
    );
  } else {
    log("No tests need to run", options.verbose, true);
  }

  process.exit(result.exitCode);
}

main();
