import { parseCommand } from "./parser";

describe("/idle command", () => {
  it("should return command-missing-args for /idle without arguments", () => {
    const result = parseCommand("/idle");
    expect(result).toEqual({
      type: "command-missing-args",
      command: "idle",
      usage: "/idle <hours> or /idle off",
    });
  });

  it("should parse /idle 24 as idle-compaction with 24 hours", () => {
    const result = parseCommand("/idle 24");
    expect(result).toEqual({
      type: "idle-compaction",
      hours: 24,
    });
  });

  it("should parse /idle off as null (disabled)", () => {
    const result = parseCommand("/idle off");
    expect(result).toEqual({
      type: "idle-compaction",
      hours: null,
    });
  });

  it("should parse /idle 0 as null (disabled)", () => {
    const result = parseCommand("/idle 0");
    expect(result).toEqual({
      type: "idle-compaction",
      hours: null,
    });
  });

  it("should return command-invalid-args for invalid number", () => {
    const result = parseCommand("/idle abc");
    expect(result).toEqual({
      type: "command-invalid-args",
      command: "idle",
      input: "abc",
      usage: "/idle <hours> or /idle off",
    });
  });

  it("should return command-invalid-args for negative number", () => {
    const result = parseCommand("/idle -5");
    expect(result).toEqual({
      type: "command-invalid-args",
      command: "idle",
      input: "-5",
      usage: "/idle <hours> or /idle off",
    });
  });
});
