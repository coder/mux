import { describe, expect, test } from "bun:test";

import { extractStaticManifestFromSource } from "./staticManifestExtractor";

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
});
