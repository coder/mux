// Shared config for all test projects
const sharedConfig = {
  moduleNameMapper: {
    "\\.(css|less|scss|sass)$": "<rootDir>/tests/__mocks__/styleMock.js",
    "^@/version$": "<rootDir>/tests/__mocks__/version.js",
    // Mock SVG imports with ?react query (vite-plugin-svgr)
    "\\.svg\\?react$": "<rootDir>/tests/__mocks__/svgMock.js",
    // Mock modules that use import.meta.url (Workers)
    ".*/highlightWorkerClient$": "<rootDir>/tests/__mocks__/highlightWorkerClient.js",
    "^@/(.*)$": "<rootDir>/src/$1",
    "^chalk$": "<rootDir>/tests/__mocks__/chalk.js",
    "^jsdom$": "<rootDir>/tests/__mocks__/jsdom.js",
  },
  transform: {
    "^.+\\.(ts|tsx|js|mjs)$": ["babel-jest"],
  },
  // Transform ESM modules to CommonJS for Jest
  // The markdown ecosystem has hundreds of ESM-only packages, so we transform
  // everything except known-safe CJS packages
  transformIgnorePatterns: [
    // Transform everything in node_modules (empty pattern = transform all)
    // This is necessary because the unified/remark/rehype ecosystem has
    // 100+ ESM-only packages that would each need to be listed
    "^$",
  ],
};

module.exports = {
  projects: [
    // Node environment tests (default - existing tests)
    {
      ...sharedConfig,
      displayName: "node",
      testEnvironment: "node",
      testMatch: [
        "<rootDir>/src/**/*.test.ts",
        "<rootDir>/tests/ipc/**/*.test.ts",
        "<rootDir>/tests/runtime/**/*.test.ts",
        "<rootDir>/tests/*.test.ts",
      ],
      setupFilesAfterEnv: ["<rootDir>/tests/setup.ts"],
    },
    // Browser backend integration tests (node environment, real oRPC)
    {
      ...sharedConfig,
      displayName: "browser",
      testEnvironment: "node",
      testMatch: ["<rootDir>/tests/browser/**/*.test.ts"],
      setupFilesAfterEnv: ["<rootDir>/tests/setup.ts"],
    },
    // Browser UI tests (jsdom environment) - for future use
    {
      ...sharedConfig,
      displayName: "browser-ui",
      testEnvironment: "jsdom",
      testMatch: ["<rootDir>/tests/browser/**/*.test.tsx"],
      setupFiles: ["<rootDir>/tests/browser/global-setup.js"],
      setupFilesAfterEnv: ["<rootDir>/tests/setup.ts"],
    },
  ],
  collectCoverageFrom: [
    "src/**/*.ts",
    "!src/**/*.d.ts",
    "!src/desktop/preload.ts",
    "!src/browser/api.ts",
    "!src/cli/**/*",
    "!src/desktop/main.ts",
  ],
  // Run tests in parallel (use 50% of available cores, or 4 minimum)
  maxWorkers: "50%",
  // Force exit after tests complete to avoid hanging on lingering handles
  forceExit: true,
  // 10 minute timeout for integration tests, 10s for unit tests
  testTimeout: process.env.TEST_INTEGRATION === "1" ? 600000 : 10000,
  // Detect open handles in development (disabled by default for speed)
  // detectOpenHandles: true,
};
