import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import { describe, expect, test } from "bun:test";

import { runExtensionsCommand, runInstallAliasCommand } from "./extensions";

describe("mux extensions", () => {
  test("prints extension command help", async () => {
    const writes: string[] = [];
    const result = await runExtensionsCommand({
      args: ["--help"],
      write: (chunk) => writes.push(chunk),
    });

    expect(result).toEqual({ type: "help" });
    expect(writes.join("")).toContain("Usage: mux extensions");
  });
});

describe("mux extensions install", () => {
  test("prints install help without installing", async () => {
    const writes: string[] = [];
    const result = await runExtensionsCommand({
      args: ["install", "--help"],
      write: (chunk) => writes.push(chunk),
      install: () => {
        throw new Error("install should not run for help");
      },
    });

    expect(result).toEqual({ type: "help" });
    expect(writes.join("")).toContain("Usage: mux extensions install");
  });

  test("installs a git coordinate into the configured Mux root and prints JSON", async () => {
    const writes: string[] = [];
    const result = await runExtensionsCommand({
      args: ["install", "/repo//ext@main"],
      muxRootDir: "/tmp/mux-home",
      write: (chunk) => writes.push(chunk),
      install: (input) =>
        Promise.resolve({
          extensionName: "acme-review",
          resolvedSha: "a".repeat(40),
          contentHash: "sha256:abc1234567890123456789012345678901234567890",
          storePath: `${input.muxRootDir}/extensions/store/hash`,
          activePath: `${input.muxRootDir}/extensions/global/acme-review`,
        }),
    });

    expect(result).toEqual({
      extensionName: "acme-review",
      resolvedSha: "a".repeat(40),
      contentHash: "sha256:abc1234567890123456789012345678901234567890",
      storePath: "/tmp/mux-home/extensions/store/hash",
      activePath: "/tmp/mux-home/extensions/global/acme-review",
    });
    expect(JSON.parse(writes.join(""))).toEqual(result);
  });
});

describe("mux install", () => {
  test("prints alias help without installing", async () => {
    const writes: string[] = [];
    const result = await runInstallAliasCommand({
      args: ["--help"],
      write: (chunk) => writes.push(chunk),
      install: () => {
        throw new Error("install should not run for help");
      },
    });

    expect(result).toEqual({ type: "help" });
    expect(writes.join("")).toContain("Usage: mux install");
  });

  test("aliases mux extensions install", async () => {
    const writes: string[] = [];
    const result = await runInstallAliasCommand({
      args: ["/repo//ext@main"],
      muxRootDir: "/tmp/mux-home",
      write: (chunk) => writes.push(chunk),
      install: (input) =>
        Promise.resolve({
          extensionName: "acme-review",
          resolvedSha: "b".repeat(40),
          contentHash: "sha256:def1234567890123456789012345678901234567890",
          storePath: `${input.muxRootDir}/extensions/store/hash`,
          activePath: `${input.muxRootDir}/extensions/global/acme-review`,
        }),
    });

    expect(result).toEqual({
      extensionName: "acme-review",
      resolvedSha: "b".repeat(40),
      contentHash: "sha256:def1234567890123456789012345678901234567890",
      storePath: "/tmp/mux-home/extensions/store/hash",
      activePath: "/tmp/mux-home/extensions/global/acme-review",
    });
    expect(JSON.parse(writes.join(""))).toEqual(result);
  });
});

describe("mux extensions create", () => {
  test("prints create help without scaffolding", async () => {
    const writes: string[] = [];
    const result = await runExtensionsCommand({
      args: ["create", "--help"],
      write: (chunk) => writes.push(chunk),
    });

    expect(result).toEqual({ type: "help" });
    expect(writes.join("")).toContain("Usage: mux extensions create");
  });

  test("rejects reserved first-party extension names", async () => {
    const muxRootDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-extensions-create-reserved-"));
    try {
      let error: unknown;
      try {
        await runExtensionsCommand({
          args: ["create", "mux-platform-demo"],
          muxRootDir,
        });
      } catch (err) {
        error = err;
      }
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/reserved first-party namespace/);

      let statError: unknown;
      try {
        await fs.stat(path.join(muxRootDir, "extensions", "local", "mux-platform-demo"));
      } catch (err) {
        statError = err;
      }
      expect(statError).toBeInstanceOf(Error);
    } finally {
      await fs.rm(muxRootDir, { recursive: true, force: true });
    }
  });

  test("scaffolds an editable local Extension Module", async () => {
    const muxRootDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-extensions-create-"));
    try {
      const writes: string[] = [];
      const result = await runExtensionsCommand({
        args: ["create", "acme-review"],
        muxRootDir,
        write: (chunk) => writes.push(chunk),
      });

      expect(result).toEqual({
        extensionName: "acme-review",
        modulePath: path.join(muxRootDir, "extensions", "local", "acme-review"),
        entrypointPath: path.join(muxRootDir, "extensions", "local", "acme-review", "extension.ts"),
        skillPath: path.join(
          muxRootDir,
          "extensions",
          "local",
          "acme-review",
          "skills",
          "acme-review",
          "SKILL.md"
        ),
      });
      expect(JSON.parse(writes.join(""))).toEqual(result);
      if (!("entrypointPath" in result)) throw new Error("expected create result");
      const entrypointStat = await fs.stat(result.entrypointPath);
      expect(entrypointStat.isFile()).toBe(true);
      const entrypoint = await fs.readFile(result.entrypointPath, "utf-8");
      expect(entrypoint).toContain('name: "acme-review"');
      expect(entrypoint).toContain('bodyPath: "./skills/acme-review/SKILL.md"');
      const skill = await fs.readFile(result.skillPath, "utf-8");
      expect(skill).toContain("name: acme-review");
    } finally {
      await fs.rm(muxRootDir, { recursive: true, force: true });
    }
  });
});
