import * as os from "os";
import * as path from "path";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { discoverExtensions } from "./discovery";

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, JSON.stringify(value, null, 2), "utf-8");
}

describe("discoverExtensions", () => {
  it("discovers .js file extensions and folder extensions with manifest.json", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "mux-ext-discovery-"));
    try {
      const extDir = path.join(tempRoot, "ext");
      await mkdir(extDir, { recursive: true });

      // File extension
      await writeFile(
        path.join(extDir, "a-file.js"),
        "module.exports = { onPostToolUse() {} };\n",
        "utf-8"
      );

      // Folder extension
      const folderExtDir = path.join(extDir, "b-folder");
      await mkdir(folderExtDir, { recursive: true });
      await writeJson(path.join(folderExtDir, "manifest.json"), { entrypoint: "index.js" });
      await writeFile(
        path.join(folderExtDir, "index.js"),
        "module.exports = { onPostToolUse() {} };\n",
        "utf-8"
      );

      // Invalid: missing entrypoint
      const missingEntrypointDir = path.join(extDir, "c-missing");
      await mkdir(missingEntrypointDir, { recursive: true });
      await writeJson(path.join(missingEntrypointDir, "manifest.json"), { entrypoint: "nope.js" });

      // Invalid: non-js file
      await writeFile(path.join(extDir, "not-js.txt"), "nope", "utf-8");

      const result = await discoverExtensions(extDir);
      expect(result.map((e) => e.id)).toEqual(["a-file", "b-folder"]);
      expect(result[0]?.type).toBe("file");
      expect(result[1]?.type).toBe("folder");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("returns [] if extension directory does not exist", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "mux-ext-missing-"));
    try {
      const missingExtDir = path.join(tempRoot, "does-not-exist");
      const result = await discoverExtensions(missingExtDir);
      expect(result).toEqual([]);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
