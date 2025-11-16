import { describe, expect, it } from "bun:test";
import * as os from "os";
import * as path from "path";
import { expandTilde } from "./tildeExpansion";

describe("expandTilde", () => {
  it("should expand ~ to home directory", () => {
    const result = expandTilde("~");
    expect(result).toBe(os.homedir());
  });

  it("should expand ~/path to home directory + path", () => {
    const result = expandTilde("~/workspace");
    expect(result).toBe(path.join(os.homedir(), "workspace"));
  });

  it("should leave absolute paths unchanged", () => {
    const absolutePath = "/abs/path/to/dir";
    const result = expandTilde(absolutePath);
    expect(result).toBe(absolutePath);
  });

  it("should leave relative paths unchanged", () => {
    const relativePath = "relative/path";
    const result = expandTilde(relativePath);
    expect(result).toBe(relativePath);
  });

  it("should handle nested paths correctly", () => {
    const result = expandTilde("~/workspace/project/subdir");
    expect(result).toBe(path.join(os.homedir(), "workspace/project/subdir"));
  });
});
