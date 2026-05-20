#!/usr/bin/env node
// Collect externalized npm packages and their transitive dependencies into a
// single tarball for use in the Docker runtime stage.
//
// Usage: node scripts/collect-runtime-deps.js <out.tar.gz> <pkg1> [pkg2 ...]
//
// Walks both `dependencies` and `optionalDependencies`. Optional packages that
// are not installed (e.g. wrong-platform sharp binaries) are skipped silently.
// Produces a tarball whose entries are relative to node_modules/, so it can be
// extracted directly into any node_modules/ directory.
"use strict";

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const nodeModules = path.resolve(__dirname, "..", "node_modules");
const [, , outFile, ...roots] = process.argv;

if (!outFile || roots.length === 0) {
  process.stderr.write(
    "Usage: collect-runtime-deps.js <out.tar.gz> <pkg1> [pkg2 ...]\n"
  );
  process.exit(1);
}

const collected = new Set();

function collect(pkgName) {
  if (collected.has(pkgName)) return;
  if (!fs.existsSync(path.join(nodeModules, pkgName))) return; // optional dep not installed
  collected.add(pkgName);

  let pkg;
  try {
    pkg = JSON.parse(
      fs.readFileSync(path.join(nodeModules, pkgName, "package.json"), "utf8")
    );
  } catch {
    return;
  }

  for (const dep of Object.keys(pkg.dependencies ?? {})) collect(dep);
  for (const dep of Object.keys(pkg.optionalDependencies ?? {})) collect(dep);
}

for (const root of roots) {
  collect(root);
}

const packages = [...collected].sort();
process.stdout.write(
  `Archiving ${packages.length} packages → ${outFile}\n`
);

const result = spawnSync("tar", ["czf", outFile, ...packages], {
  cwd: nodeModules,
  stdio: "inherit",
});
process.exit(result.status ?? 1);
