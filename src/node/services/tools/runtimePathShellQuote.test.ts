import { describe, expect, it } from "bun:test";

import { quoteRuntimeProbePath } from "./runtimePathShellQuote";

describe("quoteRuntimeProbePath", () => {
  it("quotes absolute paths with shellQuote", () => {
    expect(quoteRuntimeProbePath("/home/user/workspace")).toBe("'/home/user/workspace'");
  });

  it("expands bare tilde to $HOME", () => {
    expect(quoteRuntimeProbePath("~")).toBe('"$HOME"');
  });

  it("expands tilde-slash prefix to $HOME + quoted remainder", () => {
    const result = quoteRuntimeProbePath("~/mux/project/main");
    expect(result).toBe('"$HOME"' + "'/mux/project/main'");
  });

  it("handles tilde path with special characters", () => {
    const result = quoteRuntimeProbePath("~/mux/my project/main");
    expect(result).toBe('"$HOME"' + "'/mux/my project/main'");
  });

  it("does not expand tilde in middle of path", () => {
    expect(quoteRuntimeProbePath("/home/~user/workspace")).toBe("'/home/~user/workspace'");
  });

  it("handles empty path", () => {
    expect(quoteRuntimeProbePath("")).toBe("''");
  });
});
