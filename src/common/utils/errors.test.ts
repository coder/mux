import { describe, it, expect } from "bun:test";
import { getErrorMessage } from "./errors";

describe("getErrorMessage", () => {
  it("returns string representation of non-Error values", () => {
    expect(getErrorMessage("boom")).toBe("boom");
    expect(getErrorMessage(42)).toBe("42");
    expect(getErrorMessage(null)).toBe("null");
    expect(getErrorMessage(undefined)).toBe("undefined");
  });

  it("returns .message for a plain Error", () => {
    expect(getErrorMessage(new Error("something failed"))).toBe("something failed");
  });

  it("walks a single-level cause chain", () => {
    const inner = new Error("ENOENT: no such file");
    const outer = new Error("Failed to read file /foo:", { cause: inner });
    expect(getErrorMessage(outer)).toBe("Failed to read file /foo: [cause: ENOENT: no such file]");
  });

  it("walks a multi-level cause chain", () => {
    const root = new Error("connection reset");
    const mid = new Error("SSH read failed", { cause: root });
    const top = new Error("Failed to stat /remote/path:", { cause: mid });
    expect(getErrorMessage(top)).toBe(
      "Failed to stat /remote/path: [cause: SSH read failed] [cause: connection reset]"
    );
  });

  it("skips cause whose message is already in the parent", () => {
    // RuntimeError often embeds the inner message in its own message
    const inner = new Error("permission denied");
    const outer = new Error("Failed to read file: permission denied", { cause: inner });
    expect(getErrorMessage(outer)).toBe("Failed to read file: permission denied");
  });

  it("handles cause that is not an Error", () => {
    const err = new Error("wrapped", { cause: "string cause" });
    // Non-Error causes are not walked
    expect(getErrorMessage(err)).toBe("wrapped");
  });

  it("handles empty cause message", () => {
    const inner = new Error("");
    const outer = new Error("outer", { cause: inner });
    // Empty cause message is skipped
    expect(getErrorMessage(outer)).toBe("outer");
  });

  it("handles cyclic cause chain without hanging", () => {
    const a = new Error("error A");
    const b = new Error("error B", { cause: a });
    // Create a cycle: a -> b -> a -> ...
    a.cause = b;
    const result = getErrorMessage(b);
    expect(result).toContain("error B");
    expect(result).toContain("error A");
  });

  it("handles self-referencing cause", () => {
    const err = new Error("self");
    err.cause = err;
    expect(getErrorMessage(err)).toBe("self");
  });
});
