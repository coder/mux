#!/usr/bin/env node

/**
 * Patch package.json version in CI.
 *
 * Shared by release workflows so nightly/release builds stay in sync without
 * copy-pasting inline Node snippets in multiple jobs.
 */
const fs = require("node:fs");

const nextVersion = process.argv[2];
if (!nextVersion || typeof nextVersion !== "string" || nextVersion.trim().length === 0) {
  console.error("Usage: node ./scripts/set-package-version.js <version>");
  process.exit(1);
}

const packageJsonPath = "package.json";
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
packageJson.version = nextVersion.trim();
fs.writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);

console.log(`Set package.json version to ${packageJson.version}`);
