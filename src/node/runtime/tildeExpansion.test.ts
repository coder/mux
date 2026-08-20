import { describe, expect, it } from "bun:test";
import * as os from "os";
import * as path from "path";
import { getShuxHome } from "@/common/constants/paths";
import { expandTilde } from "./tildeExpansion";

function withExplicitRoot(vars: { SHUX_ROOT?: string; MUX_ROOT?: string }, run: () => void): void {
  const originalShuxRoot = process.env.SHUX_ROOT;
  const originalMuxRoot = process.env.MUX_ROOT;

  try {
    if (vars.SHUX_ROOT === undefined) {
      delete process.env.SHUX_ROOT;
    } else {
      process.env.SHUX_ROOT = vars.SHUX_ROOT;
    }

    if (vars.MUX_ROOT === undefined) {
      delete process.env.MUX_ROOT;
    } else {
      process.env.MUX_ROOT = vars.MUX_ROOT;
    }

    run();
  } finally {
    if (originalShuxRoot === undefined) delete process.env.SHUX_ROOT;
    else process.env.SHUX_ROOT = originalShuxRoot;
    if (originalMuxRoot === undefined) delete process.env.MUX_ROOT;
    else process.env.MUX_ROOT = originalMuxRoot;
  }
}

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

  it("expands canonical and legacy local homes through the active shux home", () => {
    const expected = path.join(getShuxHome(), "src", "project");
    expect(expandTilde("~/.shux/src/project")).toBe(expected);
    expect(expandTilde("~/.mux/src/project")).toBe(expected);
    expect(expandTilde("~/.cmux/src/project")).toBe(expected);
  });

  it("expands product-home aliases through SHUX_ROOT when set", () => {
    const testShuxRoot = path.join(os.tmpdir(), "shux-root-tilde-test");
    withExplicitRoot({ SHUX_ROOT: testShuxRoot }, () => {
      const expected = path.join(testShuxRoot, "src", "project");
      expect(expandTilde("~/.shux/src/project")).toBe(expected);
      expect(expandTilde("~/.mux/src/project")).toBe(expected);
      expect(expandTilde("~/.cmux/src/project")).toBe(expected);
      expect(expandTilde("~/.cmux")).toBe(testShuxRoot);
    });
  });

  it("accepts MUX_ROOT when SHUX_ROOT is not set", () => {
    const testLegacyRoot = path.join(os.tmpdir(), "mux-root-tilde-test");
    withExplicitRoot({ MUX_ROOT: testLegacyRoot }, () => {
      expect(expandTilde("~/.cmux/src/project")).toBe(path.join(testLegacyRoot, "src", "project"));
    });
  });
});
