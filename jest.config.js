module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  testMatch: ["<rootDir>/src/**/*.test.ts", "<rootDir>/tests/**/*.test.ts"],
  collectCoverageFrom: [
    "src/**/*.ts",
    "!src/**/*.d.ts",
    "!src/browser/**/*.ts",
    "!src/cli/**/*.ts",
    "!src/desktop/preload.ts",
    "!src/desktop/main.ts",
  ],
  setupFilesAfterEnv: ["<rootDir>/tests/setup.ts"],
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/src/$1",
    "^chalk$": "<rootDir>/tests/__mocks__/chalk.js",
  },
  transform: {
    "^.+\\.tsx?$": [
      "ts-jest",
      {
        tsconfig: {
          target: "ES2020",
          module: "ESNext",
          moduleResolution: "node",
          lib: ["ES2020", "DOM", "ES2022.Intl"],
          esModuleInterop: true,
          allowSyntheticDefaultImports: true,
        },
      },
    ],
  },
  // Transform ESM modules (like shiki) to CommonJS for Jest
  transformIgnorePatterns: ["node_modules/(?!(shiki)/)"],
  // Run tests in parallel (use 50% of available cores, or 4 minimum)
  maxWorkers: "50%",
  // Force exit after tests complete to avoid hanging on lingering handles
  forceExit: true,
  // Detect open handles in development (disabled by default for speed)
  // detectOpenHandles: true,
};
