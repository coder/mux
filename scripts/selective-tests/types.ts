/**
 * Types for the selective test filtering system.
 *
 * This system uses runtime coverage data to determine which integration tests
 * need to run based on changed source files.
 */

/** Coverage map: source file → list of test files that cover it */
export interface CoverageMap {
  version: 1;
  generatedAt: string;
  /** Git commit SHA when the map was generated */
  commitSha: string;
  /** Hash of all source files for staleness detection */
  sourceHash: string;
  /** Map from relative source file path to array of test file paths */
  fileToTests: Record<string, string[]>;
  /** List of all test files included in the map */
  allTests: string[];
  /** Files that are considered "infrastructure" - changes trigger all tests */
  infrastructureFiles: string[];
}

/** Result from the affected tests selection */
export interface AffectedTestsResult {
  /** Whether to run all tests (fallback triggered) */
  runAll: boolean;
  /** Reason for the decision */
  reason: string;
  /** List of test files to run (empty if runAll) */
  tests: string[];
  /** Changed files that triggered the selection */
  changedFiles: string[];
  /** Files that were not found in the coverage map */
  unmappedFiles: string[];
}

/** Exit codes for scripts */
export const EXIT_CODES = {
  SUCCESS: 0,
  FALLBACK_TRIGGERED: 2,
  ERROR: 1,
} as const;

/** Infrastructure files that should trigger all tests when changed */
export const INFRASTRUCTURE_PATTERNS = [
  // Core configuration
  "jest.config.cjs",
  "babel.config.cjs",
  "tsconfig.json",
  "tsconfig.*.json",
  "package.json",
  "bun.lockb",

  // Test infrastructure
  "tests/setup.ts",
  "tests/integration/helpers.ts",
  "tests/__mocks__/**",

  // Service container (imports all services)
  "src/node/services/serviceContainer.ts",

  // Core shared types
  "src/types/**",
  "src/constants/**",

  // Build configuration
  "vite.*.ts",
  "electron-builder.yml",

  // CI configuration
  ".github/workflows/**",
  ".github/actions/**",

  // This selective test system itself
  "scripts/selective-tests/**",
];
