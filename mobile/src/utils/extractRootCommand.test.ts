import { describe, expect, it } from "bun:test";
import { extractRootCommand } from "./slashCommandHelpers";

describe("extractRootCommand", () => {
  it("returns null for non-string input", () => {
    expect(extractRootCommand(null as unknown as string)).toBeNull();
    expect(extractRootCommand(undefined as unknown as string)).toBeNull();
    expect(extractRootCommand(123 as unknown as string)).toBeNull();
  });

  it("returns null for non-command string", () => {
    expect(extractRootCommand("hello world")).toBeNull();
    expect(extractRootCommand("  just some text")).toBeNull();
  });

  it("extracts root command from simple command", () => {
    expect(extractRootCommand("/help")).toBe("help");
    expect(extractRootCommand("/compact")).toBe("compact");
  });

  it("extracts root command from command with arguments", () => {
    expect(extractRootCommand("/model opus")).toBe("model");
    expect(extractRootCommand("/compact -t 1000")).toBe("compact");
  });

  it("handles leading whitespace", () => {
    expect(extractRootCommand("  /help")).toBe("help");
  });

  it("handles empty command", () => {
    expect(extractRootCommand("/")).toBeNull();
  });
});
