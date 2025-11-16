import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { readInstructionSet, gatherInstructionSets } from "./instructionFiles";

describe("instructionFiles", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "instruction-test-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe("readInstructionSet", () => {
    it("should return null when no instruction files exist", async () => {
      const result = await readInstructionSet(tempDir);
      expect(result).toBeNull();
    });

    it("should return base instruction file content", async () => {
      await fs.writeFile(path.join(tempDir, "AGENTS.md"), "base instructions");

      const result = await readInstructionSet(tempDir);
      expect(result).toBe("base instructions");
    });

    it("should append AGENTS.local.md to base instructions", async () => {
      await fs.writeFile(path.join(tempDir, "AGENTS.md"), "base instructions");
      await fs.writeFile(path.join(tempDir, "AGENTS.local.md"), "local overrides");

      const result = await readInstructionSet(tempDir);
      expect(result).toBe("base instructions\n\nlocal overrides");
    });

    it("should work with AGENT.md + AGENTS.local.md", async () => {
      await fs.writeFile(path.join(tempDir, "AGENT.md"), "base content");
      await fs.writeFile(path.join(tempDir, "AGENTS.local.md"), "local content");

      const result = await readInstructionSet(tempDir);
      expect(result).toBe("base content\n\nlocal content");
    });

    it("should work with CLAUDE.md + AGENTS.local.md", async () => {
      await fs.writeFile(path.join(tempDir, "CLAUDE.md"), "base content");
      await fs.writeFile(path.join(tempDir, "AGENTS.local.md"), "local content");

      const result = await readInstructionSet(tempDir);
      expect(result).toBe("base content\n\nlocal content");
    });

    it("should ignore AGENTS.local.md if no base file exists", async () => {
      await fs.writeFile(path.join(tempDir, "AGENTS.local.md"), "local only");

      const result = await readInstructionSet(tempDir);
      expect(result).toBeNull();
    });

    it("should strip markdown comments from instructions", async () => {
      await fs.writeFile(path.join(tempDir, "AGENTS.md"), "<!-- secret -->\nVisible directive");

      const result = await readInstructionSet(tempDir);
      expect(result).toBe("Visible directive");
    });

    it("should return null if stripping comments leaves no content", async () => {
      await fs.writeFile(path.join(tempDir, "AGENTS.md"), "<!-- only comments -->");

      const result = await readInstructionSet(tempDir);
      expect(result).toBeNull();
    });
    it("should prefer AGENTS.md even if AGENT.md and AGENTS.local.md exist", async () => {
      await fs.writeFile(path.join(tempDir, "AGENTS.md"), "agents base");
      await fs.writeFile(path.join(tempDir, "AGENT.md"), "agent base");
      await fs.writeFile(path.join(tempDir, "AGENTS.local.md"), "local");

      const result = await readInstructionSet(tempDir);
      expect(result).toBe("agents base\n\nlocal");
    });
  });

  describe("gatherInstructionSets", () => {
    it("should return empty array when no instructions exist", async () => {
      const dir1 = path.join(tempDir, "dir1");
      const dir2 = path.join(tempDir, "dir2");
      await fs.mkdir(dir1);
      await fs.mkdir(dir2);

      const result = await gatherInstructionSets([dir1, dir2]);
      expect(result).toEqual([]);
    });

    it("should gather instructions from multiple directories", async () => {
      const dir1 = path.join(tempDir, "dir1");
      const dir2 = path.join(tempDir, "dir2");
      await fs.mkdir(dir1);
      await fs.mkdir(dir2);

      await fs.writeFile(path.join(dir1, "AGENTS.md"), "global instructions");
      await fs.writeFile(path.join(dir2, "AGENTS.md"), "workspace instructions");

      const result = await gatherInstructionSets([dir1, dir2]);
      expect(result).toEqual(["global instructions", "workspace instructions"]);
    });

    it("should include local files in gathered instructions", async () => {
      const dir1 = path.join(tempDir, "dir1");
      const dir2 = path.join(tempDir, "dir2");
      await fs.mkdir(dir1);
      await fs.mkdir(dir2);

      await fs.writeFile(path.join(dir1, "AGENTS.md"), "global base");
      await fs.writeFile(path.join(dir1, "AGENTS.local.md"), "global local");
      await fs.writeFile(path.join(dir2, "AGENTS.md"), "workspace base");
      await fs.writeFile(path.join(dir2, "AGENTS.local.md"), "workspace local");

      const result = await gatherInstructionSets([dir1, dir2]);
      expect(result).toEqual(["global base\n\nglobal local", "workspace base\n\nworkspace local"]);
    });

    it("should skip directories without instruction files", async () => {
      const dir1 = path.join(tempDir, "dir1");
      const dir2 = path.join(tempDir, "dir2");
      const dir3 = path.join(tempDir, "dir3");
      await fs.mkdir(dir1);
      await fs.mkdir(dir2);
      await fs.mkdir(dir3);

      await fs.writeFile(path.join(dir1, "AGENTS.md"), "dir1 content");
      await fs.writeFile(path.join(dir3, "AGENTS.md"), "dir3 content");
      // dir2 has no instruction files

      const result = await gatherInstructionSets([dir1, dir2, dir3]);
      expect(result).toEqual(["dir1 content", "dir3 content"]);
    });
  });
});
