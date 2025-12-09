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
    "^@/(.*)$": "<rootDir>/src/$1",
    "^chalk$": "<rootDir>/tests/__mocks__/chalk.js",
    "^jsdom$": "<rootDir>/tests/__mocks__/jsdom.js",
  },
  transform: {
    "^.+\\.(ts|tsx|js|mjs)$": ["babel-jest"],
  },
  // Transform ESM modules to CommonJS for Jest
  transformIgnorePatterns: ["node_modules/(?!(@orpc|shiki|json-schema-typed|rou3)/)"],
  // Run tests in parallel (use 50% of available cores, or 4 minimum)
  maxWorkers: "50%",
  // Force exit after tests complete to avoid hanging on lingering handles
  forceExit: true,
  // 10 minute timeout for integration tests, 10s for unit tests
  testTimeout: process.env.TEST_INTEGRATION === "1" ? 600000 : 10000,
  // Detect open handles in development (disabled by default for speed)
  // detectOpenHandles: true,
};
