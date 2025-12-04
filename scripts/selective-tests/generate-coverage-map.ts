#!/usr/bin/env bun
/**
 * Generate a coverage map by running each integration test individually
 * and recording which source files it covers.
 *
 * Usage: bun scripts/selective-tests/generate-coverage-map.ts [--output coverage-map.json]
 *
 * This script:
 * 1. Discovers all integration test files
 * 2. Runs each test individually with coverage enabled
 * 3. Parses the coverage output to extract covered files
 * 4. Builds a reverse index: source file → tests that cover it
 * 5. Outputs a JSON coverage map
 */

import { execSync, spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
import type { CoverageMap } from "./types";
import { INFRASTRUCTURE_PATTERNS } from "./types";

// Directories and defaults
const TESTS_DIR = "tests/integration";
const COVERAGE_DIR = "coverage";
const DEFAULT_OUTPUT = "coverage-map.json";

function log(message: string): void {
  console.error(`[generate-coverage-map] ${message}`);
}

function getGitCommitSha(): string {
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf-8" }).trim();
  } catch {
    return "unknown";
  }
}

function hashFiles(files: string[]): string {
  const hash = createHash("sha256");
  for (const file of files.sort()) {
    if (fs.existsSync(file)) {
      hash.update(file);
      hash.update(fs.readFileSync(file));
    }
  }
  return hash.digest("hex").substring(0, 16);
}

function discoverTestFiles(): string[] {
  const testFiles: string[] = [];
  const entries = fs.readdirSync(TESTS_DIR, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".test.ts")) {
      testFiles.push(path.join(TESTS_DIR, entry.name));
    }
  }

  return testFiles.sort();
}

function discoverSourceFiles(): string[] {
  const sourceFiles: string[] = [];

  function walkDir(dir: string): void {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith(".")) {
        walkDir(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".ts")) {
        sourceFiles.push(fullPath);
      }
    }
  }

  walkDir("src");
  return sourceFiles.sort();
}

interface CoverageData {
  [filePath: string]: {
    s: Record<string, number>; // statements
    f?: Record<string, number>; // functions
    b?: Record<string, number[]>; // branches
  };
}

function extractCoveredFiles(coverageJsonPath: string): string[] {
  if (!fs.existsSync(coverageJsonPath)) {
    return [];
  }

  const coverage: CoverageData = JSON.parse(
    fs.readFileSync(coverageJsonPath, "utf-8")
  );
  const coveredFiles: string[] = [];

  for (const [filePath, data] of Object.entries(coverage)) {
    // Check if any statement was executed
    const hasExecutedStatements = Object.values(data.s).some(
      (count) => count > 0
    );
    if (hasExecutedStatements) {
      // Convert absolute path to relative
      const relativePath = path.relative(process.cwd(), filePath);
      if (relativePath.startsWith("src/")) {
        coveredFiles.push(relativePath);
      }
    }
  }

  return coveredFiles;
}

function runTestWithCoverage(testFile: string): string[] {
  // Clean coverage directory first
  if (fs.existsSync(COVERAGE_DIR)) {
    fs.rmSync(COVERAGE_DIR, { recursive: true });
  }

  log(`Running: ${testFile}`);

  const result = spawnSync(
    "bun",
    [
      "x",
      "jest",
      "--coverage",
      "--coverageReporters=json",
      "--maxWorkers=1",
      "--silent",
      "--forceExit",
      testFile,
    ],
    {
      env: {
        ...process.env,
        TEST_INTEGRATION: "1",
        // Disable color output for cleaner logs
        FORCE_COLOR: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5 * 60 * 1000, // 5 minute timeout per test
    }
  );

  if (result.error) {
    log(`  Error running test: ${result.error.message}`);
    return [];
  }

  // Extract covered files from coverage-final.json
  const coverageJsonPath = path.join(COVERAGE_DIR, "coverage-final.json");
  const coveredFiles = extractCoveredFiles(coverageJsonPath);
  log(`  Covered ${coveredFiles.length} source files`);

  return coveredFiles;
}

function buildCoverageMap(
  testFiles: string[],
  sourceFiles: string[]
): CoverageMap {
  const fileToTests: Record<string, string[]> = {};
  const commitSha = getGitCommitSha();
  const sourceHash = hashFiles(sourceFiles);

  // Initialize all source files with empty arrays
  for (const sourceFile of sourceFiles) {
    fileToTests[sourceFile] = [];
  }

  // Run each test and record coverage
  for (let i = 0; i < testFiles.length; i++) {
    const testFile = testFiles[i];
    log(`[${i + 1}/${testFiles.length}] Processing ${testFile}`);

    const coveredFiles = runTestWithCoverage(testFile);

    for (const sourceFile of coveredFiles) {
      if (!fileToTests[sourceFile]) {
        fileToTests[sourceFile] = [];
      }
      if (!fileToTests[sourceFile].includes(testFile)) {
        fileToTests[sourceFile].push(testFile);
      }
    }
  }

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    commitSha,
    sourceHash,
    fileToTests,
    allTests: testFiles,
    infrastructureFiles: INFRASTRUCTURE_PATTERNS,
  };
}

function main(): void {
  const args = process.argv.slice(2);
  let outputPath = DEFAULT_OUTPUT;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--output" && args[i + 1]) {
      outputPath = args[i + 1];
      i++;
    }
  }

  log("Discovering test files...");
  const testFiles = discoverTestFiles();
  log(`Found ${testFiles.length} integration test files`);

  log("Discovering source files...");
  const sourceFiles = discoverSourceFiles();
  log(`Found ${sourceFiles.length} source files`);

  log("Building coverage map (this may take a while)...");
  const coverageMap = buildCoverageMap(testFiles, sourceFiles);

  // Write output
  fs.writeFileSync(outputPath, JSON.stringify(coverageMap, null, 2));
  log(`Coverage map written to ${outputPath}`);

  // Print summary
  const totalMappings = Object.values(coverageMap.fileToTests).reduce(
    (sum, tests) => sum + tests.length,
    0
  );
  const filesWithCoverage = Object.values(coverageMap.fileToTests).filter(
    (tests) => tests.length > 0
  ).length;

  log(`Summary:`);
  log(`  Total test files: ${coverageMap.allTests.length}`);
  log(`  Source files with coverage: ${filesWithCoverage}`);
  log(`  Total file→test mappings: ${totalMappings}`);
}

main();
