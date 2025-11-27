#!/usr/bin/env node
/**
 * Build script for main process in watch mode
 * Used by nodemon - ignores file arguments passed by nodemon
 */

const { execSync } = require("child_process");
const path = require("path");

const rootDir = path.join(__dirname, "..");
const tsgoPath = path.join(rootDir, "node_modules/@typescript/native-preview/bin/tsgo.js");
const tscAliasPath = path.join(rootDir, "node_modules/tsc-alias/dist/bin/index.js");

try {
  console.log("Building main process...");

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

  console.log("✓ Main process build complete");
} catch (error) {
  console.error("Build failed:", error.message);
  process.exit(1);
}
