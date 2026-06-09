#!/usr/bin/env node
/**
 * Build script for main process in watch mode
 * Used by nodemon - ignores file arguments passed by nodemon
 */

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const rootDir = path.join(__dirname, "..");
const tsgoPath = path.join(rootDir, "node_modules/@typescript/native-preview/bin/tsgo.js");
const tscAliasPath = path.join(rootDir, "node_modules/tsc-alias/dist/bin/index.js");
const buildCompleteStampPath = path.join(rootDir, "dist/.main-build-complete");

try {
  console.log("Building main process...");

  // Re-embed built-in workflow sources first so edits to
  // src/node/builtinWorkflows/*.js hot-reload: tsgo compiles the regenerated
  // builtInWorkflowContent.generated.ts into dist (the .js sources themselves
  // are excluded from the main-process program). No-op when already in sync.
  execSync("bun scripts/gen_builtin_workflows.ts", {
    cwd: rootDir,
    stdio: "inherit",
    env: { ...process.env, NODE_ENV: "development" },
  });

  // Run tsgo
  execSync(`node "${tsgoPath}" -p tsconfig.main.json`, {
    cwd: rootDir,
    stdio: "inherit",
    env: { ...process.env, NODE_ENV: "development" },
  });

  // Run tsc-alias
  execSync(`node "${tscAliasPath}" -p tsconfig.main.json`, {
    cwd: rootDir,
    stdio: "inherit",
    env: { ...process.env, NODE_ENV: "development" },
  });

  // Signal the server watcher only after alias rewriting finishes to avoid
  // restarting against partially rewritten dist output.
  fs.mkdirSync(path.dirname(buildCompleteStampPath), { recursive: true });
  fs.writeFileSync(buildCompleteStampPath, `${Date.now()}\n`);

  console.log("✓ Main process build complete");
} catch (error) {
  console.error("Build failed:", error.message);
  process.exit(1);
}
