import { describe, expect, it } from "bun:test";
import { buildShellExport } from "./shellEnv";

describe("buildShellExport", () => {
  it("quotes values for valid environment variable names", () => {
    expect(buildShellExport("MUX_VALUE", "hello world")).toBe("export MUX_VALUE='hello world'");
  });

  it("rejects invalid environment variable names before building shell", () => {
    expect(() => buildShellExport("BAD;echo pwn", "value")).toThrow(
      "Invalid shell environment variable name"
    );
  });
});
