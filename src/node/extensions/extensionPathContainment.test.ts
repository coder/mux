import * as fs from "node:fs/promises";
import * as path from "node:path";

import { describe, expect, test } from "@jest/globals";

import { TestTempDir } from "@/node/services/tools/testHelpers";

import { ensureExtensionPathContained } from "./extensionPathContainment";

describe("ensureExtensionPathContained — relative-only enforcement", () => {
  test("resolves a simple relative path that exists inside the package", async () => {
    using tempDir = new TestTempDir("ext-path-contain");
    const pkg = path.join(tempDir.path, "ext");
    await fs.mkdir(pkg, { recursive: true });
    const target = path.join(pkg, "SKILL.md");
    await fs.writeFile(target, "# skill");

    const result = await ensureExtensionPathContained(pkg, "SKILL.md");

    expect(result.normalizedRelativePath).toBe("SKILL.md");
    expect(result.resolvedPath).toBe(target);
    expect(result.realPath).toBe(await fs.realpath(target));
  });

  test("rejects an absolute Unix-style path", async () => {
    using tempDir = new TestTempDir("ext-path-contain");
    const pkg = path.join(tempDir.path, "ext");
    await fs.mkdir(pkg, { recursive: true });

    await expect(ensureExtensionPathContained(pkg, "/etc/passwd")).rejects.toThrow(
      /must be relative/iu
    );
  });

  test("rejects a Windows-drive absolute path", async () => {
    using tempDir = new TestTempDir("ext-path-contain");
    const pkg = path.join(tempDir.path, "ext");
    await fs.mkdir(pkg, { recursive: true });

    await expect(ensureExtensionPathContained(pkg, "C:/foo")).rejects.toThrow(/must be relative/iu);
  });

  test("rejects a tilde-prefixed home path", async () => {
    using tempDir = new TestTempDir("ext-path-contain");
    const pkg = path.join(tempDir.path, "ext");
    await fs.mkdir(pkg, { recursive: true });

    await expect(ensureExtensionPathContained(pkg, "~/secret")).rejects.toThrow(
      /must be relative/iu
    );
  });

  test("rejects an empty path", async () => {
    using tempDir = new TestTempDir("ext-path-contain");
    const pkg = path.join(tempDir.path, "ext");
    await fs.mkdir(pkg, { recursive: true });

    await expect(ensureExtensionPathContained(pkg, "")).rejects.toThrow(/required/iu);
  });
});

describe("ensureExtensionPathContained — traversal rejection", () => {
  test("rejects a leading-dotdot path", async () => {
    using tempDir = new TestTempDir("ext-path-contain");
    const pkg = path.join(tempDir.path, "ext");
    await fs.mkdir(pkg, { recursive: true });

    await expect(ensureExtensionPathContained(pkg, "../sibling")).rejects.toThrow(/traversal/iu);
  });

  test("rejects an embedded-dotdot path that escapes root after normalization", async () => {
    using tempDir = new TestTempDir("ext-path-contain");
    const pkg = path.join(tempDir.path, "ext");
    await fs.mkdir(pkg, { recursive: true });

    await expect(ensureExtensionPathContained(pkg, "skills/../../escape")).rejects.toThrow(
      /traversal/iu
    );
  });

  test("rejects a bare-dotdot path", async () => {
    using tempDir = new TestTempDir("ext-path-contain");
    const pkg = path.join(tempDir.path, "ext");
    await fs.mkdir(pkg, { recursive: true });

    await expect(ensureExtensionPathContained(pkg, "..")).rejects.toThrow(/traversal/iu);
  });
});

describe("ensureExtensionPathContained — internal-symlink rejection", () => {
  test("rejects when the leaf file is a symlink (even if the link points inside the package)", async () => {
    using tempDir = new TestTempDir("ext-path-contain");
    const pkg = path.join(tempDir.path, "ext");
    await fs.mkdir(pkg, { recursive: true });
    const realFile = path.join(pkg, "real.md");
    await fs.writeFile(realFile, "# real");
    const linkFile = path.join(pkg, "alias.md");
    await fs.symlink(realFile, linkFile);

    await expect(ensureExtensionPathContained(pkg, "alias.md")).rejects.toThrow(/symlink/iu);
  });

  test("rejects when an intermediate directory along the path is a symlink", async () => {
    using tempDir = new TestTempDir("ext-path-contain");
    const pkg = path.join(tempDir.path, "ext");
    await fs.mkdir(pkg, { recursive: true });
    const realDir = path.join(pkg, "real-dir");
    await fs.mkdir(realDir, { recursive: true });
    await fs.writeFile(path.join(realDir, "body.md"), "# body");
    const linkDir = path.join(pkg, "link-dir");
    await fs.symlink(realDir, linkDir);

    await expect(ensureExtensionPathContained(pkg, "link-dir/body.md")).rejects.toThrow(
      /symlink/iu
    );
  });

  test("does not lstat the leaf when allowMissingLeaf is set and the leaf does not exist", async () => {
    using tempDir = new TestTempDir("ext-path-contain");
    const pkg = path.join(tempDir.path, "ext");
    await fs.mkdir(pkg, { recursive: true });

    const result = await ensureExtensionPathContained(pkg, "future.md", {
      allowMissingLeaf: true,
    });
    expect(result.normalizedRelativePath).toBe("future.md");
  });

  test("rejects when an existing intermediate dir is a symlink even with allowMissingLeaf", async () => {
    using tempDir = new TestTempDir("ext-path-contain");
    const pkg = path.join(tempDir.path, "ext");
    await fs.mkdir(pkg, { recursive: true });
    const realDir = path.join(pkg, "real-dir");
    await fs.mkdir(realDir, { recursive: true });
    const linkDir = path.join(pkg, "link-dir");
    await fs.symlink(realDir, linkDir);

    await expect(
      ensureExtensionPathContained(pkg, "link-dir/missing.md", { allowMissingLeaf: true })
    ).rejects.toThrow(/symlink/iu);
  });
});

describe("ensureExtensionPathContained — realpath containment with allow-missing-leaf", () => {
  test("rejects without allowMissingLeaf when leaf does not exist", async () => {
    using tempDir = new TestTempDir("ext-path-contain");
    const pkg = path.join(tempDir.path, "ext");
    await fs.mkdir(pkg, { recursive: true });

    await expect(ensureExtensionPathContained(pkg, "ghost.md")).rejects.toThrow();
  });

  test("accepts a deep nested path under existing real directories", async () => {
    using tempDir = new TestTempDir("ext-path-contain");
    const pkg = path.join(tempDir.path, "ext");
    const nested = path.join(pkg, "skills", "intro");
    await fs.mkdir(nested, { recursive: true });
    await fs.writeFile(path.join(nested, "SKILL.md"), "# intro");

    const result = await ensureExtensionPathContained(pkg, "skills/intro/SKILL.md");
    expect(result.normalizedRelativePath).toBe("skills/intro/SKILL.md");
  });

  test("accepts a missing leaf with allowMissingLeaf even under an existing nested dir", async () => {
    using tempDir = new TestTempDir("ext-path-contain");
    const pkg = path.join(tempDir.path, "ext");
    const nested = path.join(pkg, "skills", "intro");
    await fs.mkdir(nested, { recursive: true });

    const result = await ensureExtensionPathContained(pkg, "skills/intro/SKILL.md", {
      allowMissingLeaf: true,
    });
    expect(result.normalizedRelativePath).toBe("skills/intro/SKILL.md");
    expect(result.resolvedPath).toBe(path.join(nested, "SKILL.md"));
  });
});
