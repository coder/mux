import { describe, expect, test } from "bun:test";

import { GlobalExtensionSourceLockSchema, ProjectExtensionSourceLockSchema } from "./sourceLocks";

describe("GlobalExtensionSourceLockSchema", () => {
  test("parses git source locks with resolved SHA, optional subdir, and content hash", () => {
    const parsed = GlobalExtensionSourceLockSchema.parse({
      schemaVersion: 1,
      extensions: {
        "acme-review": {
          source: {
            type: "git",
            url: "https://github.com/acme/mux-extensions.git",
            ref: "main",
            resolvedSha: "0123456789abcdef0123456789abcdef01234567",
            subdir: "extensions/review",
            contentHash: "sha256:abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrstuvwxyz234567",
          },
        },
      },
    });

    expect(parsed.extensions["acme-review"].source.type).toBe("git");
  });

  test("rejects Windows absolute git subdirectories", () => {
    const parsed = GlobalExtensionSourceLockSchema.safeParse({
      schemaVersion: 1,
      extensions: {
        "acme-review": {
          source: {
            type: "git",
            url: "https://github.com/acme/mux-extensions.git",
            ref: "main",
            resolvedSha: "0123456789abcdef0123456789abcdef01234567",
            subdir: "C:\\Users\\alice\\review",
            contentHash: "sha256:abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrstuvwxyz234567",
          },
        },
      },
    });

    expect(parsed.success).toBe(false);
  });

  test("rejects repository lockfiles that try to carry trust or approval state", () => {
    const parsed = GlobalExtensionSourceLockSchema.safeParse({
      schemaVersion: 1,
      rootTrusted: true,
      extensions: {},
    });

    expect(parsed.success).toBe(false);
  });
});

describe("ProjectExtensionSourceLockSchema", () => {
  test("parses vendored project extension source locks", () => {
    const parsed = ProjectExtensionSourceLockSchema.parse({
      schemaVersion: 1,
      extensions: {
        "acme-review": {
          source: {
            type: "vendored",
            path: ".mux/extensions/acme-review",
            contentHash: "sha256:abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrstuvwxyz234567",
          },
        },
      },
    });

    expect(parsed.extensions["acme-review"].source.type).toBe("vendored");
  });

  test("rejects Windows absolute vendored paths", () => {
    const parsed = ProjectExtensionSourceLockSchema.safeParse({
      schemaVersion: 1,
      extensions: {
        "acme-review": {
          source: {
            type: "vendored",
            path: "C:\\Users\\alice\\review",
            contentHash: "sha256:abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrstuvwxyz234567",
          },
        },
      },
    });

    expect(parsed.success).toBe(false);
  });
});
