import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import { describe, expect, test } from "bun:test";

import {
  extractStaticManifestFromFile,
  extractStaticManifestFromSource,
} from "./staticManifestExtractor";

const NOW = 1_700_000_000_000;

describe("extractStaticManifestFromSource", () => {
  test("extracts a defineManifest object without executing extension code", () => {
    const result = extractStaticManifestFromSource(
      `
        import { defineManifest } from "mux:extensions";
        throw new Error("must not execute");
        export const manifest = defineManifest({
          name: "acme-review",
          displayName: "Acme Review",
          description: "Review helpers",
          capabilities: { skills: true },
        });
      `,
      "extension.ts",
      NOW
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest).toEqual({
      name: "acme-review",
      displayName: "Acme Review",
      description: "Review helpers",
      capabilities: { skills: true },
    });
  });

  test("extracts literal arrays in static manifests", () => {
    const result = extractStaticManifestFromSource(
      `
        export const manifest = {
          name: "acme-review",
          capabilities: { skills: true },
          requestedPermissions: ["network", "filesystem"],
        };
      `,
      "extension.ts",
      NOW
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.requestedPermissions).toEqual(["network", "filesystem"]);
  });

  test("rejects __proto__ static manifest properties", () => {
    const result = extractStaticManifestFromSource(
      `
        export const manifest = {
          __proto__: { name: "polluted" },
          name: "acme-review",
          capabilities: { skills: true },
        };
      `,
      "extension.ts",
      NOW
    );

    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]).toMatchObject({
      code: "manifest.static.unsupported",
      occurredAt: NOW,
    });
    expect(result.diagnostics[0].message).toContain("__proto__");
  });

  test("rejects dynamic manifest values", () => {
    const result = extractStaticManifestFromSource(
      `
        const name = "acme-review";
        export const manifest = defineManifest({ name, capabilities: { skills: true } });
      `,
      "extension.ts",
      NOW
    );

    expect(result.ok).toBe(false);
    expect(
      result.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === "manifest.static.unsupported" && diagnostic.occurredAt === NOW
      )
    ).toBe(true);
  });

  test("requires an exported manifest binding", () => {
    const result = extractStaticManifestFromSource(
      `const manifest = { name: "acme-review" };`,
      "extension.ts",
      NOW
    );

    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]).toMatchObject({ code: "manifest.static.missing" });
  });

  test("rejects non-regular manifest files before reading", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-static-manifest-"));
    const entrypointPath = path.join(tempDir, "extension.ts");
    try {
      await fs.mkdir(entrypointPath);

      const result = await extractStaticManifestFromFile(entrypointPath, NOW);

      expect(result.ok).toBe(false);
      expect(result.diagnostics[0]).toMatchObject({
        code: "extension.entrypoint.read_failed",
        occurredAt: NOW,
      });
      expect(result.diagnostics[0].message).toContain("regular file");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
