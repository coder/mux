import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import { realpathOpenedFile } from "./openedFileRealpath";

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-opened-file-realpath-"));
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe("realpathOpenedFile", () => {
  test("uses stat identity fallback on Windows when descriptor namespaces are unavailable", async () => {
    const filePath = path.join(tempDir, "file.txt");
    await fs.writeFile(filePath, "safe", "utf-8");
    const handle = await fs.open(filePath, "r");
    const originalRealpath = fs.realpath;
    const realpathSpy = spyOn(fs, "realpath");
    realpathSpy.mockImplementation((async (target: Parameters<typeof fs.realpath>[0]) => {
      const targetPath = String(target);
      if (targetPath.startsWith("/proc/self/fd/") || targetPath.startsWith("/dev/fd/")) {
        throw new Error("fd namespace unavailable");
      }
      return originalRealpath(target);
    }) as typeof fs.realpath);

    try {
      const result = await realpathOpenedFile(handle, filePath, "win32");
      expect(result).toBe(await originalRealpath(filePath));
    } finally {
      realpathSpy.mockRestore();
      await handle.close();
    }
  });

  test("fails closed when the opened file descriptor cannot be canonicalized", async () => {
    const filePath = path.join(tempDir, "file.txt");
    await fs.writeFile(filePath, "safe", "utf-8");
    const handle = await fs.open(filePath, "r");
    const originalRealpath = fs.realpath;
    const realpathSpy = spyOn(fs, "realpath");
    realpathSpy.mockImplementation((async (target: Parameters<typeof fs.realpath>[0]) => {
      const targetPath = String(target);
      if (targetPath.startsWith("/proc/self/fd/") || targetPath.startsWith("/dev/fd/")) {
        throw new Error("fd namespace unavailable");
      }
      return originalRealpath(target);
    }) as typeof fs.realpath);

    try {
      let error: unknown;
      try {
        await realpathOpenedFile(handle, filePath);
      } catch (err) {
        error = err;
      }
      expect(error).toBeInstanceOf(Error);
      expect(error instanceof Error ? error.message : "").toMatch(/opened file descriptor/i);
    } finally {
      realpathSpy.mockRestore();
      await handle.close();
    }
  });
});
