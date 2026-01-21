import { describe, expect, it } from "bun:test";
import {
  formatDevcontainerUpError,
  parseDevcontainerStdoutLine,
  shouldCleanupDevcontainer,
} from "./devcontainerCli";

describe("parseDevcontainerStdoutLine", () => {
  it("parses JSON log lines with text", () => {
    const line = JSON.stringify({ type: "text", level: 3, text: "Building..." });
    expect(parseDevcontainerStdoutLine(line)).toEqual({
      kind: "log",
      text: "Building...",
    });
  });

  it("parses progress lines with name and status", () => {
    const line = JSON.stringify({
      type: "progress",
      name: "Running postCreateCommand...",
      status: "succeeded",
      channel: "postCreate",
    });
    expect(parseDevcontainerStdoutLine(line)).toEqual({
      kind: "log",
      text: "Running postCreateCommand...",
    });
  });

  it("parses error channel text below level 2", () => {
    const line = JSON.stringify({ type: "text", level: 1, text: "Oops", channel: "error" });
    expect(parseDevcontainerStdoutLine(line)).toEqual({
      kind: "log",
      text: "Oops",
    });
  });
  it("skips text lines below level 2", () => {
    const line = JSON.stringify({ type: "text", level: 1, text: "debug" });
    expect(parseDevcontainerStdoutLine(line)).toBeNull();
  });

  it("parses result lines", () => {
    const line = JSON.stringify({
      outcome: "success",
      containerId: "abc123",
      remoteUser: "node",
      remoteWorkspaceFolder: "/workspaces/demo",
    });
    const parsed = parseDevcontainerStdoutLine(line);
    expect(parsed?.kind).toBe("result");
    if (parsed?.kind === "result") {
      expect(parsed.result.containerId).toBe("abc123");
    }
  });

  it("falls back to raw lines for non-JSON output", () => {
    expect(parseDevcontainerStdoutLine("not json")).toEqual({
      kind: "raw",
      text: "not json",
    });
  });
});

describe("formatDevcontainerUpError", () => {
  it("prefers message and description", () => {
    expect(
      formatDevcontainerUpError({
        outcome: "error",
        message: "Command failed",
        description: "postCreateCommand failed",
      })
    ).toBe("devcontainer up failed: Command failed - postCreateCommand failed");
  });

  it("falls back to stderr summary", () => {
    expect(formatDevcontainerUpError({ outcome: "error" }, "stderr info")).toBe(
      "devcontainer up failed: stderr info"
    );
  });
});

describe("shouldCleanupDevcontainer", () => {
  it("returns true for error results with containerId", () => {
    expect(shouldCleanupDevcontainer({ outcome: "error", containerId: "abc" })).toBe(true);
  });

  it("returns false for error results without containerId", () => {
    expect(shouldCleanupDevcontainer({ outcome: "error" })).toBe(false);
  });

  it("returns false for success results", () => {
    expect(shouldCleanupDevcontainer({ outcome: "success", containerId: "abc" })).toBe(false);
  });
});
