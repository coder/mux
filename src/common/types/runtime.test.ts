import { describe, it, expect } from "@jest/globals";
import { parseRuntimeModeAndHost, buildRuntimeString } from "./runtime";

describe("parseRuntimeModeAndHost", () => {
  it("parses SSH mode with host", () => {
    expect(parseRuntimeModeAndHost("ssh user@host")).toEqual({
      mode: "ssh",
      host: "user@host",
    });
  });

  it("parses SSH mode without host", () => {
    expect(parseRuntimeModeAndHost("ssh")).toEqual({
      mode: "ssh",
      host: "",
    });
  });

  it("parses local mode", () => {
    expect(parseRuntimeModeAndHost("local")).toEqual({
      mode: "local",
      host: "",
    });
  });

  it("defaults to worktree for undefined", () => {
    expect(parseRuntimeModeAndHost(undefined)).toEqual({
      mode: "worktree",
      host: "",
    });
  });

  it("defaults to worktree for null", () => {
    expect(parseRuntimeModeAndHost(null)).toEqual({
      mode: "worktree",
      host: "",
    });
  });
});

describe("buildRuntimeString", () => {
  it("builds SSH string with host", () => {
    expect(buildRuntimeString("ssh", "user@host")).toBe("ssh user@host");
  });

  it("builds SSH string without host (persists SSH mode)", () => {
    expect(buildRuntimeString("ssh", "")).toBe("ssh");
  });

  it("returns 'local' for local mode", () => {
    expect(buildRuntimeString("local", "")).toBe("local");
  });

  it("returns undefined for worktree mode (default)", () => {
    expect(buildRuntimeString("worktree", "")).toBeUndefined();
  });

  it("trims whitespace from host", () => {
    expect(buildRuntimeString("ssh", "  user@host  ")).toBe("ssh user@host");
  });
});

describe("round-trip parsing and building", () => {
  it("preserves SSH mode without host", () => {
    const built = buildRuntimeString("ssh", "");
    const parsed = parseRuntimeModeAndHost(built);
    expect(parsed.mode).toBe("ssh");
    expect(parsed.host).toBe("");
  });

  it("preserves SSH mode with host", () => {
    const built = buildRuntimeString("ssh", "user@host");
    const parsed = parseRuntimeModeAndHost(built);
    expect(parsed.mode).toBe("ssh");
    expect(parsed.host).toBe("user@host");
  });
});
