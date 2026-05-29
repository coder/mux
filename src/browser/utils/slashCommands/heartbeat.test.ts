import { parseCommand } from "./parser";

describe("/heartbeat command", () => {
  it("returns command-missing-args for /heartbeat without arguments", () => {
    const result = parseCommand("/heartbeat");
    expect(result).toEqual({
      type: "command-missing-args",
      command: "heartbeat",
      usage: "/heartbeat <minutes>|off",
    });
  });

  it("parses /heartbeat 30 as heartbeat-set with 30 minutes", () => {
    const result = parseCommand("/heartbeat 30");
    expect(result).toEqual({
      type: "heartbeat-set",
      minutes: 30,
    });
  });

  it("accepts the minimum heartbeat interval", () => {
    const result = parseCommand("/heartbeat 5");
    expect(result).toEqual({
      type: "heartbeat-set",
      minutes: 5,
    });
  });

  it("accepts the maximum heartbeat interval", () => {
    const result = parseCommand("/heartbeat 1440");
    expect(result).toEqual({
      type: "heartbeat-set",
      minutes: 1440,
    });
  });

  it("parses /heartbeat off as disabled", () => {
    const result = parseCommand("/heartbeat off");
    expect(result).toEqual({
      type: "heartbeat-set",
      minutes: null,
    });
  });

  it("parses /heartbeat disable as disabled", () => {
    const result = parseCommand("/heartbeat disable");
    expect(result).toEqual({
      type: "heartbeat-set",
      minutes: null,
    });
  });

  it("parses /heartbeat 0 as disabled", () => {
    const result = parseCommand("/heartbeat 0");
    expect(result).toEqual({
      type: "heartbeat-set",
      minutes: null,
    });
  });

  it("rejects values below the minimum interval", () => {
    const result = parseCommand("/heartbeat 2");
    expect(result).toEqual({
      type: "command-invalid-args",
      command: "heartbeat",
      input: "2",
      usage: "/heartbeat <minutes>|off",
    });
  });

  it("rejects values above the maximum interval", () => {
    const result = parseCommand("/heartbeat 1441");
    expect(result).toEqual({
      type: "command-invalid-args",
      command: "heartbeat",
      input: "1441",
      usage: "/heartbeat <minutes>|off",
    });
  });

  it("rejects non-numeric values", () => {
    const result = parseCommand("/heartbeat nope");
    expect(result).toEqual({
      type: "command-invalid-args",
      command: "heartbeat",
      input: "nope",
      usage: "/heartbeat <minutes>|off",
    });
  });

  it("rejects decimal values", () => {
    const result = parseCommand("/heartbeat 30.5");
    expect(result).toEqual({
      type: "command-invalid-args",
      command: "heartbeat",
      input: "30.5",
      usage: "/heartbeat <minutes>|off",
    });
  });

  it("rejects mixed alphanumeric tokens", () => {
    const result = parseCommand("/heartbeat 30abc");
    expect(result).toEqual({
      type: "command-invalid-args",
      command: "heartbeat",
      input: "30abc",
      usage: "/heartbeat <minutes>|off",
    });
  });
});
