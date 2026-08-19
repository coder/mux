import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

describe("web_fetch server bundle", () => {
  it("loads from outside the repository without runtime asset reads", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "mux-web-fetch-bundle-"));
    const bundlePath = join(tempDir, "web_fetch.bundle.js");

    try {
      const bundleResult = spawnSync(
        "bun",
        [
          "x",
          "esbuild",
          resolve("src/node/services/tools/web_fetch.ts"),
          "--bundle",
          "--platform=node",
          "--target=node22",
          "--format=cjs",
          `--outfile=${bundlePath}`,
          "--external:@lydell/node-pty",
          "--external:node-pty",
          "--external:electron",
          "--external:ssh2",
          "--alias:jsonc-parser=jsonc-parser/lib/esm/main.js",
        ],
        { encoding: "utf8" }
      );
      expect(bundleResult.status, bundleResult.stderr).toBe(0);

      // Guards against module-eval-time runtime asset reads such as issue #3699's stylesheet failure.
      const loadResult = spawnSync(
        "node",
        [
          "-e",
          `const exports = require(${JSON.stringify(bundlePath)}); if (typeof exports.createWebFetchTool !== "function") process.exit(1);`,
        ],
        { cwd: tempDir, encoding: "utf8" }
      );
      expect(loadResult.status, loadResult.stderr).toBe(0);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 30_000);
});
