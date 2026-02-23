/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: "node",
  testMatch: ["<rootDir>/src/**/*.test.ts", "<rootDir>/tests/**/*.test.ts"],
  collectCoverageFrom: [
    "src/**/*.ts",
    "!src/**/*.d.ts",
    "!src/desktop/preload.ts",
    "!src/browser/api.ts",
    "!src/cli/**/*",
    "!src/desktop/main.ts",
  ],
  setupFilesAfterEnv: ["<rootDir>/tests/setup.ts"],
  moduleNameMapper: {
    // Vite query suffixes and binary assets must be matched BEFORE the @/ alias
    "^@/(.+)\\.svg\\?react$": "<rootDir>/tests/__mocks__/svgReactMock.js",
    "^@/(.+)\\.txt\\?raw$": "<rootDir>/tests/__mocks__/textMock.js",
    "^@/(.*)$": "<rootDir>/src/$1",
    // lottie-web probes canvas on import, which crashes in happy-dom/jsdom
    "^lottie-react$": "<rootDir>/tests/__mocks__/lottieReactMock.js",
    "^chalk$": "<rootDir>/tests/__mocks__/chalk.js",
    "^jsdom$": "<rootDir>/tests/__mocks__/jsdom.js",
    // Mock static assets for full App rendering
    "\\.css$": "<rootDir>/tests/__mocks__/styleMock.js",
    "\\.txt$": "<rootDir>/tests/__mocks__/textMock.js",
    "\\.svg$": "<rootDir>/tests/__mocks__/svgMock.js",
  },
  // Avoid haste module collision with vscode extension
  modulePathIgnorePatterns: ["<rootDir>/vscode/"],
  transform: {
    "^.+\\.(ts|tsx|js|mjs)$": ["babel-jest"],
  },
  // Transform ESM-only packages. Use negative lookahead to transform everything
  // EXCEPT known CJS packages, which is more maintainable than listing all ESM packages.
  transformIgnorePatterns: [
    // Transform all node_modules - ESM packages need babel transformation
    // This is slower but ensures compatibility
    "node_modules/(?!\\.pnpm)(?!.*)",
  ],
  // Run tests in parallel (use 50% of available cores, or 4 minimum)
  maxWorkers: "50%",
  // Force exit after tests complete to avoid hanging on lingering handles
  forceExit: true,
  // 10 minute timeout for integration tests, 10s for unit tests
  testTimeout: process.env.TEST_INTEGRATION === "1" ? 600000 : 10000,
};
