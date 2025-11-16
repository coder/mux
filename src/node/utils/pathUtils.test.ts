import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { expandTilde, validateProjectPath } from "./pathUtils";

describe("pathUtils", () => {
  describe("expandTilde", () => {
    it("should expand ~ to home directory", () => {
      const result = expandTilde("~/Documents");
      const expected = path.join(os.homedir(), "Documents");
      expect(result).toBe(expected);
    });

    it("should expand ~/ to home directory with trailing path", () => {
      const result = expandTilde("~/Projects/my-app");
      const expected = path.join(os.homedir(), "Projects", "my-app");
      expect(result).toBe(expected);
    });

    it("should return path unchanged if it doesn't start with ~", () => {
      const testPath = "/absolute/path/to/project";
      const result = expandTilde(testPath);
      expect(result).toBe(testPath);
    });

    it("should handle ~ alone (home directory)", () => {
      const result = expandTilde("~");
      expect(result).toBe(os.homedir());
    });

    it("should handle relative paths without tilde", () => {
      const relativePath = "relative/path";
      const result = expandTilde(relativePath);
      expect(result).toBe(relativePath);
    });

    it("should handle empty string", () => {
      const result = expandTilde("");
      expect(result).toBe("");
    });
  });

  describe("validateProjectPath", () => {
    let tempDir: string;

    beforeEach(() => {
      // Create a temporary directory for testing
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmux-path-test-"));
    });

    afterEach(() => {
      // Clean up temporary directory
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it("should return success for existing git directory", async () => {
      // Create .git directory
      // eslint-disable-next-line local/no-sync-fs-methods -- Test setup only
      fs.mkdirSync(path.join(tempDir, ".git"));
      const result = await validateProjectPath(tempDir);
      expect(result.valid).toBe(true);
      expect(result.expandedPath).toBe(tempDir);
      expect(result.error).toBeUndefined();
    });

    it("should expand tilde and validate", async () => {
      // Create a test directory in home with .git
      const testDir = path.join(os.homedir(), `cmux-test-git-${Date.now()}`);
      // eslint-disable-next-line local/no-sync-fs-methods -- Test setup only
      fs.mkdirSync(testDir, { recursive: true });
      // eslint-disable-next-line local/no-sync-fs-methods -- Test setup only
      fs.mkdirSync(path.join(testDir, ".git"));

      const result = await validateProjectPath(`~/${path.basename(testDir)}`);
      expect(result.valid).toBe(true);
      expect(result.expandedPath).toBe(testDir);
      expect(result.error).toBeUndefined();

      // Cleanup
      fs.rmSync(testDir, { recursive: true, force: true });
    });

    it("should return error for non-existent path", async () => {
      const nonExistentPath = "/this/path/definitely/does/not/exist/cmux-test-12345";
      const result = await validateProjectPath(nonExistentPath);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("does not exist");
    });

    it("should return error for file path (not directory)", async () => {
      const filePath = path.join(tempDir, "test-file.txt");
      // eslint-disable-next-line local/no-sync-fs-methods -- Test setup only
      fs.writeFileSync(filePath, "test content");

      const result = await validateProjectPath(filePath);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("not a directory");
    });

    it("should handle tilde path to non-existent directory", async () => {
      const nonExistentTildePath = "~/this-directory-should-not-exist-cmux-test-12345";
      const result = await validateProjectPath(nonExistentTildePath);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("does not exist");
    });

    it("should return normalized absolute path", async () => {
      const pathWithDots = path.join(tempDir, "..", path.basename(tempDir));
      // Add .git directory for validation
      // eslint-disable-next-line local/no-sync-fs-methods -- Test setup only
      fs.mkdirSync(path.join(tempDir, ".git"));
      const result = await validateProjectPath(pathWithDots);
      expect(result.valid).toBe(true);
      expect(result.expandedPath).toBe(tempDir);
    });

    it("should reject directory without .git", async () => {
      const result = await validateProjectPath(tempDir);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Not a git repository");
    });

    it("should accept directory with .git", async () => {
      const gitDir = path.join(tempDir, ".git");
      // eslint-disable-next-line local/no-sync-fs-methods -- Test setup only
      fs.mkdirSync(gitDir);

      const result = await validateProjectPath(tempDir);
      expect(result.valid).toBe(true);
      expect(result.expandedPath).toBe(tempDir);
    });
  });
});
