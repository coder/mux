const { getJestConfig } = require("@storybook/test-runner");

const testRunnerConfig = getJestConfig();

/** @type {import("@jest/types").Config.InitialOptions} */
module.exports = {
  // The default Jest configuration comes from @storybook/test-runner.
  ...testRunnerConfig,
  modulePathIgnorePatterns: [
    ...(testRunnerConfig.modulePathIgnorePatterns ?? []),
    // Keep Storybook tests focused on the main app package; the VS Code extension
    // has a second package.json with the same name that trips Jest's haste map.
    "<rootDir>/vscode/",
  ],
};
